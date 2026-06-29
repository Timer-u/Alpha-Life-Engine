"""GPU-accelerated Monte Carlo simulation (GBM paths)."""

import math

import numpy as np
import torch
from models import (
    CVaRResult,
    DrawdownAnalytics,
    GbmPathData,
    MarketDataInput,
    MonteCarloPercentiles,
    MonteCarloResult,
    MonteCarloSummary,
    PortfolioWeights,
)
from mpt import compute_covariance_matrix, compute_mean_returns


def _get_device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def cholesky_decomposition(matrix: torch.Tensor) -> torch.Tensor:
    try:
        return torch.linalg.cholesky(matrix)
    except RuntimeError:
        try:
            jittered = matrix + torch.eye(matrix.shape[0], device=matrix.device) * 1e-6
            return torch.linalg.cholesky(jittered)
        except RuntimeError:
            eigvals, eigvecs = torch.linalg.eigh(matrix)
            eigvals = torch.clamp(eigvals, min=1e-8)
            regularized = eigvecs @ torch.diag(eigvals) @ eigvecs.T
            regularized = (regularized + regularized.T) / 2
            return torch.linalg.cholesky(regularized)


def covariance_to_correlation(
    cov_matrix: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor]:
    std_devs = torch.sqrt(torch.clamp(torch.diag(cov_matrix), min=0.0))
    corr = cov_matrix / torch.outer(std_devs, std_devs).clamp(min=1e-12)
    corr = torch.clamp(corr, -1.0, 1.0)
    corr.fill_diagonal_(1.0)
    return corr, std_devs


def generate_correlated_gbm_paths(
    initial_prices: torch.Tensor,
    annualized_returns: torch.Tensor,
    annualized_volatilities: torch.Tensor,
    covariance_matrix: torch.Tensor,
    days: int,
    num_paths: int,
    device: torch.device,
    chunk_size: int = 2000,
) -> torch.Tensor:
    n_assets = len(initial_prices)
    dt = 1.0 / 252.0

    corr_matrix, _ = covariance_to_correlation(covariance_matrix)
    L = cholesky_decomposition(corr_matrix)

    drifts = (annualized_returns * dt - 0.5 * annualized_volatilities**2 * dt).view(
        1, 1, n_assets
    )
    vols_dt = (annualized_volatilities * math.sqrt(dt)).view(1, 1, n_assets)

    all_prices = []
    for chunk_start in range(0, num_paths, chunk_size):
        chunk_end = min(chunk_start + chunk_size, num_paths)
        chunk_paths = chunk_end - chunk_start

        z = torch.randn(
            chunk_paths, days, n_assets, device=device, dtype=initial_prices.dtype
        )
        correlated = z @ L.T

        log_returns = drifts + vols_dt * correlated
        cum_returns = torch.cumsum(log_returns, dim=1)

        chunk_prices = torch.zeros(chunk_paths, days + 1, n_assets, device=device)
        chunk_prices[:, 0, :] = initial_prices.view(1, 1, n_assets)
        chunk_prices[:, 1:, :] = initial_prices.view(1, 1, n_assets) * torch.exp(
            cum_returns
        )

        all_prices.append(chunk_prices)

    return torch.cat(all_prices, dim=0)


def generate_gbm_path(
    initial_price: float,
    annualized_return: float,
    annualized_volatility: float,
    days: int,
    device: torch.device,
) -> torch.Tensor:
    prices = generate_correlated_gbm_paths(
        initial_prices=torch.tensor([initial_price], device=device),
        annualized_returns=torch.tensor([annualized_return], device=device),
        annualized_volatilities=torch.tensor([annualized_volatility], device=device),
        covariance_matrix=torch.tensor([[1.0]], device=device),
        days=days,
        num_paths=1,
        device=device,
    )
    return prices[0, :, 0]


def compute_cvar(sorted_returns: torch.Tensor, n_paths: int, level: float) -> float:
    """Conditional VaR / Expected Shortfall at given level."""
    idx = int(n_paths * level)
    if idx < 1:
        return 0.0
    return float(sorted_returns[:idx].mean().item())


def _vectorized_max_consecutive(dd_below: torch.Tensor) -> torch.Tensor:
    """Vectorized max consecutive True values per row."""
    padded = torch.nn.functional.pad(dd_below, (1, 0), value=0)
    diff = padded[:, 1:] - padded[:, :-1]
    starts = (diff == 1).int()
    ends = (diff == -1).int()
    start_indices = torch.nonzero(starts)
    end_indices = torch.nonzero(ends)
    lengths = torch.zeros(dd_below.shape[0], device=dd_below.device, dtype=torch.int)
    for i in range(dd_below.shape[0]):
        row_starts = start_indices[start_indices[:, 0] == i, 1]
        row_ends = end_indices[end_indices[:, 0] == i, 1]
        if len(row_starts) > 0 and len(row_ends) > 0:
            min_len = min(len(row_starts), len(row_ends))
            seg_lengths = (row_ends[:min_len] - row_starts[:min_len]).int()
            if len(seg_lengths) > 0:
                lengths[i] = int(seg_lengths.max().item())
        if dd_below[i].all():
            lengths[i] = dd_below.shape[1]
    return lengths


def compute_drawdown_analytics(
    portfolio_values: torch.Tensor, n_paths: int
) -> DrawdownAnalytics:
    """Extended drawdown analytics: max DD, avg DD, duration, recovery, Ulcer, Calmar."""
    n = portfolio_values.shape[0]
    sample_n = min(n, 2000)

    vals_subset = portfolio_values[:sample_n]
    peaks, _ = torch.cummax(vals_subset, dim=1)
    dd = (vals_subset - peaks) / peaks.clamp(min=1e-12)

    dd_mins = dd.amin(dim=1)
    max_dds = dd_mins.tolist()

    dd_below = (dd < 0).int()
    durations = _vectorized_max_consecutive(dd_below).tolist()

    # Recovery time: for each path, find trough, then first point >= peak before trough
    recovery_times = []
    for i in range(sample_n):
        if dd_mins[i].item() >= 0:
            continue
        trough_idx = int(dd[i].argmin().item())
        peak_before_trough = float(peaks[i, : trough_idx + 1].max().item())
        vals_i = portfolio_values[i]
        recovered = torch.where(vals_i[trough_idx:] >= peak_before_trough)[0]
        if len(recovered) > 0:
            recovery_times.append(int(recovered[0].item()))
        else:
            recovery_times.append(252)

    dd_squared = dd**2
    ulcer_values = torch.sqrt(dd_squared.mean(dim=1)).tolist()

    max_dd = min(max_dds) if max_dds else 0.0
    avg_dd = float(np.mean(max_dds)) if max_dds else 0.0
    max_dd_dur = max(durations) if durations else 0
    avg_rec = int(np.median(recovery_times)) if recovery_times else 0

    final_values = portfolio_values[:, -1]
    starting_values = portfolio_values[:, 0]
    annualized_ret = float(
        (final_values / starting_values.clamp(min=1e-12)).mean().item()
    )
    annualized_ret = max(annualized_ret, 1e-10)
    calmar = annualized_ret / abs(max_dd) if max_dd != 0 else 0.0
    ulcer_idx = float(np.mean(ulcer_values)) if ulcer_values else 0.0

    return DrawdownAnalytics(
        max_drawdown=max_dd,
        avg_drawdown=avg_dd,
        max_dd_duration=max_dd_dur,
        recovery_time=avg_rec,
        ulcer_index=ulcer_idx,
        calmar_ratio=calmar,
    )


def compute_max_drawdown(prices: torch.Tensor) -> float:
    peak, _ = torch.cummax(prices, dim=0)
    drawdowns = (prices - peak) / peak
    return float(drawdowns.min().item())


def compute_portfolio_path_returns(
    paths: torch.Tensor,
    weights: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor]:
    portfolio_values = paths @ weights
    initial_value = portfolio_values[:, 0:1].clamp(min=1e-12)
    portfolio_returns = portfolio_values / initial_value - 1.0
    return portfolio_returns, portfolio_values


def compute_monte_carlo_summary(
    portfolio_returns: torch.Tensor,
    portfolio_values: torch.Tensor,
) -> tuple[MonteCarloSummary, CVaRResult, DrawdownAnalytics]:
    final_returns = portfolio_returns[:, -1]
    sorted_r, _ = torch.sort(final_returns)
    n = len(sorted_r)

    mean_return = float(sorted_r.mean().item())
    median_return = float(sorted_r[n // 2].item()) if n > 0 else 0.0
    std_return = float(sorted_r.std(correction=1).item()) if n > 1 else 0.0

    def q(p: float) -> float:
        idx = min(int(n * p), n - 1)
        return float(sorted_r[idx].item())

    var95 = q(0.05)
    var99 = q(0.01)

    dd_list = [compute_max_drawdown(portfolio_values[i]) for i in range(min(n, 1000))]
    max_dd = min(dd_list) if dd_list else 0.0

    cvar_95 = compute_cvar(sorted_r, n, 0.05)
    cvar_99 = compute_cvar(sorted_r, n, 0.01)
    cvar_995 = compute_cvar(sorted_r, n, 0.005)

    dd_analytics = compute_drawdown_analytics(portfolio_values, n)

    summary = MonteCarloSummary(
        mean_return=mean_return,
        median_return=median_return,
        std_return=std_return,
        var95=var95,
        var99=var99,
        max_drawdown=max_dd,
        percentiles=MonteCarloPercentiles(
            p1=q(0.01),
            p5=q(0.05),
            p10=q(0.10),
            p25=q(0.25),
            p50=median_return,
            p75=q(0.75),
            p90=q(0.90),
            p95=q(0.95),
            p99=q(0.99),
        ),
    )

    cvar = CVaRResult(
        cvar_95=cvar_95,
        cvar_99=cvar_99,
        cvar_995=cvar_995,
        es_95=cvar_95,
        es_99=cvar_99,
        es_995=cvar_995,
    )

    return summary, cvar, dd_analytics


def run_monte_carlo(
    data: MarketDataInput,
    symbols: list[str],
    weights: PortfolioWeights,
    initial_prices: list[float],
    days: int = 252,
    num_paths: int = 10000,
) -> tuple[MonteCarloResult, CVaRResult, DrawdownAnalytics]:
    device = _get_device()

    mean_returns = compute_mean_returns(data, symbols, device)
    cov_matrix = compute_covariance_matrix(data, symbols, device)

    annualized_returns = mean_returns * 252.0
    annualized_vols = torch.sqrt(torch.clamp(torch.diag(cov_matrix) * 252.0, min=0.0))

    weight_array = torch.tensor(
        [weights.weights.get(s, 0.0) for s in symbols],
        device=device,
    )
    init_prices_t = torch.tensor(initial_prices, device=device, dtype=torch.float32)

    raw_paths = generate_correlated_gbm_paths(
        init_prices_t,
        annualized_returns,
        annualized_vols,
        cov_matrix,
        days,
        num_paths,
        device,
        chunk_size=2000,
    )

    portfolio_returns, portfolio_values = compute_portfolio_path_returns(
        raw_paths, weight_array
    )

    summary, cvar, dd_analytics = compute_monte_carlo_summary(
        portfolio_returns, portfolio_values
    )

    num_time_steps = raw_paths.shape[1]
    max_display = min(num_paths, 1000)
    prices_t = []
    returns_t = []
    for t in range(num_time_steps):
        pv = portfolio_values[:max_display, t].cpu().tolist()
        pr = portfolio_returns[:max_display, t].cpu().tolist()
        prices_t.append(pv)
        returns_t.append(pr)

    start_date = __import__("datetime").datetime.now()
    dates = [
        (start_date + __import__("datetime").timedelta(days=t)).strftime("%Y-%m-%d")
        for t in range(num_time_steps)
    ]

    result = MonteCarloResult(
        paths=GbmPathData(dates=dates, prices=prices_t, returns=returns_t),
        summary=summary,
    )

    return result, cvar, dd_analytics
