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
from walk_forward import extract_prices_for_symbols

DEFAULT_RISK_FREE_RATE = 0.025


def _get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _aligned_returns_matrix(data: MarketDataInput, symbols: list[str]) -> np.ndarray:
    """日期对齐的逐标的日收益矩阵 (T-1, n)，列序与 symbols 一致。

    对齐规则与 walk_forward.extract_prices_for_symbols 相同（回测宇宙
    union-join、其余 inner-join），替代旧的 min(len) 尾部截断——停牌/缺日
    不再静默错位协方差。行 t 为主索引第 t+1 日的收益（len N-1 约定，与
    cpcv.compute_returns_from_prices / apply_fold_to_returns 一致，折段
    索引在同一日历上）；无数据的标的列为全 0；union-join 下晚上市标的
    上市前为 NaN。
    """
    columns: list[np.ndarray] = []
    valid = [s for s in symbols if s in data.symbols and data.symbols[s].close]
    if not valid:
        return np.zeros((0, len(symbols)))
    try:
        aligned = extract_prices_for_symbols(data, valid)
    except ValueError:
        return np.zeros((0, len(symbols)))
    by_symbol = dict(zip(valid, aligned, strict=True))
    master_len = aligned[0].shape[0] if aligned else 0
    for sym in symbols:
        prices = by_symbol.get(sym)
        if prices is None:
            columns.append(np.zeros(max(master_len - 1, 0)))
            continue
        rets = np.zeros(max(len(prices) - 1, 0))
        if len(prices) > 1:
            with np.errstate(divide="ignore", invalid="ignore"):
                rets[:] = prices[1:] / prices[:-1] - 1.0
        columns.append(rets)
    return np.column_stack(columns) if columns else np.zeros((0, len(symbols)))


def _resolve_segments(
    n: int,
    start: int,
    end: int | None,
    segments: list[tuple[int, int]] | None,
) -> list[tuple[int, int]]:
    if segments is None:
        # (start, end) 窗口：沿用旧的宽容截断（end 超界时夹到最后一根可用收益）
        if end is None:
            end = n - 1
        if start < 0 or start > end:
            msg = f"invalid window start={start}, end={end} for n={n}"
            raise ValueError(msg)
        return [(start, min(end, n - 1))]
    # 显式段列表（CPCV 折）：索引由内部生成，越界即 bug，严格报错
    for lo, hi in segments:
        if lo < 0 or hi >= n or hi < lo:
            msg = f"invalid segment ({lo}, {hi}) for n={n}"
            raise ValueError(msg)
    return segments


def _select_complete_rows(
    matrix: np.ndarray, segments: list[tuple[int, int]]
) -> np.ndarray:
    """按段选取并剔除含 NaN 的交易日（协方差/均值需同日完整截面）。"""
    parts = [matrix[lo : hi + 1] for lo, hi in segments if lo < matrix.shape[0]]
    block = np.concatenate(parts) if parts else np.zeros((0, matrix.shape[1]))
    return block[np.all(np.isfinite(block), axis=1)]


def compute_mean_returns(
    data: MarketDataInput,
    symbols: list[str],
    device: torch.device,
    start: int = 0,
    end: int | None = None,
    segments: list[tuple[int, int]] | None = None,
) -> torch.Tensor:
    matrix = _aligned_returns_matrix(data, symbols)
    n = matrix.shape[0]
    if n < 10:
        msg = "No valid data or too few observations"
        raise ValueError(msg)
    resolved = _resolve_segments(n, start, end, segments)

    complete = _select_complete_rows(matrix, resolved)
    if complete.shape[0] > 0:
        means = complete.mean(axis=0)
    else:
        means = np.zeros(matrix.shape[1])
    return torch.tensor(means, device=device, dtype=torch.float32)


def compute_covariance_matrix(
    data: MarketDataInput,
    symbols: list[str],
    device: torch.device,
    start: int = 0,
    end: int | None = None,
    segments: list[tuple[int, int]] | None = None,
) -> torch.Tensor:
    matrix = _aligned_returns_matrix(data, symbols)
    n = matrix.shape[0]
    if n < 10:
        msg = (
            f"insufficient observations for covariance: {n} aligned return rows, "
            "need >= 10"
        )
        raise ValueError(msg)
    resolved = _resolve_segments(n, start, end, segments)

    complete = _select_complete_rows(matrix, resolved)
    if complete.shape[0] < 2:
        # 数据不足显式报错：返回零矩阵会一路算出 0 波动/0 Sharpe 的垃圾值
        # （旧版仅 numpy RuntimeWarning "Degrees of freedom <= 0" 后照算）
        msg = (
            f"window {resolved} has only {complete.shape[0]} complete cross-section "
            "rows for covariance; need >= 2"
        )
        raise ValueError(msg)
    # complete: (T, n) 观测 × 标的；转成 (n, T) 后中心化求协方差
    R = torch.from_numpy(complete).to(device=device, dtype=torch.float32).T
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
    """Sample an efficient frontier from given mean/cov moments.

    Random portfolios are drawn from the simplex and filtered down to the
    Pareto-optimal frontier (``extract_efficient_frontier``); exact
    Markowitz optimization is intentionally avoided (CLT sampling keeps
    the frontier stable across window re-runs).
    """
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
    segments: list[tuple[int, int]] | None = None,
) -> EfficientFrontier:
    if config is None:
        from models import DEFAULT_EVOLVER_CONFIG

        config = DEFAULT_EVOLVER_CONFIG

    device = _get_device()
    mean_returns = compute_mean_returns(
        data, symbols, device, start, end, segments=segments
    )
    cov_matrix = compute_covariance_matrix(
        data, symbols, device, start, end, segments=segments
    )
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

    Each fold re-estimates its own frontier on that fold's TRAIN segments only
    (the union of purged/embargoed train groups — non-contiguous in CPCV, so
    test-group data can never leak into the moment estimates), so a fold's
    test window never leaks into its own weights. The max-sharpe weights are
    then evaluated on the SAME fold's test window — out of sample by
    construction. The per-fold OOS return series are concatenated into the
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
            segments=fold.train_segments,
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
        # risk_free_rate 是年化利率；逐日收益均值须减日频 rf（同 evaluate_portfolio
        # 的 rf/252 口径），否则日均值 2bp/波 40bp 的组合 Sharpe 被压到 −6 量级
        fold_sharpes.append(compute_sharpe_ratio(test_returns, risk_free_rate / 252.0))
        oos_parts.append(test_returns)

    if report_ef is None:
        return compute_efficient_frontier_on_window(
            data,
            symbols,
            config,
            risk_free_rate,
            segments=report_fold.train_segments,
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
