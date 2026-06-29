"""Statistical functions: Sharpe ratio, skewness, kurtosis, DSR.

All functions operate on CPU (NumPy). The DSR formula uses excess kurtosis:

    denom^2 = 1 - gamma * SR + ((excessKurtosis + 2) / 4) * SR^2

where excessKurtosis = 0 for a normal distribution (raw kurtosis = 3).
"""

import math

import numpy as np

SQRT_2 = math.sqrt(2)


def _erf(x: float) -> float:
    a1 = 0.254829592
    a2 = -0.284496736
    a3 = 1.421413741
    a4 = -1.453152027
    a5 = 1.061405429
    p = 0.3275911

    sign = 1.0 if x >= 0 else -1.0
    x = abs(x)
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-x * x)
    return sign * y


def normal_cdf(x: float) -> float:
    return 0.5 * (1.0 + _erf(x / SQRT_2))


def normal_inv_cdf(p: float) -> float:
    if p <= 0.0:
        return -float("inf")
    if p >= 1.0:
        return float("inf")

    a = [
        -3.969683028665376e1,
        2.209460984245205e2,
        -2.759285104469687e2,
        1.383577518672690e2,
        -3.066479806614716e1,
        2.506628277459239,
    ]
    b = [
        -5.447609879822406e1,
        1.615858368580409e2,
        -1.556989798598866e2,
        6.680131188771972e1,
        -1.328068155288572e1,
    ]
    c = [
        -7.784894002430293e-3,
        -3.223964580411365e-1,
        -2.400758277161838,
        -2.549732539343734,
        4.374664141464968,
        2.938163982698783,
    ]
    d = [
        7.784695709041462e-3,
        3.224671290700398e-1,
        2.445134137142996,
        3.754408661907416,
    ]

    p_low = 0.02425
    p_high = 1.0 - p_low

    if p < p_low:
        q = math.sqrt(-2.0 * math.log(p))
        x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / (
            (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0
        )
    elif p <= p_high:
        q = p - 0.5
        r = q * q
        x = (
            (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5])
            * q
            / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0)
        )
    else:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        x = -(
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0)
        )

    return x


def compute_sharpe_ratio(returns: np.ndarray, risk_free_rate: float = 0.0) -> float:
    if len(returns) < 2:
        return 0.0
    mean = float(returns.mean())
    std = float(returns.std(ddof=1))
    if std == 0.0:
        return 0.0
    return (mean - risk_free_rate) / std


def compute_skewness(returns: np.ndarray) -> float:
    n = len(returns)
    if n < 3:
        return 0.0
    mean = float(returns.mean())
    std = float(returns.std(ddof=1))
    if std == 0.0:
        return 0.0
    m3 = float(((returns - mean) ** 3).mean())
    return m3 / (std**3)


def compute_kurtosis(returns: np.ndarray) -> float:
    n = len(returns)
    if n < 4:
        return 0.0
    mean = float(returns.mean())
    std = float(returns.std(ddof=1))
    if std == 0.0:
        return 0.0
    m4 = float(((returns - mean) ** 4).mean())
    return m4 / (std**4) - 3.0


def annualize_return(period_return: float, periods_per_year: int = 252) -> float:
    return (1.0 + period_return) ** periods_per_year - 1.0


def annualize_volatility(period_std: float, periods_per_year: int = 252) -> float:
    return period_std * math.sqrt(periods_per_year)


def compute_annualized_sharpe(
    daily_returns: np.ndarray, risk_free_rate: float = 0.0
) -> float:
    daily_sharpe = compute_sharpe_ratio(daily_returns, risk_free_rate / 252.0)
    return daily_sharpe * math.sqrt(252)


def compute_dsr(
    sharpe: float,
    n: int,
    skewness: float = 0.0,
    alpha: float = 0.05,
    excess_kurtosis: float = 0.0,
) -> float:
    if n < 2:
        return 0.0

    denom_sq = (
        1.0 - skewness * sharpe + ((excess_kurtosis + 2.0) / 4.0) * sharpe * sharpe
    )
    if denom_sq <= 0.0:
        return 0.0

    denominator = math.sqrt(denom_sq)
    numerator = sharpe * math.sqrt(n - 1) - normal_inv_cdf(1.0 - alpha)
    return normal_cdf(numerator / denominator)


def compute_haircut_sharpe(sr: float, n_trials: int) -> float:
    """Bailey-Lopez de Prado haircut Sharpe ratio.
    对多重测试偏差进行惩罚：Sharpe 越高、试验次数越多，惩罚越显著。
    """
    if n_trials <= 1:
        return sr
    gamma = 0.5772156649  # Euler-Mascheroni constant
    heuristic_var = 1.0 / (n_trials**0.5)  # 经验性惩罚项
    E_max = (1 - gamma) * normal_inv_cdf(1 - 1.0 / n_trials) + gamma * normal_inv_cdf(
        1 - 1.0 / n_trials * math.e ** (-1)
    )
    adjustment = E_max * heuristic_var
    return sr - adjustment


def compute_sortino_ratio(returns: np.ndarray, risk_free_rate: float = 0.0) -> float:
    """Sortino ratio：仅惩罚下行波动。"""
    if len(returns) < 2:
        return 0.0
    excess = returns - risk_free_rate
    mean_excess = float(excess.mean())
    downside = returns[returns < risk_free_rate]
    if len(downside) < 1:
        return 0.0
    downside_std = float(np.std(downside, ddof=1))
    if downside_std == 0.0:
        return 0.0
    return mean_excess / downside_std


def block_bootstrap(
    returns: np.ndarray,
    n_resamples: int = 1000,
    block_size: int = 5,
) -> np.ndarray:
    """Block bootstrap：保留时间序列短期自相关结构。"""
    n = len(returns)
    if n <= block_size:
        indices = np.random.randint(0, n, size=(n_resamples, n))
        return returns[indices]

    n_blocks = int(np.ceil(n / block_size))
    block_starts = np.arange(0, n, block_size)

    sampled_indices = []
    for _ in range(n_resamples):
        chosen_blocks = np.random.choice(block_starts, size=n_blocks, replace=True)
        idxs = np.concatenate([
            np.arange(start, min(start + block_size, n)) for start in chosen_blocks
        ])
        sampled_indices.append(idxs[:n])
    return np.array([returns[idx] for idx in sampled_indices])


def bootstrap_ci(
    returns: np.ndarray,
    n_resamples: int = 1000,
    block_size: int = 5,
    levels: list[float] | None = None,
    risk_free_rate: float = 0.0,
) -> dict:
    """Bootstrap 置信区间（Sharpe / Sortino / MaxDD）。
    返回各指标的 mean, std, ci_95, ci_99。
    """
    if levels is None:
        levels = [0.95, 0.99]

    boot = block_bootstrap(returns, n_resamples, block_size)

    sharpes = np.array([compute_sharpe_ratio(b, risk_free_rate) for b in boot])
    sortinos = np.array([compute_sortino_ratio(b, risk_free_rate) for b in boot])
    maxdds = np.array([
        float(np.min((np.maximum.accumulate(b) - b) / np.maximum.accumulate(b)))
        for b in boot
    ])

    def _ci(arr: np.ndarray, level: float) -> tuple[float, float]:
        lo = float(np.percentile(arr, (1 - level) / 2 * 100))
        hi = float(np.percentile(arr, (1 + level) / 2 * 100))
        return (lo, hi)

    def _build_bci(name: str, arr: np.ndarray) -> dict:
        return {
            "mean": float(arr.mean()),
            "std": float(arr.std(ddof=1)),
            "ci_95": list(_ci(arr, 0.95)),
            "ci_99": list(_ci(arr, 0.99)),
        }

    return {
        "sharpe": _build_bci("sharpe", sharpes),
        "sortino": _build_bci("sortino", sortinos),
        "max_drawdown": _build_bci("max_drawdown", maxdds),
    }
