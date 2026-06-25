"""CPCV (Combinatorial Purged Cross-Validation) implementation."""

import math
import random
from itertools import combinations

import numpy as np

from dsr import compute_sharpe_ratio, compute_skewness, compute_kurtosis, compute_dsr
from models import CpcvFold, CpcvResult, MarketDataInput, SharpeDistribution, SharpePercentiles


def _sample_combinations(n: int, k: int, max_samples: int, random_state: int = 42) -> list[list[int]]:
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


def generate_cpcv_folds(
    total_obs: int,
    num_groups: int = 10,
    num_test_groups: int = 2,
    num_splits: int = 10,
    purge_days: int = 5,
    embargo_days: int = 5,
) -> list[CpcvFold]:
    group_size = total_obs // num_groups
    if group_size < 1:
        raise ValueError(f"total_obs ({total_obs}) too small for {num_groups} groups")

    combs = _sample_combinations(num_groups, num_test_groups, num_splits, random_state=42)
    folds: list[CpcvFold] = []

    for test_group_indices in combs:
        test_set = set(test_group_indices)
        train_indices = [i for i in range(num_groups) if i not in test_set]

        train_end = (max(train_indices) + 1) * group_size - 1
        test_start = min(test_group_indices) * group_size
        test_end = (max(test_group_indices) + 1) * group_size - 1

        purged_train_end = min(train_end, test_start - purge_days - 1)
        embargoed_test_start = max(test_start, train_end + embargo_days + 1)

        fold = CpcvFold(
            train_start=0,
            train_end=max(0, purged_train_end),
            test_start=min(total_obs - 1, embargoed_test_start),
            test_end=min(total_obs - 1, test_end),
        )
        if fold.train_end > fold.train_start and fold.test_end - fold.test_start >= 5:
            folds.append(fold)

    return folds


def compute_returns_from_prices(prices: list[float]) -> np.ndarray:
    arr = np.array(prices, dtype=np.float64)
    return arr[1:] / arr[:-1] - 1.0


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
    train = returns[fold.train_start:fold.train_end + 1]
    test = returns[fold.test_start:fold.test_end + 1]
    return train, test


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
    outer_folds = generate_cpcv_folds(total_obs, outer_groups, test_groups, outer_groups, purge_days, embargo_days)

    inner_folds_map: dict[int, list[CpcvFold]] = {}
    for i, outer in enumerate(outer_folds):
        train_len = outer.train_end - outer.train_start + 1
        if train_len > inner_groups * 10:
            inner = generate_cpcv_folds(train_len, inner_groups, test_groups, inner_groups, purge_days, embargo_days)
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
