"""GPU-accelerated Walk-Forward optimization."""

import math
import random

import numpy as np
import torch

from cpcv import compute_returns_from_prices
from dsr import compute_sharpe_ratio, compute_dsr, compute_skewness, compute_kurtosis
from models import (
    CpcvFold,
    MarketDataInput,
    StrategyParameterBounds,
    StrategyParameterSet,
    TransactionCostConfig,
    WalkForwardResult,
    WalkForwardSummary,
    WalkForwardWindow,
)


SAFE_SYMBOLS = ["511360", "511880"]
AMBITION_SYMBOLS = ["000300", "000905", "000922"]


def generate_walk_forward_windows(
    total_obs: int,
    num_windows: int = 6,
    train_ratio: float = 0.7,
) -> list[WalkForwardWindow]:
    if total_obs < num_windows * 20:
        raise ValueError(f"total_obs ({total_obs}) too small for {num_windows} windows")

    windows_per_fold = total_obs // num_windows
    train_size = int(windows_per_fold * train_ratio)
    test_size = windows_per_fold - train_size

    windows: list[WalkForwardWindow] = []
    for w in range(num_windows):
        ws = w * windows_per_fold
        if ws + test_size > total_obs:
            break
        windows.append(WalkForwardWindow(
            train_start=ws,
            train_end=ws + train_size - 1,
            test_start=ws + train_size,
            test_end=ws + windows_per_fold - 1,
        ))
    return windows


def _random_in_range(lo: float, hi: float) -> float:
    return lo + random.random() * (hi - lo)


def _random_int_in_range(lo: int, hi: int) -> int:
    return random.randint(lo, hi)


def _random_weights(bounds: dict[str, tuple[float, float]]) -> dict[str, float]:
    raw = {}
    total = 0.0
    for sym, (lo, hi) in bounds.items():
        v = lo + random.random() * (hi - lo)
        raw[sym] = v
        total += v
    if total > 0:
        return {k: v / total for k, v in raw.items()}
    return raw


def generate_random_parameter_sets(
    bounds: StrategyParameterBounds,
    count: int,
) -> list[StrategyParameterSet]:
    sets: list[StrategyParameterSet] = []
    for _ in range(count):
        safe_ratio = _random_in_range(*bounds.safe_ratio)
        ambition_ratio = _random_in_range(*bounds.ambition_ratio)
        total_ratio = safe_ratio + ambition_ratio
        if total_ratio > 0:
            safe_ratio_norm = safe_ratio / total_ratio
            ambition_ratio_norm = ambition_ratio / total_ratio
        else:
            safe_ratio_norm = 0.5
            ambition_ratio_norm = 0.5

        ma_short = _random_int_in_range(*bounds.ma_short_window)
        ma_long_lo = max(ma_short + 1, bounds.ma_long_window[0])
        ma_long_hi = max(ma_long_lo, bounds.ma_long_window[1])
        ma_long = _random_int_in_range(ma_long_lo, ma_long_hi)

        sets.append(StrategyParameterSet(
            trigger_line=_random_int_in_range(*bounds.trigger_line),
            safe_ratio=safe_ratio_norm,
            ambition_ratio=ambition_ratio_norm,
            bsm_threshold=_random_in_range(*bounds.bsm_threshold),
            ma_short_window=ma_short,
            ma_long_window=ma_long,
            safe_allocation=_random_weights(bounds.safe_allocation),
            ambition_allocation=_random_weights(bounds.ambition_allocation),
        ))
    return sets


def extract_returns_for_symbols(
    data: MarketDataInput,
    symbols: list[str],
) -> list[np.ndarray]:
    valid_symbols = [s for s in symbols if s in data.symbols and data.symbols[s].close]
    if not valid_symbols:
        return []
    n = min(len(data.symbols[s].close) for s in valid_symbols)
    if n < 10:
        return []
    result = []
    for sym in symbols:
        df = data.symbols.get(sym)
        if df is None or not df.close:
            result.append(np.zeros(n - 1))
        else:
            prices = df.close[-n:]
            result.append(compute_returns_from_prices(prices))
    return result


def compute_portfolio_returns_for_params(
    symbols: list[str],
    all_returns: list[np.ndarray],
    start: int,
    end: int,
    params: StrategyParameterSet,
) -> np.ndarray:
    safe_indices = [symbols.index(s) for s in SAFE_SYMBOLS if s in symbols]
    ambition_indices = [symbols.index(s) for s in AMBITION_SYMBOLS if s in symbols]

    length = end - start + 1
    if length < 5:
        return np.array([])

    max_global_t = start + length - 1
    for idx in safe_indices + ambition_indices:
        if idx >= len(all_returns) or max_global_t >= len(all_returns[idx]):
            return np.array([])

    combined = np.zeros(length)
    for t in range(length):
        global_t = start + t

        safe_ret = 0.0
        safe_sum = 0.0
        for idx in safe_indices:
            w = params.safe_allocation.get(symbols[idx], 0.0)
            safe_ret += w * all_returns[idx][global_t]
            safe_sum += w
        if safe_sum > 0:
            safe_ret /= safe_sum

        ambition_ret = 0.0
        ambition_sum = 0.0
        for idx in ambition_indices:
            w = params.ambition_allocation.get(symbols[idx], 0.0)
            ambition_ret += w * all_returns[idx][global_t]
            ambition_sum += w
        if ambition_sum > 0:
            ambition_ret /= ambition_sum

        combined[t] = params.safe_ratio * safe_ret + params.ambition_ratio * ambition_ret

    return combined


def apply_transaction_costs(
    returns: np.ndarray,
    params: StrategyParameterSet,
    cost_config: TransactionCostConfig,
    rebalance_freq_days: int = 21,
) -> np.ndarray:
    """扣除交易成本后的收益率。

    MMF 部分（511360/511880）：0 成本
    ETF 部分（000300/000905/000922）：按调仓频率收取佣金
    每笔交易成本 = max(etf_bps / 10000 * 交易金额, etf_min_yuan)
    日摊销成本 = ambition_ratio * 每笔交易成本 / rebalance_freq_days
    """
    trade_notional_ratio = params.ambition_ratio
    cost_per_trade_bps = trade_notional_ratio * cost_config.etf_bps / 10000.0
    cost_per_trade_min = trade_notional_ratio * cost_config.etf_min_yuan if cost_config.etf_min_yuan > 0 else 0.0
    cost_per_trade = max(cost_per_trade_bps, cost_per_trade_min)
    cost_per_day = cost_per_trade / rebalance_freq_days

    if cost_per_day <= 0:
        return returns

    return returns - cost_per_day


def score_parameter_set(
    symbols: list[str],
    all_returns: list[np.ndarray],
    start: int,
    end: int,
    params: StrategyParameterSet,
    risk_free_rate: float = 0.0,
    cost_config: TransactionCostConfig | None = None,
    rebalance_freq_days: int = 21,
) -> float:
    rets = compute_portfolio_returns_for_params(symbols, all_returns, start, end, params)
    if len(rets) < 5:
        return -1.0
    if cost_config is not None:
        rets = apply_transaction_costs(rets, params, cost_config, rebalance_freq_days)
    return compute_sharpe_ratio(rets, risk_free_rate)


def _compute_pbo(
    train_ranks: list[list[int]],
    test_ranks: list[list[int]],
) -> tuple[float, list[list[float]]]:
    num_params = len(train_ranks)
    num_splits = len(train_ranks[0]) if train_ranks else 0

    underperform = 0
    total = 0
    ranking_matrix: list[list[float]] = []

    for s in range(num_splits):
        best_train_idx = min(
            range(num_params),
            key=lambda i: train_ranks[i][s],
        )
        test_rank_of_best = test_ranks[best_train_idx][s]
        median_rank = num_params / 2.0
        ranking_matrix.append([float(best_train_idx), float(test_rank_of_best)])

        if test_rank_of_best > median_rank:
            underperform += 1
        total += 1

    score = underperform / total if total > 0 else 1.0
    return score, ranking_matrix


def compute_pbo_ranking_matrix(
    train_ranks: list[list[int]],
    test_ranks: list[list[int]],
) -> list[list[float]]:
    _, ranking_matrix = _compute_pbo(train_ranks, test_ranks)
    return ranking_matrix


def run_walk_forward(
    data: MarketDataInput,
    symbols: list[str],
    bounds: StrategyParameterBounds,
    num_parameter_sets: int = 200,
    num_windows: int = 6,
    train_ratio: float = 0.7,
    risk_free_rate: float = 0.0,
    alpha: float = 0.05,
    cost_config: TransactionCostConfig | None = None,
) -> WalkForwardSummary:
    all_returns = extract_returns_for_symbols(data, symbols)
    if not all_returns:
        return WalkForwardSummary(pbo_score=1.0, stability_score=0.0)

    total_obs = len(all_returns[0])
    windows = generate_walk_forward_windows(total_obs, num_windows, train_ratio)
    param_sets = generate_random_parameter_sets(bounds, num_parameter_sets)

    results: list[WalkForwardResult] = []
    train_rank_matrix: list[list[int]] = [[] for _ in range(num_parameter_sets)]
    test_rank_matrix: list[list[int]] = [[] for _ in range(num_parameter_sets)]

    for window in windows:
        train_scores: list[float] = []
        test_scores: list[float] = []

        for p in range(num_parameter_sets):
            tr_score = score_parameter_set(
                symbols, all_returns, window.train_start, window.train_end,
                param_sets[p], risk_free_rate, cost_config,
            )
            te_score = score_parameter_set(
                symbols, all_returns, window.test_start, window.test_end,
                param_sets[p], risk_free_rate, cost_config,
            )
            train_scores.append(tr_score)
            test_scores.append(te_score)

        train_sorted = sorted(
            range(num_parameter_sets),
            key=lambda i: train_scores[i],
            reverse=True,
        )
        test_sorted = sorted(
            range(num_parameter_sets),
            key=lambda i: test_scores[i],
            reverse=True,
        )

        for rank, idx in enumerate(train_sorted):
            train_rank_matrix[idx].append(rank + 1)
        for rank, idx in enumerate(test_sorted):
            test_rank_matrix[idx].append(rank + 1)

        best_param_idx = train_sorted[0]
        best_params = param_sets[best_param_idx]
        best_train = train_scores[best_param_idx]
        best_test = test_scores[best_param_idx]

        best_rets = compute_portfolio_returns_for_params(
            symbols, all_returns, window.test_start, window.test_end, best_params,
        )
        n_best = len(best_rets)
        ret_skew = compute_skewness(best_rets) if n_best >= 3 else 0.0
        ret_kurt = compute_kurtosis(best_rets) if n_best >= 4 else 0.0
        dsr = compute_dsr(best_test, n_best, ret_skew, alpha, ret_kurt)

        results.append(WalkForwardResult(
            window=window,
            optimal_params=best_params,
            train_sharpe=best_train,
            test_sharpe=best_test,
            dsr=dsr,
            rank=1,
        ))

    dsr_rankings = sorted([r.dsr for r in results], reverse=True)

    pbo_score, ranking_matrix = _compute_pbo(train_rank_matrix, test_rank_matrix)

    test_sharpes = np.array([r.test_sharpe for r in results])
    stability_score = float(abs(compute_sharpe_ratio(test_sharpes))) if len(test_sharpes) > 1 else 0.0

    return WalkForwardSummary(
        results=results,
        dsr_rankings=dsr_rankings,
        pbo_score=pbo_score,
        stability_score=stability_score,
        pbo_ranking_matrix=ranking_matrix,
    )
