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
    # 分箱边界取自基准（expected）分布的分位数：并集分箱在 actual 整体
    # 偏移时会把几乎全部质量挤进单侧端箱，PSI 失真
    quantiles = np.percentile(expected, np.linspace(0, 100, n_bins + 1))
    # 大量并列值时 percentile 会给出重复边界，np.histogram 要求单调递增；
    # 退化到 <2 箱说明 expected 近乎常数，PSI 无定义，按 0 处理
    edges = np.unique(quantiles)
    if len(edges) < 3:
        return 0.0
    # 外侧边界放开到 ±inf：actual 落在 expected 历史范围之外的尾部必须计入
    bins = np.concatenate([[-np.inf], edges[1:-1], [np.inf]])

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
