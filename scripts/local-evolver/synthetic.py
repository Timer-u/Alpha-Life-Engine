"""GPU-accelerated synthetic stress scenario generation.

生成资产价格压力路径，用于验证策略在极端市场条件下的鲁棒性。

场景类型:
  - fat_tails:          t-分布尾部肥厚 (df=3)
  - regime_shift:       均值/波动率突变
  - corr_breakdown:     相关性崩塌 (相关系数→1)
"""

import math
from typing import Optional

import numpy as np
import torch

from dsr import annualize_return, annualize_volatility, compute_sharpe_ratio, compute_sortino_ratio
from models import (
    MarketDataInput,
    MonteCarloSummary,
    MonteCarloPercentiles,
    SyntheticScenarioResult,
)
from monte_carlo import compute_max_drawdown


def _get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _compute_portfolio_returns(
    all_paths: torch.Tensor,
    weights: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor]:
    portfolio_values = all_paths @ weights
    initial_value = portfolio_values[:, 0:1].clamp(min=1e-12)
    portfolio_returns = portfolio_values / initial_value - 1.0
    return portfolio_returns, portfolio_values


def _summarize_scenario(
    portfolio_returns: torch.Tensor,
    portfolio_values: torch.Tensor,
    scenario: str,
    n_paths: int,
) -> SyntheticScenarioResult:
    final_returns = portfolio_returns[:, -1]
    sorted_r, _ = torch.sort(final_returns)
    n = len(sorted_r)

    def q(p: float) -> float:
        idx = min(int(n * p), n - 1)
        return float(sorted_r[idx].item())

    mean_ret = float(sorted_r.mean().item())
    cvar_idx_95 = int(n * 0.05)
    cvar_95 = float(sorted_r[:max(cvar_idx_95, 1)].mean().item()) if cvar_idx_95 > 0 else 0.0

    dd_list = [compute_max_drawdown(portfolio_values[i]) for i in range(min(n, 2000))]
    max_dd = min(dd_list) if dd_list else 0.0

    final_vals = portfolio_values[:, -1]
    sorted_vals = torch.sort(final_vals).values
    p5_val = float(sorted_vals[int(n * 0.05)].item()) if int(n * 0.05) < n else 0.0
    p95_val = float(sorted_vals[int(n * 0.95)].item()) if int(n * 0.95) < n else 0.0

    return SyntheticScenarioResult(
        scenario=scenario,
        n_paths=n_paths,
        mean_return=mean_ret,
        var_95=q(0.05),
        var_99=q(0.01),
        cvar_95=cvar_95,
        max_drawdown=max_dd,
        final_values_p5=p5_val,
        final_values_p95=p95_val,
    )


def generate_fat_tails(
    prices: torch.Tensor,
    mean_returns: torch.Tensor,
    cov_matrix: torch.Tensor,
    weights: torch.Tensor,
    days: int = 252,
    n_paths: int = 5000,
    df: float = 3.0,
    device: Optional[torch.device] = None,
) -> SyntheticScenarioResult:
    """t-分布尾部肥厚场景 (df=3)。
    用 t-dist 随机数替代正态随机数，生成肥尾路径。
    """
    if device is None:
        device = _get_device()

    n_assets = len(prices)
    dt = 1.0 / 252.0

    annualized_rets = mean_returns * 252.0
    annualized_vols = torch.sqrt(torch.clamp(torch.diag(cov_matrix) * 252.0, min=0.0))

    drifts = (annualized_rets * dt - 0.5 * annualized_vols ** 2 * dt).view(1, 1, n_assets)
    vols_dt = (annualized_vols * math.sqrt(dt)).view(1, 1, n_assets)

    z = torch.distributions.StudentT(df=df).sample((n_paths, days, n_assets)).to(device)
    z = z / math.sqrt(df / (df - 2))  # 标准化为单位方差
    z = z.clamp(-5, 5)  # 限制极端尾部，防止路径发散

    corr = cov_matrix / torch.outer(annualized_vols, annualized_vols).clamp(min=1e-12)
    corr = torch.clamp(corr, -1.0, 1.0)
    corr.fill_diagonal_(1.0)
    L = torch.linalg.cholesky(corr)
    correlated = z @ L.T

    log_returns = drifts + vols_dt * correlated
    cum_returns = torch.cumsum(log_returns, dim=1)

    all_paths = torch.zeros(n_paths, days + 1, n_assets, device=device)
    all_paths[:, 0, :] = prices.view(1, 1, n_assets)
    all_paths[:, 1:, :] = prices.view(1, 1, n_assets) * torch.exp(cum_returns)

    portfolio_returns, portfolio_values = _compute_portfolio_returns(all_paths, weights)
    return _summarize_scenario(portfolio_returns, portfolio_values, "fat_tails", n_paths)


def generate_regime_shift(
    prices: torch.Tensor,
    mean_returns: torch.Tensor,
    cov_matrix: torch.Tensor,
    weights: torch.Tensor,
    days: int = 252,
    n_paths: int = 5000,
    shift_day: int = 126,
    crash_mean_mult: float = -3.0,
    crash_vol_mult: float = 2.0,
    device: Optional[torch.device] = None,
) -> SyntheticScenarioResult:
    """均值/波动率突变场景。
    在 shift_day 天之后，收益率为 crash_mean_mult 倍（负），波动率 crash_vol_mult 倍。
    """
    if device is None:
        device = _get_device()

    n_assets = len(prices)
    dt = 1.0 / 252.0

    annualized_rets = mean_returns * 252.0
    annualized_vols = torch.sqrt(torch.clamp(torch.diag(cov_matrix) * 252.0, min=0.0))
    corr = cov_matrix / torch.outer(annualized_vols, annualized_vols).clamp(min=1e-12)
    corr = torch.clamp(corr, -1.0, 1.0)
    corr.fill_diagonal_(1.0)
    L = torch.linalg.cholesky(corr)
    vols_dt = (annualized_vols * math.sqrt(dt)).view(1, 1, n_assets)

    z_early = torch.randn(n_paths, shift_day, n_assets, device=device)
    z_late = torch.randn(n_paths, days - shift_day, n_assets, device=device)

    drift_early = (annualized_rets * dt - 0.5 * annualized_vols ** 2 * dt).view(1, 1, n_assets)
    drift_late = (annualized_rets * crash_mean_mult * dt - 0.5 * (annualized_vols * crash_vol_mult) ** 2 * dt).view(1, 1, n_assets)
    vols_late = (annualized_vols * crash_vol_mult * math.sqrt(dt)).view(1, 1, n_assets)

    log_rets_early = drift_early + vols_dt * (z_early @ L.T)
    log_rets_late = drift_late + vols_late * (z_late @ L.T)

    log_returns = torch.cat([log_rets_early, log_rets_late], dim=1)
    cum_returns = torch.cumsum(log_returns, dim=1)

    all_paths = torch.zeros(n_paths, days + 1, n_assets, device=device)
    all_paths[:, 0, :] = prices.view(1, 1, n_assets)
    all_paths[:, 1:, :] = prices.view(1, 1, n_assets) * torch.exp(cum_returns)

    portfolio_returns, portfolio_values = _compute_portfolio_returns(all_paths, weights)
    return _summarize_scenario(portfolio_returns, portfolio_values, "regime_shift", n_paths)


def generate_corr_breakdown(
    prices: torch.Tensor,
    mean_returns: torch.Tensor,
    cov_matrix: torch.Tensor,
    weights: torch.Tensor,
    days: int = 252,
    n_paths: int = 5000,
    breakdown_day: int = 126,
    device: Optional[torch.device] = None,
) -> SyntheticScenarioResult:
    """相关性崩塌场景。
    在 breakdown_day 天后，所有资产相关系数→1（危机模式）。
    """
    if device is None:
        device = _get_device()

    n_assets = len(prices)
    dt = 1.0 / 252.0

    annualized_rets = mean_returns * 252.0
    annualized_vols = torch.sqrt(torch.clamp(torch.diag(cov_matrix) * 252.0, min=0.0))

    drifts = (annualized_rets * dt - 0.5 * annualized_vols ** 2 * dt).view(1, 1, n_assets)
    vols_dt = (annualized_vols * math.sqrt(dt)).view(1, 1, n_assets)

    corr_early = cov_matrix / torch.outer(annualized_vols, annualized_vols).clamp(min=1e-12)
    corr_early = torch.clamp(corr_early, -1.0, 1.0)
    corr_early.fill_diagonal_(1.0)

    corr_breakdown = torch.ones(n_assets, n_assets, device=device)
    corr_breakdown = corr_breakdown + torch.eye(n_assets, device=device) * 1e-4  # jitter for PD

    L_early = torch.linalg.cholesky(corr_early)
    L_break = torch.linalg.cholesky(corr_breakdown)

    z_early = torch.randn(n_paths, breakdown_day, n_assets, device=device)
    z_late = torch.randn(n_paths, days - breakdown_day, n_assets, device=device)

    log_rets_early = drifts + vols_dt * (z_early @ L_early.T)
    log_rets_late = drifts + vols_dt * (z_late @ L_break.T)

    log_returns = torch.cat([log_rets_early, log_rets_late], dim=1)
    cum_returns = torch.cumsum(log_returns, dim=1)

    all_paths = torch.zeros(n_paths, days + 1, n_assets, device=device)
    all_paths[:, 0, :] = prices.view(1, 1, n_assets)
    all_paths[:, 1:, :] = prices.view(1, 1, n_assets) * torch.exp(cum_returns)

    portfolio_returns, portfolio_values = _compute_portfolio_returns(all_paths, weights)
    return _summarize_scenario(portfolio_returns, portfolio_values, "corr_breakdown", n_paths)


def run_all_scenarios(
    data: MarketDataInput,
    symbols: list[str],
    weights: dict[str, float],
    initial_prices: list[float],
    days: int = 252,
    n_paths: int = 5000,
    shift_day: int = 126,
    breakdown_day: int = 126,
) -> list[SyntheticScenarioResult]:
    """运行所有压力场景，返回汇总结果列表。"""
    from monte_carlo import compute_covariance_matrix, compute_mean_returns
    device = _get_device()

    mean_returns = compute_mean_returns(data, symbols, device)
    cov_matrix = compute_covariance_matrix(data, symbols, device)

    weight_array = torch.tensor(
        [weights.get(s, 0.0) for s in symbols],
        device=device,
    )
    init_prices_t = torch.tensor(initial_prices, device=device, dtype=torch.float32)

    results = []

    fat_tails = generate_fat_tails(
        init_prices_t, mean_returns, cov_matrix, weight_array, days, n_paths, df=3.0, device=device,
    )
    results.append(fat_tails)

    regime_shift = generate_regime_shift(
        init_prices_t, mean_returns, cov_matrix, weight_array, days, n_paths, shift_day, -3.0, 2.0, device=device,
    )
    results.append(regime_shift)

    corr_breakdown = generate_corr_breakdown(
        init_prices_t, mean_returns, cov_matrix, weight_array, days, n_paths, breakdown_day, device=device,
    )
    results.append(corr_breakdown)

    return results
