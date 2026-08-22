"""CPCV (Combinatorial Purged Cross-Validation) implementation."""

import random
from itertools import combinations

import numpy as np
from dsr import compute_dsr, compute_kurtosis, compute_sharpe_ratio, compute_skewness
from models import (
    CpcvFold,
    CpcvResult,
    MarketDataInput,
    SharpeDistribution,
    SharpePercentiles,
)

type Segments = tuple[tuple[int, int], ...]


def _sample_combinations(
    n: int, k: int, max_samples: int, random_state: int = 42
) -> list[list[int]]:
    all_combs = list(combinations(range(n), k))
    if len(all_combs) <= max_samples:
        return [list(c) for c in all_combs]
    sampled: list[list[int]] = []
    indices = set()
    rng = random.Random(random_state)
    while len(sampled) < max_samples:
        idx = rng.randrange(len(all_combs))
        if idx not in indices:
            indices.add(idx)
            sampled.append(list(all_combs[idx]))
    return sampled


def _merge_test_segments(
    sorted_groups: list[int], group_size: int
) -> list[tuple[int, int]]:
    """相邻测试组并入同一段，保留组间非连续性。"""
    segments: list[tuple[int, int]] = []
    run_start = sorted_groups[0]
    prev = sorted_groups[0]
    for g in sorted_groups[1:]:
        if g == prev + 1:
            prev = g
            continue
        segments.append((run_start * group_size, (prev + 1) * group_size - 1))
        run_start = g
        prev = g
    segments.append((run_start * group_size, (prev + 1) * group_size - 1))
    return segments


def _purged_train_segments(
    num_groups: int,
    test_set: set[int],
    group_size: int,
    purge_days: int,
    embargo_days: int,
) -> list[tuple[int, int]]:
    """train：非测试组的连续游程，紧邻测试组一侧裁掉 purge/embargo。"""
    segments: list[tuple[int, int]] = []
    for g in range(num_groups):
        if g in test_set:
            continue
        seg_start = g * group_size
        seg_end = (g + 1) * group_size - 1
        if (g - 1) in test_set:
            seg_start += embargo_days
        if (g + 1) in test_set:
            seg_end -= purge_days
        if seg_start <= seg_end:
            segments.append((seg_start, seg_end))
    return segments


def generate_cpcv_folds(
    total_obs: int,
    num_groups: int = 10,
    num_test_groups: int = 2,
    num_splits: int = 10,
    purge_days: int = 5,
    embargo_days: int = 5,
) -> list[CpcvFold]:
    """生成 CPCV 折叠。

    test = 所选组的并集（保留非连续性，不折叠成 min/max 连续区间）；
    train = 其余组在每个测试组两侧做 purge（测试组前的 train 尾部）
    与 embargo（测试组后的 train 头部）。
    """
    group_size = total_obs // num_groups
    if group_size < 1:
        msg = f"total_obs ({total_obs}) too small for {num_groups} groups"
        raise ValueError(msg)

    combs = _sample_combinations(
        num_groups, num_test_groups, num_splits, random_state=42
    )
    folds: list[CpcvFold] = []
    seen: set[tuple[Segments, Segments]] = set()

    for test_group_indices in combs:
        test_set = set(test_group_indices)
        test_segments = _merge_test_segments(sorted(test_set), group_size)
        train_segments = _purged_train_segments(
            num_groups, test_set, group_size, purge_days, embargo_days
        )

        key = (tuple(train_segments), tuple(test_segments))
        if key in seen:
            continue
        seen.add(key)

        fold = CpcvFold(train_segments=train_segments, test_segments=test_segments)
        if fold.train_length() > 0 and fold.test_length() >= 5:
            folds.append(fold)

    if not folds:
        msg = (
            f"CPCV folds collapsed to 0 for total_obs={total_obs}, "
            f"num_groups={num_groups}, num_test_groups={num_test_groups}, "
            f"purge={purge_days}, embargo={embargo_days}"
        )
        raise ValueError(msg)

    return folds


def compute_returns_from_prices(prices: list[float]) -> np.ndarray:
    arr = np.array(prices, dtype=np.float64)
    if len(arr) < 2:
        return np.array([])
    if not np.all(np.isfinite(arr)) or np.any(arr <= 0):
        return np.array([])
    with np.errstate(divide="ignore", invalid="ignore"):
        returns = arr[1:] / arr[:-1] - 1.0
    if not np.all(np.isfinite(returns)):
        return np.array([])
    return returns


def compute_portfolio_returns(
    data: MarketDataInput,
    symbols: list[str],
    weights: dict[str, float],
) -> np.ndarray:
    valid_symbols = [s for s in symbols if s in data.symbols and data.symbols[s].close]
    if not valid_symbols:
        return np.array([])

    n = min(len(data.symbols[s].close) for s in valid_symbols)
    if n < 10:
        return np.array([])

    weighted_prices = np.zeros(n)
    for sym in valid_symbols:
        df = data.symbols[sym]
        w = weights.get(sym, 0.0)
        weighted_prices += np.array(df.close[-n:]) * w

    return compute_returns_from_prices(weighted_prices.tolist())


def apply_fold_to_returns(
    returns: np.ndarray,
    fold: CpcvFold,
) -> tuple[np.ndarray, np.ndarray]:
    """按段拼接 train/test 切片（test 为非连续组并集时顺序保留）。"""

    def _concat(segments: list[tuple[int, int]]) -> np.ndarray:
        parts = [returns[lo : hi + 1] for lo, hi in segments]
        return np.concatenate(parts) if parts else np.array([])

    return _concat(fold.train_segments), _concat(fold.test_segments)


def generate_nested_cpcv_folds(
    total_obs: int,
    outer_groups: int = 10,
    inner_groups: int = 6,
    test_groups: int = 2,
    purge_days: int = 5,
    embargo_days: int = 5,
) -> tuple[list[CpcvFold], dict[int, list[CpcvFold]]]:
    """生成嵌套 CPCV 折叠。

    外部折：用于估计泛化性能
    内部折（每外折一个）：用于参数选择

    Returns:
        (outer_folds, inner_folds_map)
        inner_folds_map[i] = 针对第 i 个外折训练集的内部折叠列表
    """
    outer_folds = generate_cpcv_folds(
        total_obs, outer_groups, test_groups, outer_groups, purge_days, embargo_days
    )

    inner_folds_map: dict[int, list[CpcvFold]] = {}
    for i, outer in enumerate(outer_folds):
        train_len = outer.train_end - outer.train_start + 1
        if train_len > inner_groups * 10:
            inner = generate_cpcv_folds(
                train_len,
                inner_groups,
                test_groups,
                inner_groups,
                purge_days,
                embargo_days,
            )
            inner_folds_map[i] = inner
        else:
            inner_folds_map[i] = []

    return outer_folds, inner_folds_map


def compute_cpcv_result(
    data: MarketDataInput,
    symbols: list[str],
    weights: dict[str, float],
    folds: list[CpcvFold],
    risk_free_rate: float = 0.0,
    alpha: float = 0.05,
) -> CpcvResult:
    all_returns = compute_portfolio_returns(data, symbols, weights)
    n = len(all_returns)

    fold_sharpes: list[float] = []
    for fold in folds:
        _, test_returns = apply_fold_to_returns(all_returns, fold)
        if len(test_returns) < 2:
            continue
        sr = compute_sharpe_ratio(test_returns, risk_free_rate)
        fold_sharpes.append(sr)

    if not fold_sharpes:
        return CpcvResult(dsr=0.0)

    mean_sr = float(np.mean(fold_sharpes))
    std_sr = float(np.std(fold_sharpes, ddof=1))

    dist_skewness = compute_skewness(np.array(fold_sharpes))

    sorted_sr = sorted(fold_sharpes)

    def percentile(p: float) -> float:
        idx = int(len(sorted_sr) * p)
        return sorted_sr[max(0, min(idx, len(sorted_sr) - 1))]

    ret_skewness = compute_skewness(all_returns)
    ret_kurtosis = compute_kurtosis(all_returns)
    dsr = compute_dsr(mean_sr, n, ret_skewness, alpha, ret_kurtosis)

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


def run_nested_cpcv(
    data: MarketDataInput,
    symbols: list[str],
    weights: dict[str, float],
    outer_folds: list[CpcvFold],
    inner_folds_map: dict[int, list[CpcvFold]],
    risk_free_rate: float = 0.0,
    alpha: float = 0.05,
) -> tuple[list[float], list[float]]:
    """运行嵌套 CPCV。

    对每个外折，在内部折上选择最优参数（用最大 Sharpe），
    然后在外折测试集上评估。

    Returns:
        (inner_selected_sharpes, outer_test_sharpes)
    """
    all_returns = compute_portfolio_returns(data, symbols, weights)
    if len(all_returns) < 10:
        return [], []

    outer_test_sharpes = []
    inner_selected_sharpes = []

    for i, outer in enumerate(outer_folds):
        train_rets, test_rets = apply_fold_to_returns(all_returns, outer)

        if len(train_rets) < 10 or len(test_rets) < 5:
            continue

        inner_sharpes = []
        inner_folds = inner_folds_map.get(i, [])
        for inner_fold in inner_folds:
            inner_train, _ = apply_fold_to_returns(train_rets, inner_fold)
            if len(inner_train) >= 5:
                sr = compute_sharpe_ratio(inner_train, risk_free_rate)
                inner_sharpes.append(sr)

        if inner_sharpes:
            inner_selected = max(inner_sharpes)
            inner_selected_sharpes.append(inner_selected)

        test_sr = compute_sharpe_ratio(test_rets, risk_free_rate)
        outer_test_sharpes.append(test_sr)

    return inner_selected_sharpes, outer_test_sharpes
