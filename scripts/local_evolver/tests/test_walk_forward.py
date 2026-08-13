"""Tests for walk_forward.py module."""

import dataclasses

import numpy as np
import pytest
from constants import MIN_OBS_FOR_SHARPE
from models import DataFrame, DcaConfig, MarketDataInput, TransactionCostConfig
from walk_forward import (
    BACKTEST_SYMBOLS,
    INVALID_SCORE,
    _compute_pbo,
    check_data_sufficiency,
    compute_portfolio_returns_for_params,
    extract_prices_for_symbols,
    extract_returns_for_symbols,
    generate_random_parameter_sets,
    generate_walk_forward_windows,
    resolve_backtest_symbols,
    run_walk_forward,
    score_parameter_set,
)


def _df(dates: list[str], closes: list[float]) -> DataFrame:
    return DataFrame(
        dates=list(dates),
        close=list(closes),
        open=[],
        high=[],
        low=[],
        volume=[],
    )


def test_generate_walk_forward_windows():
    windows = generate_walk_forward_windows(
        total_obs=1500, num_windows=6, train_ratio=0.7
    )
    assert len(windows) <= 6
    for w in windows:
        assert w.train_end > w.train_start
        assert w.test_end >= w.test_start
        assert w.test_end - w.test_start + 1 >= MIN_OBS_FOR_SHARPE


def test_generate_walk_forward_windows_insufficient():
    with pytest.raises(ValueError):
        generate_walk_forward_windows(total_obs=200, num_windows=6)


def test_generate_random_parameter_sets(sample_bounds):
    sets = generate_random_parameter_sets(sample_bounds, 10)
    assert len(sets) == 10
    for s in sets:
        assert 1000 <= s.trigger_line <= 3000
        assert 0.3 <= s.safe_ratio <= 0.8
        assert 0.2 <= s.ambition_ratio <= 0.7
        assert abs(s.safe_ratio + s.ambition_ratio - 1.0) < 1e-6
        assert 5 <= s.ma_short_window <= 50
        assert s.ma_long_window > s.ma_short_window
        assert abs(sum(s.safe_allocation.values()) - 1.0) < 1e-6
        assert abs(sum(s.ambition_allocation.values()) - 1.0) < 1e-6


def test_extract_prices_for_symbols_aligned(sample_market_data):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    assert len(prices) == len(BACKTEST_SYMBOLS)
    assert all(len(p) == len(prices[0]) for p in prices)
    assert len(prices[0]) == 500


def test_extract_prices_for_symbols_inner_joins_on_dates():
    a = _df(
        ["2023-01-01", "2023-01-02", "2023-01-03", "2023-01-04"],
        [10.0, 11.0, 12.0, 13.0],
    )
    b = _df(
        ["2023-01-02", "2023-01-03", "2023-01-04", "2023-01-05"],
        [5.0, 6.0, 7.0, 8.0],
    )
    prices = extract_prices_for_symbols(
        MarketDataInput(symbols={"A": a, "B": b}), ["A", "B"]
    )
    assert len(prices) == 2
    assert len(prices[0]) == 3
    np.testing.assert_allclose(prices[0], [11.0, 12.0, 13.0])
    np.testing.assert_allclose(prices[1], [5.0, 6.0, 7.0])


def test_extract_prices_for_symbols_missing_raises(sample_market_data):
    with pytest.raises(ValueError, match="no close data"):
        extract_prices_for_symbols(sample_market_data, ["000300", "INVALID"])


def test_extract_returns_for_symbols(sample_market_data):
    returns = extract_returns_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    assert len(returns) == len(BACKTEST_SYMBOLS)
    assert all(len(r) == len(returns[0]) for r in returns)
    assert len(returns[0]) == 500


def test_check_data_sufficiency_rejects_short_series():
    dates = [f"2023-01-{d:02d}" for d in range(1, 21)]
    data = MarketDataInput(symbols={"000300": _df(dates, [1.0] * 20)})
    with pytest.raises(ValueError, match="000300"):
        check_data_sufficiency(data, ["000300"], min_obs=MIN_OBS_FOR_SHARPE)


def test_resolve_backtest_symbols_missing_proxy_raises():
    data = MarketDataInput(symbols={})
    with pytest.raises(ValueError, match="missing"):
        resolve_backtest_symbols(data, list(BACKTEST_SYMBOLS))


def test_compute_portfolio_returns_for_params(sample_market_data, sample_params):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    rets = compute_portfolio_returns_for_params(
        BACKTEST_SYMBOLS,
        prices,
        0,
        100,
        sample_params,
        cost_config=TransactionCostConfig(),
        dca_config=DcaConfig(),
    )
    assert len(rets) == 101


def test_score_parameter_set(sample_market_data, sample_params):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    score = score_parameter_set(
        BACKTEST_SYMBOLS,
        prices,
        0,
        199,
        sample_params,
        cost_config=TransactionCostConfig(),
        dca_config=DcaConfig(),
    )
    assert isinstance(score, float)
    assert score != INVALID_SCORE


def test_score_parameter_set_too_short_returns_invalid(
    sample_market_data, sample_params
):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    score = score_parameter_set(
        BACKTEST_SYMBOLS,
        prices,
        0,
        30,
        sample_params,
    )
    assert score == INVALID_SCORE


def test_all_six_params_affect_score(sample_market_data, sample_params):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    cost = TransactionCostConfig()
    dca = DcaConfig()
    base = sample_params
    start, end = 0, 399

    base_score = score_parameter_set(
        BACKTEST_SYMBOLS, prices, start, end, base, cost_config=cost, dca_config=dca
    )
    assert base_score != INVALID_SCORE

    variants = [
        dataclasses.replace(base, trigger_line=base.trigger_line + 500),
        # The fixture's panic ratios peak ~1.09, so raising the threshold is a
        # no-op; lowering it to 1.0 lets panic days (1.0 < panic < 1.4) execute
        # that the default defers — bsm_threshold must change outcomes.
        dataclasses.replace(base, bsm_threshold=max(1.0, base.bsm_threshold - 0.4)),
        dataclasses.replace(base, ma_short_window=base.ma_short_window + 5),
        dataclasses.replace(base, ma_long_window=base.ma_long_window + 20),
        dataclasses.replace(base, safe_ratio=0.55, ambition_ratio=0.45),
        dataclasses.replace(base, safe_allocation={"000012": 0.5, "000013": 0.5}),
    ]
    for variant in variants:
        score = score_parameter_set(
            BACKTEST_SYMBOLS,
            prices,
            start,
            end,
            variant,
            cost_config=cost,
            dca_config=dca,
        )
        assert score != base_score, f"parameter variant had no effect: {variant}"


def test_compute_pbo():
    train_ranks = [[1, 2, 3], [2, 1, 3], [3, 2, 1]]
    test_ranks = [[2, 1, 3], [1, 3, 2], [3, 1, 2]]
    pbo, matrix = _compute_pbo(train_ranks, test_ranks)
    assert 0.0 <= pbo <= 1.0
    assert len(matrix) == 3
    assert all(len(row) == 2 for row in matrix)


def test_run_walk_forward(sample_market_data, sample_bounds):
    summary = run_walk_forward(
        sample_market_data,
        BACKTEST_SYMBOLS,
        sample_bounds,
        num_parameter_sets=50,
        num_windows=2,
    )
    assert 0.0 <= summary.pbo_score <= 1.0
    assert summary.stability_score >= 0.0
    assert len(summary.results) == 2
    assert len(summary.pbo_ranking_matrix) == 2


def test_run_walk_forward_insufficient_data_raises(sample_bounds):
    data = MarketDataInput(
        symbols={"000300": _df([f"2023-01-{d:02d}" for d in range(1, 10)], [1.0] * 9)}
    )
    with pytest.raises(ValueError):
        run_walk_forward(
            data,
            BACKTEST_SYMBOLS,
            sample_bounds,
            num_parameter_sets=5,
            num_windows=2,
        )
