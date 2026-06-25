"""GPU-accelerated Mean-Variance Optimization and Efficient Frontier."""

import math

import numpy as np
import torch

from cpcv import compute_cpcv_result
from dsr import annualize_return, annualize_volatility
from models import (
    CpcvFold,
    EfficientFrontier,
    EvolverConfig,
    FrontierPoint,
    MarketDataInput,
    PortfolioWeights,
    RegimeResult,
)
from regime import blended_covariance, detect_regimes

DEFAULT_RISK_FREE_RATE = 0.025


def _get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def compute_mean_returns(
    data: MarketDataInput,
    symbols: list[str],
    device: torch.device,
) -> torch.Tensor:
    n = min(
        (len(data.symbols[s].close) for s in symbols if s in data.symbols),
        default=0,
    )
    if n < 10:
        raise ValueError("No valid data or too few observations")

    means = []
    for sym in symbols:
        df = data.symbols.get(sym)
        if df is None:
            means.append(0.0)
        else:
            prices = np.array(df.close[-n:], dtype=np.float64)
            rets = prices[1:] / prices[:-1] - 1.0
            means.append(float(rets.mean()))
    return torch.tensor(means, device=device, dtype=torch.float32)


def compute_covariance_matrix(
    data: MarketDataInput,
    symbols: list[str],
    device: torch.device,
) -> torch.Tensor:
    n = min(
        (len(data.symbols[s].close) for s in symbols if s in data.symbols),
        default=0,
    )
    if n < 2:
        return torch.zeros(len(symbols), len(symbols), device=device)

    returns_list = []
    for sym in symbols:
        df = data.symbols.get(sym)
        if df is None:
            returns_list.append(torch.zeros(n - 1, device=device, dtype=torch.float32))
        else:
            prices = np.array(df.close[-n:], dtype=np.float64)
            rets = prices[1:] / prices[:-1] - 1.0
            returns_list.append(torch.from_numpy(rets).to(device=device, dtype=torch.float32))

    R = torch.stack(returns_list)
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


def compute_efficient_frontier(
    data: MarketDataInput,
    symbols: list[str],
    config: EvolverConfig | None = None,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
) -> EfficientFrontier:
    if config is None:
        from models import DEFAULT_EVOLVER_CONFIG
        config = DEFAULT_EVOLVER_CONFIG

    device = _get_device()
    num_points = config.frontier_points
    num_candidates = max(num_points * 20, 1000)

    mean_returns = compute_mean_returns(data, symbols, device)
    cov_matrix = compute_covariance_matrix(data, symbols, device)
    num_assets = len(symbols)

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
        points.append(FrontierPoint(
            weights=PortfolioWeights(weights=w_dict),
            expected_return=annualize_return(float(r_f[i].item()), 252),
            volatility=annualize_volatility(float(v_f[i].item()), 252),
            sharpe_ratio=float(s_f[i].item()) * math.sqrt(252),
        ))

    if not points:
        return EfficientFrontier()

    max_sharpe = max(points, key=lambda p: p.sharpe_ratio)
    min_vol = min(points, key=lambda p: p.volatility)

    return EfficientFrontier(points=points, max_sharpe_portfolio=max_sharpe, min_vol_portfolio=min_vol)


def compute_efficient_frontier_with_cpcv(
    data: MarketDataInput,
    symbols: list[str],
    folds: list[CpcvFold],
    config: EvolverConfig | None = None,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
    alpha: float = 0.05,
) -> EfficientFrontier:
    ef = compute_efficient_frontier(data, symbols, config, risk_free_rate)

    for point in ef.points:
        cpcv = compute_cpcv_result(
            data, symbols, point.weights.weights, folds, risk_free_rate, alpha
        )
        point.cpcv_result = cpcv
        point.sharpe_ratio = cpcv.dsr

    if ef.points:
        ef.max_sharpe_portfolio = max(ef.points, key=lambda p: p.sharpe_ratio)
        ef.min_vol_portfolio = min(ef.points, key=lambda p: p.volatility)

    return ef


def compute_regime_blended_frontier(
    data: MarketDataInput,
    symbols: list[str],
    folds: list[CpcvFold],
    config: EvolverConfig | None = None,
    risk_free_rate: float = DEFAULT_RISK_FREE_RATE,
    alpha: float = 0.05,
) -> tuple[EfficientFrontier, RegimeResult]:
    """用状态 blend 协方差替代样本协方差，重新计算有效前沿。

    使用当前市场状态的概率加权协方差矩阵（blended covariance），
    生成对未来市场环境更具鲁棒性的有效前沿。
    """
    device = _get_device()

    regime_result = detect_regimes(data, symbols)

    mean_returns = compute_mean_returns(data, symbols, device)
    sample_cov = compute_covariance_matrix(data, symbols, device)

    blended_cov = sample_cov
    if regime_result.regime_covariances and len(regime_result.regime_covariances) == 3:
        regime_cov_tensors = [torch.tensor(c, device=device, dtype=torch.float32) for c in regime_result.regime_covariances]
        blended_cov = blended_covariance(sample_cov, regime_result.regime_probs, regime_cov_tensors)

    num_points = config.frontier_points if config else 50
    num_candidates = max(num_points * 20, 1000)
    num_assets = len(symbols)

    raw_weights = generate_random_portfolios(num_assets, num_candidates, device)
    exp_returns, volatilities, sharpes = evaluate_portfolio(
        raw_weights, mean_returns, blended_cov, risk_free_rate,
    )

    w_f, r_f, v_f, s_f = extract_efficient_frontier(
        raw_weights, exp_returns, volatilities, sharpes, num_points,
    )

    points: list[FrontierPoint] = []
    for i in range(len(r_f)):
        w_dict = {symbols[j]: float(w_f[i, j].item()) for j in range(num_assets)}
        points.append(FrontierPoint(
            weights=PortfolioWeights(weights=w_dict),
            expected_return=annualize_return(float(r_f[i].item()), 252),
            volatility=annualize_volatility(float(v_f[i].item()), 252),
            sharpe_ratio=float(s_f[i].item()) * math.sqrt(252),
        ))

    for point in points:
        cpcv = compute_cpcv_result(
            data, symbols, point.weights.weights, folds, risk_free_rate, alpha,
        )
        point.cpcv_result = cpcv
        point.sharpe_ratio = cpcv.dsr

    ef = EfficientFrontier(points=points)
    if points:
        ef.max_sharpe_portfolio = max(points, key=lambda p: p.sharpe_ratio)
        ef.min_vol_portfolio = min(points, key=lambda p: p.volatility)

    return ef, regime_result
