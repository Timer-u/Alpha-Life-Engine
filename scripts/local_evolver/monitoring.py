"""Live vs backtest drift detection.

使用两种方法检测实盘收益率分布是否发生显著漂移：

  1. PSI (Population Stability Index) — 衡量分布偏移幅度
     PSI > 0.25 表示显著漂移

  2. KS-test — 检验两样本是否来自同一分布
     p < 0.05 拒绝同分布假设

实盘窗口：滚动 12 个月（252 交易日）
对比基准：完整回测收益率分布
"""

import numpy as np
from models import DriftResult
from scipy import stats


def compute_psi(
    expected: np.ndarray,
    actual: np.ndarray,
    n_bins: int = 10,
    epsilon: float = 1e-6,
) -> float:
    """Population Stability Index.

    PSI = Σ (actual_i - expected_i) * ln(actual_i / expected_i)

    Args:
        expected: 基准分布（回测收益率）
        actual: 实际分布（实盘收益率）
        n_bins: 分箱数
        epsilon: 平滑避免除零

    Returns:
        PSI 值
    """
    all_vals = np.concatenate([expected, actual])
    bins = np.percentile(all_vals, np.linspace(0, 100, n_bins + 1))

    expected_counts, _ = np.histogram(expected, bins=bins)
    actual_counts, _ = np.histogram(actual, bins=bins)

    expected_pct = expected_counts / max(len(expected), 1) + epsilon
    actual_pct = actual_counts / max(len(actual), 1) + epsilon

    expected_pct = expected_pct / expected_pct.sum()
    actual_pct = actual_pct / actual_pct.sum()

    psi = np.sum((actual_pct - expected_pct) * np.log(actual_pct / expected_pct))
    return float(psi)


def detect_drift(
    backtest_returns: np.ndarray,
    live_returns: np.ndarray,
    window_start: str = "",
    window_end: str = "",
    psi_threshold: float = 0.25,
    ks_threshold: float = 0.05,
) -> DriftResult:
    """检测实盘 vs 回测的分布漂移。

    Args:
        backtest_returns: 回测期收益率序列（全部）
        live_returns: 实盘窗口收益率序列（近 12 个月）
        window_start: 实盘窗口起始日期（字符串）
        window_end: 实盘窗口截止日期（字符串）
        psi_threshold: PSI 告警阈值（默认 0.25）
        ks_threshold: KS-test p值阈值（默认 0.05）

    Returns:
        DriftResult
    """
    if len(live_returns) < 5 or len(backtest_returns) < 5:
        return DriftResult(
            alert=False, window_start=window_start, window_end=window_end
        )

    psi = compute_psi(backtest_returns, live_returns)

    ks_stat, ks_p = stats.ks_2samp(backtest_returns, live_returns)

    alert = psi > psi_threshold or ks_p < ks_threshold

    return DriftResult(
        psi=float(psi),
        ks_statistic=float(ks_stat),
        ks_p_value=float(ks_p),
        alert=bool(alert),
        window_start=window_start,
        window_end=window_end,
    )
