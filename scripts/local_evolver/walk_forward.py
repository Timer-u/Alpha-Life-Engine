"""Walk-Forward optimization scoring a real DCA strategy.

The backtest safe layer runs on real money-market ETFs（回测即实盘宇宙）:
511360 / 511880 / 511990, the same universe the frontend executes live.
All series are aligned by explicit trading-date inner-join so a
suspension/missing day can never silently shift one series against another.
"""

import random

import numpy as np
from constants import (
    MIN_OBS_FOR_KURTOSIS,
    MIN_OBS_FOR_SHARPE,
    MIN_OBS_FOR_SKEW,
    REBALANCE_FREQUENCY_DAYS,
)
from dca_sim import simulate_dca
from dsr import compute_dsr, compute_kurtosis, compute_sharpe_ratio, compute_skewness
from models import (
    DcaConfig,
    MarketDataInput,
    StrategyParameterBounds,
    StrategyParameterSet,
    TransactionCostConfig,
    WalkForwardResult,
    WalkForwardSummary,
    WalkForwardWindow,
)

# Backtest safe layer = real money-market ETFs（回测即实盘宇宙）; backtest
# and live execution share the same symbol universe.
BACKTEST_SAFE_SYMBOLS = ["511880", "511990", "511360"]
AMBITION_SYMBOLS = ["510300", "510500", "515080"]
BACKTEST_SYMBOLS = BACKTEST_SAFE_SYMBOLS + AMBITION_SYMBOLS

INVALID_SCORE = float("-inf")


def resolve_backtest_symbols(
    data: MarketDataInput,
    symbols: list[str],
) -> list[str]:
    """Return the walk-forward working universe (safe money-market ETFs + ambition).

    Loudly fails if the backtest universe is not fully present, so the
    silent-collapse failure mode of C1 cannot recur.
    """
    missing_symbols = [s for s in BACKTEST_SYMBOLS if s not in symbols]
    if missing_symbols:
        msg = (
            "backtest universe is not a subset of the given symbols; "
            f"missing {missing_symbols}"
        )
        raise ValueError(msg)
    missing_data = [s for s in BACKTEST_SYMBOLS if s not in data.symbols]
    if missing_data:
        msg = f"backtest universe missing market data; need {missing_data}"
        raise ValueError(msg)
    return list(BACKTEST_SYMBOLS)


def check_data_sufficiency(
    data: MarketDataInput,
    symbols: list[str],
    min_obs: int = MIN_OBS_FOR_SHARPE,
) -> None:
    """Data-sufficiency precondition (C5): loud failure naming the symbol.

    Raises ``ValueError`` naming the offending symbol and its bar count so a
    short/incomplete series can never silently produce a meaningless score.
    """
    for s in symbols:
        df = data.symbols.get(s)
        if df is None or not df.close:
            msg = f"missing price data for symbol {s}"
            raise ValueError(msg)
        n = len(df.close)
        if n < min_obs:
            msg = f"{s}: only {n} bars, need >= {min_obs} for valid statistics"
            raise ValueError(msg)
        if len(df.dates) != n:
            msg = (
                f"{s}: dates/closes length mismatch "
                f"({len(df.dates)} dates vs {n} closes)"
            )
            raise ValueError(msg)


def extract_prices_for_symbols(
    data: MarketDataInput,
    symbols: list[str],
) -> list[np.ndarray]:
    """Explicit date-based alignment (inner join across trading dates).

    Replaces the silent ``min(len)`` tail-alignment (C1): every symbol's
    series is rebuilt on the intersection of its trading dates, in sorted
    order, so a suspension day cannot shift series against each other.
    """
    if not symbols:
        msg = "no symbols given"
        raise ValueError(msg)

    by_symbol: list[tuple[str, dict[str, float]]] = []
    for s in symbols:
        df = data.symbols.get(s)
        if df is None or not df.close:
            msg = f"symbol {s} has no close data"
            raise ValueError(msg)
        if len(df.dates) != len(df.close):
            msg = (
                f"symbol {s} has mismatched date/close arrays "
                f"({len(df.dates)} vs {len(df.close)})"
            )
            raise ValueError(msg)
        price_by_date = {d: float(c) for d, c in zip(df.dates, df.close, strict=True)}
        if len(price_by_date) != len(df.dates):
            msg = f"symbol {s} has duplicate trading dates"
            raise ValueError(msg)
        by_symbol.append((s, price_by_date))

    common_dates: set[str] | None = None
    for _, price_by_date in by_symbol:
        common_dates = (
            set(price_by_date)
            if common_dates is None
            else common_dates & set(price_by_date)
        )
    if not common_dates:
        msg = "no common trading dates across symbols " + ", ".join(symbols)
        raise ValueError(msg)

    if set(symbols) == set(BACKTEST_SYMBOLS):
        return _union_join_aligned(symbols, by_symbol)
    ordered = sorted(common_dates)
    aligned: list[np.ndarray] = []
    for _, price_by_date in by_symbol:
        aligned.append(np.array([price_by_date[d] for d in ordered], dtype=np.float64))
    return aligned


def _union_join_aligned(
    symbols: list[str],
    by_symbol: list[tuple[str, dict[str, float]]],
) -> list[np.ndarray]:
    """Union-join over trading dates with per-layer availability (P1).

    Master index = union of every symbol's trading dates, truncated to the
    first date where BOTH layers have at least one symbol. Symbols that
    listed later get NaN until their first bar; composites renormalize
    across whatever is available (as-if backtest, no index proxies).
    """
    safe_symbols = set(BACKTEST_SAFE_SYMBOLS)
    ambition_symbols = set(AMBITION_SYMBOLS)
    all_dates: set[str] = set()
    for _, price_by_date in by_symbol:
        all_dates |= set(price_by_date)

    def layer_first(layer: set[str]) -> str:
        firsts = [
            min(price_by_date)
            for sym, price_by_date in by_symbol
            if sym in layer and price_by_date
        ]
        if not firsts:
            msg = "backtest layer has no symbols with data"
            raise ValueError(msg)
        return min(firsts)

    first_safe = layer_first(safe_symbols)
    first_ambition = layer_first(ambition_symbols)
    master_start = max(first_safe, first_ambition)
    master = sorted(d for d in all_dates if d >= master_start)
    if not master:
        msg = "no trading dates after both layers become available"
        raise ValueError(msg)

    aligned: list[np.ndarray] = []
    for _, price_by_date in by_symbol:
        aligned.append(
            np.array(
                [price_by_date.get(d, float("nan")) for d in master],
                dtype=np.float64,
            )
        )
    return aligned


def _prices_to_day_returns(prices: np.ndarray) -> np.ndarray:
    """Day-aligned returns: ``returns[t] = prices[t]/prices[t-1] - 1``,
    ``returns[0] = 0`` (index t refers to day t close, matching sim)."""
    returns = np.zeros(len(prices))
    if len(prices) > 1:
        returns[1:] = prices[1:] / prices[:-1] - 1.0
    return returns


def _weighted_composite(
    all_prices: list[np.ndarray],
    symbols: list[str],
    indices: list[int],
    weights: dict[str, float],
) -> np.ndarray:
    base = all_prices[indices[0]]
    composite = np.full(len(base), np.nan)
    for i in range(len(base)):
        total = 0.0
        value = 0.0
        for idx in indices:
            w = weights.get(symbols[idx], 0.0)
            p = all_prices[idx][i]
            if w > 0 and np.isfinite(p):
                value += w * p
                total += w
        if total > 0:
            composite[i] = value / total
    return composite


def generate_walk_forward_windows(
    total_obs: int,
    num_windows: int = 6,
    train_ratio: float = 0.7,
    purge_days: int = 0,
    embargo_days: int = 0,
) -> list[WalkForwardWindow]:
    if num_windows <= 0:
        msg = f"num_windows must be >= 1, got {num_windows}"
        raise ValueError(msg)
    if not 0.0 < train_ratio < 1.0:
        msg = f"train_ratio must be in (0, 1), got {train_ratio}"
        raise ValueError(msg)
    if purge_days < 0 or embargo_days < 0:
        msg = f"purge/embargo must be >= 0, got purge={purge_days}, embargo={embargo_days}"
        raise ValueError(msg)

    gap_span = (purge_days + embargo_days) * (num_windows - 1)
    windows_per_fold = (total_obs - gap_span) // num_windows
    if windows_per_fold < 1:
        msg = (
            f"total_obs ({total_obs}) too small for {num_windows} windows "
            f"with purge={purge_days} + embargo={embargo_days}"
        )
        raise ValueError(msg)

    train_size = int(windows_per_fold * train_ratio)
    test_size = windows_per_fold - train_size
    if test_size < MIN_OBS_FOR_SHARPE:
        msg = (
            f"total_obs ({total_obs}) yields {test_size}-day test windows; "
            f"need >= {MIN_OBS_FOR_SHARPE} for statistically valid Sharpe/DSR"
        )
        raise ValueError(msg)
    if test_size <= purge_days + embargo_days:
        msg = (
            f"test window {test_size} days must exceed purge+embargo "
            f"({purge_days}+{embargo_days})"
        )
        raise ValueError(msg)

    windows: list[WalkForwardWindow] = []
    for w in range(num_windows):
        ws = w * windows_per_fold
        train_end = ws + train_size - 1
        purged_train_end = train_end - purge_days
        test_start = train_end + 1 + embargo_days
        test_end = test_start + test_size - 1
        if test_end > total_obs - 1:
            break
        windows.append(
            WalkForwardWindow(
                train_start=ws,
                train_end=purged_train_end,
                test_start=test_start,
                test_end=test_end,
            )
        )
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

        sets.append(
            StrategyParameterSet(
                trigger_line=_random_int_in_range(
                    int(bounds.trigger_line[0]), int(bounds.trigger_line[1])
                ),
                safe_ratio=safe_ratio_norm,
                ambition_ratio=ambition_ratio_norm,
                bsm_threshold=_random_in_range(*bounds.bsm_threshold),
                ma_short_window=ma_short,
                ma_long_window=ma_long,
                safe_allocation=_random_weights(bounds.safe_allocation),
                ambition_allocation=_random_weights(bounds.ambition_allocation),
            )
        )
    return sets


def extract_returns_for_symbols(
    data: MarketDataInput,
    symbols: list[str],
) -> list[np.ndarray]:
    """Day-aligned daily returns per symbol (length-N convention)."""
    return [
        _prices_to_day_returns(p) for p in extract_prices_for_symbols(data, symbols)
    ]


def compute_portfolio_returns_for_params(
    symbols: list[str],
    all_prices: list[np.ndarray],
    start: int,
    end: int,
    params: StrategyParameterSet,
    cost_config: TransactionCostConfig | None = None,
    dca_config: DcaConfig | None = None,
) -> np.ndarray:
    """TWR daily returns of the DCA strategy over ``[start, end]``.

    The DCA simulator consumes the full aligned price history (so moving
    averages at window start have true limited lookback) and is scored inside
    the window. Costs are charged inside the simulator on real notional (C3).
    """
    if not all_prices:
        return np.array([])
    n_min = min(len(p) for p in all_prices)
    if start < 0 or end < start or end >= n_min:
        return np.array([])

    safe_indices = [symbols.index(s) for s in BACKTEST_SAFE_SYMBOLS if s in symbols]
    ambition_indices = [symbols.index(s) for s in AMBITION_SYMBOLS if s in symbols]
    if not safe_indices or not ambition_indices:
        return np.array([])

    safe_price = _weighted_composite(
        all_prices, symbols, safe_indices, params.safe_allocation
    )
    ambition_price = _weighted_composite(
        all_prices, symbols, ambition_indices, params.ambition_allocation
    )

    if not np.all(np.isfinite(safe_price)) or not np.all(np.isfinite(ambition_price)):
        msg = (
            "composite series contains missing data on the backtest master "
            "index; check per-symbol listing dates"
        )
        raise ValueError(msg)

    safe_returns = _prices_to_day_returns(safe_price)
    ambition_returns = _prices_to_day_returns(ambition_price)

    cfg = cost_config if cost_config is not None else TransactionCostConfig()
    dca = dca_config if dca_config is not None else DcaConfig()

    outcome = simulate_dca(
        safe_returns,
        ambition_returns,
        ambition_price,
        params,
        cfg,
        dca,
        start,
        end,
    )
    return outcome.returns


def score_parameter_set(
    symbols: list[str],
    all_prices: list[np.ndarray],
    start: int,
    end: int,
    params: StrategyParameterSet,
    risk_free_rate: float = 0.0,
    cost_config: TransactionCostConfig | None = None,
    dca_config: DcaConfig | None = None,
) -> float:
    """Score a parameter set on the DCA strategy's TWR unit returns (C2).

    Hard minimum-observation gate (C5): shorter windows return
    ``INVALID_SCORE`` instead of a meaningless number.
    """
    rets = compute_portfolio_returns_for_params(
        symbols,
        all_prices,
        start,
        end,
        params,
        cost_config,
        dca_config,
    )
    if len(rets) < MIN_OBS_FOR_SHARPE:
        return INVALID_SCORE
    return compute_sharpe_ratio(rets, risk_free_rate)


def apply_transaction_costs_legacy(
    returns: np.ndarray,
    params: StrategyParameterSet,
    cost_config: TransactionCostConfig,
    rebalance_freq_days: int = REBALANCE_FREQUENCY_DAYS,
) -> np.ndarray:
    """LEGACY daily-smear cost model — DEPRECATED (C3).

    Superseded by event-driven commission inside ``dca_sim.simulate_dca``.
    Kept only as a historical reference; it is NOT used anywhere in the
    scoring/optimization path.
    """
    trade_notional_ratio = params.ambition_ratio
    cost_per_trade_bps = trade_notional_ratio * cost_config.etf_bps / 10000.0
    cost_per_trade_min = (
        trade_notional_ratio * cost_config.etf_min_yuan
        if cost_config.etf_min_yuan > 0
        else 0.0
    )
    cost_per_trade = max(cost_per_trade_bps, cost_per_trade_min)
    cost_per_day = cost_per_trade / rebalance_freq_days

    if cost_per_day <= 0:
        return returns

    return returns - cost_per_day


def _compute_pbo(
    train_ranks: list[list[int]],
    test_ranks: list[list[int]],
) -> tuple[float, list[list[float]]]:
    """Note: "probability of backtest overfitting" per Bailey et al. (2015) —
    the fraction of splits where the IS-best configuration lands below the
    median OOS rank (num_params/2). This is the standard definition.
    """
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
    purge_days: int = 0,
    embargo_days: int = 0,
    cost_config: TransactionCostConfig | None = None,
    dca_config: DcaConfig | None = None,
) -> WalkForwardSummary:
    wf_symbols = resolve_backtest_symbols(data, symbols)
    check_data_sufficiency(data, wf_symbols, min_obs=MIN_OBS_FOR_SHARPE)
    all_prices = extract_prices_for_symbols(data, wf_symbols)

    total_obs = len(all_prices[0])
    windows = generate_walk_forward_windows(
        total_obs, num_windows, train_ratio, purge_days, embargo_days
    )
    param_sets = generate_random_parameter_sets(bounds, num_parameter_sets)

    results: list[WalkForwardResult] = []
    train_rank_matrix: list[list[int]] = [[] for _ in range(num_parameter_sets)]
    test_rank_matrix: list[list[int]] = [[] for _ in range(num_parameter_sets)]

    for window in windows:
        train_scores: list[float] = []
        test_scores: list[float] = []

        for p in range(num_parameter_sets):
            tr_score = score_parameter_set(
                wf_symbols,
                all_prices,
                window.train_start,
                window.train_end,
                param_sets[p],
                risk_free_rate,
                cost_config,
                dca_config,
            )
            te_score = score_parameter_set(
                wf_symbols,
                all_prices,
                window.test_start,
                window.test_end,
                param_sets[p],
                risk_free_rate,
                cost_config,
                dca_config,
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
            wf_symbols,
            all_prices,
            window.test_start,
            window.test_end,
            best_params,
            cost_config,
            dca_config,
        )
        n_best = len(best_rets)
        ret_skew = compute_skewness(best_rets) if n_best >= MIN_OBS_FOR_SKEW else 0.0
        ret_kurt = (
            compute_kurtosis(best_rets) if n_best >= MIN_OBS_FOR_KURTOSIS else 0.0
        )
        dsr = compute_dsr(best_test, n_best, ret_skew, alpha, ret_kurt)

        results.append(
            WalkForwardResult(
                window=window,
                optimal_params=best_params,
                train_sharpe=best_train,
                test_sharpe=best_test,
                dsr=dsr,
                rank=1,
            )
        )

    dsr_rankings = sorted([r.dsr for r in results], reverse=True)

    pbo_score, ranking_matrix = _compute_pbo(train_rank_matrix, test_rank_matrix)

    test_sharpes = np.array([r.test_sharpe for r in results])
    stability_score = (
        float(abs(compute_sharpe_ratio(test_sharpes))) if len(test_sharpes) > 1 else 0.0
    )

    return WalkForwardSummary(
        results=results,
        dsr_rankings=dsr_rankings,
        pbo_score=pbo_score,
        stability_score=stability_score,
        pbo_ranking_matrix=ranking_matrix,
    )
