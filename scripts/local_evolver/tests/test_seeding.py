"""Tests for reproducible seeding (C4) and data-sufficiency gates (C5)."""

import numpy as np
from dsr import block_bootstrap
from seeding import DEFAULT_SEED, seed_all
from walk_forward import BACKTEST_SYMBOLS, run_walk_forward


def test_default_seed_is_deterministic_int():
    assert isinstance(DEFAULT_SEED, int)
    assert DEFAULT_SEED >= 0


def test_seed_all_pins_global_rngs():
    seed_all(DEFAULT_SEED)
    a = np.random.random()
    seed_all(DEFAULT_SEED)
    b = np.random.random()
    assert a == b


def test_block_bootstrap_reproducible_with_seed():
    returns = np.random.randn(50)

    seed_all(11)
    r1 = block_bootstrap(returns, n_resamples=20, block_size=5)
    seed_all(11)
    r2 = block_bootstrap(returns, n_resamples=20, block_size=5)
    np.testing.assert_array_equal(r1, r2)


def test_walk_forward_reproducible_with_same_seed(sample_market_data, sample_bounds):
    seed_all(7)
    s1 = run_walk_forward(
        sample_market_data,
        BACKTEST_SYMBOLS,
        sample_bounds,
        num_parameter_sets=20,
        num_windows=2,
    )
    seed_all(7)
    s2 = run_walk_forward(
        sample_market_data,
        BACKTEST_SYMBOLS,
        sample_bounds,
        num_parameter_sets=20,
        num_windows=2,
    )
    assert s1.pbo_score == s2.pbo_score
    assert s1.stability_score == s2.stability_score
    assert len(s1.results) == len(s2.results)
    for r1, r2 in zip(s1.results, s2.results, strict=True):
        assert r1.optimal_params == r2.optimal_params
        assert r1.train_sharpe == r2.train_sharpe
        assert r1.test_sharpe == r2.test_sharpe
        assert r1.dsr == r2.dsr


def test_walk_forward_differs_with_different_seed(sample_market_data, sample_bounds):
    seed_all(1)
    s1 = run_walk_forward(
        sample_market_data,
        BACKTEST_SYMBOLS,
        sample_bounds,
        num_parameter_sets=20,
        num_windows=2,
    )
    seed_all(2)
    s2 = run_walk_forward(
        sample_market_data,
        BACKTEST_SYMBOLS,
        sample_bounds,
        num_parameter_sets=20,
        num_windows=2,
    )
    params1 = [r.optimal_params for r in s1.results]
    params2 = [r.optimal_params for r in s2.results]
    assert params1 != params2
