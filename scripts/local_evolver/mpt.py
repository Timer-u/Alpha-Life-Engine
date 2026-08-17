"""GPU-accelerated Mean-Variance Optimization and Efficient Frontier."""

import math

import numpy as np
import torch
from cpcv import apply_fold_to_returns, compute_portfolio_returns
from dsr import (
    annualize_return,
    annualize_volatility,
    compute_dsr,
    compute_kurtosis,
    compute_sharpe_ratio,
    compute_skewness,
)
from models import (
    CpcvFold,
    CpcvResult,
    EfficientFrontier,
    EvolverConfig,
    FrontierPoint,
    MarketDataInput,
    PortfolioWeights,
    SharpeDistribution,
    SharpePercentiles,
)

DEFAULT_RISK_FREE_RATE = 0.025


def _get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def compute_mean_returns(
    data: MarketDataInput,
    symbols: list[str],
    device: torch.device,
    start: int = 0,
    end: int | None = None,
) -> torch.Tensor:
    n = min(
        (len(data.symbols[s].close) for s in symbols if s in data.symbols),
        default=0,
    )
    if n < 10:
        msg = "No valid data or too few observations"
        raise ValueError(msg)
    if end is None:
        end = n - 1
    if start < 0 or end >= n or start > end:
        msg = f"invalid window start={start}, end={end} for n={n}"
        raise ValueError(msg)

    means = []
    for sym in symbols:
        df = data.symbols.get(sym)
        if df is None:
            means.append(0.0)
        else:
            prices = np.array(df.close[-n:], dtype=np.float64)
            rets = prices[1:] / prices[:-1] - 1.0
            lo = max(start, 1)
            hi = min(end + 1, len(rets))
            seg = rets[lo:hi]
            means.append(float(seg.mean()) if len(seg) > 0 else 0.0)
    return torch.tensor(means, device=device, dtype=torch.float32)


def compute_covariance_matrix(
    data: MarketDataInput,
    symbols: list[str],
    device: torch.device,
    start: int = 0,
    end: int | None = None,
) -> torch.Tensor:
    n = min(
        (len(data.symbols[s].close) for s in symbols if s in data.symbols),
        default=0,
    )
    if n < 2:
        return torch.zeros(len(symbols), len(symbols), device=device)
    if end is None:
        end = n - 1
    if start < 0 or end >= n or start > end:
        msg = f"invalid window start={start}, end={end} for n={n}"
        raise ValueError(msg)

    returns_list = []
    for sym in symbols:
        df = data.symbols.get(sym)
        if df is None:
            returns_list.append(torch.zeros(n - 1, device=device, dtype=torch.float32))
        else:
            prices = np.array(df.close[-n:], dtype=np.float64)
            rets = prices[1:] / prices[:-1] - 1.0
            returns_list.append(
                torch.from_numpy(rets).to(device=device, dtype=torch.float32)
            )

    R = torch.stack(returns_list)
    lo = max(start, 1)
    hi = min(end + 1, R.shape[1])
    R = R[:, lo:hi]
    if R.shape[1] < 2:
        return torch.zeros(len(symbols), len(symbols), device=device)
    mean_centered = R - R.mean(dim=1, keepdim=True)
    cov = (mean_centered @ mean_centered.T) / (R.shape[1] - 1)
    return cov


def generate_random_portfolios(
    num_assets: int,
    count: int,
    device: torch.device,
    alpha: float = 1.0,
) -> torch.Tensor:
    exp_samples = torch.empty(count, num_assets, device=device).exponential_(alpha)
    totals = exp_samples.sum(dim=1, keepdim=True)
    return exp_samples / totals


def evaluate_portfolio(
    weights: torch.Tensor,
    mean_returns: torch.Tensor,
    cov_matrix: torch.Tensor,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    exp_return = weights @ mean_returns
    if weights.dim() == 1:
        variance = weights @ (cov_matrix @ weights)
    else:
        variance = torch.sum((weights @ cov_matrix) * weights, dim=1)
    volatility = torch.sqrt(torch.clamp(variance, min=0.0))
    excess = exp_return - risk_free_rate / 252.0
    sharpe = torch.where(volatility > 0, excess / volatility, torch.zeros_like(excess))
    return exp_return, volatility, sharpe


def extract_efficient_frontier(
    weights: torch.Tensor,
    exp_returns: torch.Tensor,
    volatilities: torch.Tensor,
    sharpes: torch.Tensor,
    num_points: int = 50,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    sorted_idx = torch.argsort(volatilities)
    w_sorted = weights[sorted_idx]
    r_sorted = exp_returns[sorted_idx]
    v_sorted = volatilities[sorted_idx]
    s_sorted = sharpes[sorted_idx]

    frontier_mask = torch.ones(len(r_sorted), dtype=torch.bool, device=weights.device)
    current_max = -float("inf")
    for i in range(len(r_sorted)):
        if r_sorted[i].item() <= current_max:
            frontier_mask[i] = False
        else:
            current_max = r_sorted[i].item()

    w_front = w_sorted[frontier_mask]
    r_front = r_sorted[frontier_mask]
    v_front = v_sorted[frontier_mask]
    s_front = s_sorted[frontier_mask]

    if len(r_front) <= 2:
        return w_front, r_front, v_front, s_front

    min_v = v_front[0].item()
    max_v = v_front[-1].item()
    step = (max_v - min_v) / (num_points - 1) if num_points > 1 else 0.0

    if step == 0.0:
        return w_front[:1], r_front[:1], v_front[:1], s_front[:1]

    sampled_w: list[torch.Tensor] = []
    sampled_r: list[float] = []
    sampled_v: list[float] = []
    sampled_s: list[float] = []

    for i in range(num_points):
        target = min_v + step * i
        diffs = (v_front - target).abs()
        idx = int(diffs.argmin().item())
        v_val = v_front[idx].item()
        if not sampled_v or abs(v_val - sampled_v[-1]) > 1e-12:
            sampled_w.append(w_front[idx])
            sampled_r.append(r_front[idx].item())
            sampled_v.append(v_val)
            sampled_s.append(s_front[idx].item())

    if not sampled_w:
        return w_front[:1], r_front[:1], v_front[:1], s_front[:1]

    return (
        torch.stack(sampled_w),
        torch.tensor(sampled_r, device=weights.device),
        torch.tensor(sampled_v, device=weights.device),
        torch.tensor(sampled_s, device=weights.device),
    )


def _frontier_from_moments(
    mean_returns: torch.Tensor,
    cov_matrix: torch.Tensor,
    symbols: list[str],
    num_points: int,
    risk_free_rate: float,
    device: torch.device,
) -> EfficientFrontier:
    num_assets = len(symbols)
    num_candidates = max(num_points * 20, 1000)

    raw_weights = generate_random_portfolios(num_assets, num_candidates, device)
    exp_returns, volatilities, sharpes = evaluate_portfolio(
        raw_weights, mean_returns, cov_matrix, risk_free_rate
    )

    w_f, r_f, v_f, s_f = extract_efficient_frontier(
        raw_weights, exp_returns, volatilities, sharpes, num_points
    )

    points: list[FrontierPoint] = []
    for i in range(len(r_f)):
        w_dict = {symbols[j]: float(w_f[i, j].item()) for j in range(num_assets)}
        points.append(
            FrontierPoint(
                weights=PortfolioWeights(weights=w_dict),
                expected_return=annualize_return(float(r_f[i].item()), 252),
                volatility=annualize_volatility(float(v_f[i].item()), 252),
                sharpe_ratio=float(s_f[i].item()) * math.sqrt(252),
            )
        )

    if not points:
        return EfficientFrontier()

    max_sharpe = max(points, key=lambda p: p.sharpe_ratio)
    min_vol = min(points, key=lambda p: p.volatility)

    return EfficientFrontier(
        points=points, max_sharpe_portfolio=max_sharpe, min_vol_portfolio=min_vol
    )


def compute_efficient_frontier(
    data: MarketDataInput,
    symbols: list[str],
    config: EvolverConfig | None = None,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
) -> EfficientFrontier:
    return compute_efficient_frontier_on_window(
        data, symbols, config, risk_free_rate, start=0, end=None
    )


def compute_efficient_frontier_on_window(
    data: MarketDataInput,
    symbols: list[str],
    config: EvolverConfig | None = None,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
    start: int = 0,
    end: int | None = None,
) -> EfficientFrontier:
    if config is None:
        from models import DEFAULT_EVOLVER_CONFIG

        config = DEFAULT_EVOLVER_CONFIG

    device = _get_device()
    mean_returns = compute_mean_returns(data, symbols, device, start, end)
    cov_matrix = compute_covariance_matrix(data, symbols, device, start, end)
    return _frontier_from_moments(
        mean_returns,
        cov_matrix,
        symbols,
        config.frontier_points,
        risk_free_rate,
        device,
    )


def _aggregate_cpcv(
    folds: list[CpcvFold],
    fold_sharpes: list[float],
    oos_returns: np.ndarray,
    alpha: float,
) -> CpcvResult:
    """Aggregate per-fold OOS results into a CpcvResult (mirrors cpcv.py)."""
    mean_sr = float(np.mean(fold_sharpes))
    std_sr = float(np.std(fold_sharpes, ddof=1)) if len(fold_sharpes) > 1 else 0.0

    dist_skewness = compute_skewness(np.array(fold_sharpes))

    sorted_sr = sorted(fold_sharpes)

    def percentile(p: float) -> float:
        idx = int(len(sorted_sr) * p)
        return sorted_sr[max(0, min(idx, len(sorted_sr) - 1))]

    ret_skewness = compute_skewness(oos_returns)
    ret_kurtosis = compute_kurtosis(oos_returns)
    dsr = compute_dsr(mean_sr, len(oos_returns), ret_skewness, alpha, ret_kurtosis)

    return CpcvResult(
        folds=folds,
        fold_sharpe_ratios=fold_sharpes,
        sharpe_distribution=SharpeDistribution(
            mean=mean_sr,
            std=std_sr,
            skewness=dist_skewness,
            percentiles=SharpePercentiles(
                p5=percentile(0.05),
                p25=percentile(0.25),
                p50=percentile(0.50),
                p75=percentile(0.75),
                p95=percentile(0.95),
            ),
        ),
        dsr=dsr,
    )


def compute_efficient_frontier_with_cpcv(
    data: MarketDataInput,
    symbols: list[str],
    folds: list[CpcvFold],
    config: EvolverConfig | None = None,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
    alpha: float = 0.05,
) -> EfficientFrontier:
    """Per-fold CPCV frontiers with out-of-sample evaluation.

    Each fold re-estimates its own frontier on that fold's TRAIN window only
    (inclusive convention ``returns[train_start : train_end + 1]``), so a
    fold's test window never leaks into its own weights. The max-sharpe
    weights are then evaluated on the SAME fold's test window — out of sample
    by construction. The per-fold OOS return series are concatenated into the
    reported DSR/Sharpe distribution.

    The REPORTED frontier is the latest fold's (max test_end) estimation —
    the report consumes its weights, and ``max_sharpe_portfolio.cpcv_result``
    carries the aggregated per-fold OOS statistics.
    """
    if config is None:
        from models import DEFAULT_EVOLVER_CONFIG

        config = DEFAULT_EVOLVER_CONFIG

    if not folds:
        return compute_efficient_frontier_on_window(
            data, symbols, config, risk_free_rate
        )

    report_fold = max(folds, key=lambda f: f.test_end)

    fold_sharpes: list[float] = []
    oos_parts: list[np.ndarray] = []
    report_ef: EfficientFrontier | None = None

    for fold in folds:
        ef = compute_efficient_frontier_on_window(
            data,
            symbols,
            config,
            risk_free_rate,
            start=fold.train_start,
            end=fold.train_end,
        )
        if not ef.max_sharpe_portfolio:
            continue
        if fold == report_fold:
            report_ef = ef

        weights = ef.max_sharpe_portfolio.weights.weights
        all_returns = compute_portfolio_returns(data, symbols, weights)
        _, test_returns = apply_fold_to_returns(all_returns, fold)
        if len(test_returns) < 2:
            continue
        fold_sharpes.append(compute_sharpe_ratio(test_returns, risk_free_rate))
        oos_parts.append(test_returns)

    if report_ef is None:
        return compute_efficient_frontier_on_window(
            data,
            symbols,
            config,
            risk_free_rate,
            start=report_fold.train_start,
            end=report_fold.train_end,
        )
    if report_ef.max_sharpe_portfolio is None:
        return report_ef
    if not oos_parts:
        report_ef.max_sharpe_portfolio.cpcv_result = CpcvResult(folds=folds)
        report_ef.max_sharpe_portfolio.sharpe_ratio = 0.0
        return report_ef

    oos_returns = np.concatenate(oos_parts)
    cpcv = _aggregate_cpcv(folds, fold_sharpes, oos_returns, alpha)
    report_ef.max_sharpe_portfolio.cpcv_result = cpcv
    report_ef.max_sharpe_portfolio.sharpe_ratio = cpcv.dsr
    report_ef.min_vol_portfolio = min(report_ef.points, key=lambda p: p.volatility)
    return report_ef
