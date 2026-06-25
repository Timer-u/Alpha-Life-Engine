"""Tests for walk_forward.py module."""

import numpy as np
import pytest

from walk_forward import (
    generate_walk_forward_windows,
    generate_random_parameter_sets,
    extract_returns_for_symbols,
    compute_portfolio_returns_for_params,
    score_parameter_set,
    _compute_pbo,
    run_walk_forward,
)
from models import MarketDataInput, DataFrame, StrategyParameterBounds, StrategyParameterSet


def test_generate_walk_forward_windows():
    windows = generate_walk_forward_windows(total_obs=252, num_windows=6, train_ratio=0.7)
    assert len(windows) <= 6
    for w in windows:
        assert w.train_end > w.train_start
        assert w.test_end >= w.test_start
        assert w.train_start >= 0


def test_generate_walk_forward_windows_insufficient():
    with pytest.raises(ValueError):
        generate_walk_forward_windows(total_obs=50, num_windows=6)


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


def test_extract_returns_for_symbols(sample_market_data):
    returns = extract_returns_for_symbols(sample_market_data, ["511360", "511880"])
    assert len(returns) == 2
    assert all(len(r) > 0 for r in returns)
    assert all(len(r) == len(returns[0]) for r in returns)


def test_extract_returns_for_symbols_missing(sample_market_data):
    returns = extract_returns_for_symbols(sample_market_data, ["511360", "INVALID"])
    assert len(returns) == 2
    assert len(returns[0]) > 0
    assert np.all(returns[1] == 0)


def test_compute_portfolio_returns_for_params(sample_market_data, sample_params):
    returns = extract_returns_for_symbols(sample_market_data, ["511360", "511880", "000300", "000905", "000922"])
    rets = compute_portfolio_returns_for_params(
        ["511360", "511880", "000300", "000905", "000922"],
        returns, 0, 100, sample_params
    )
    assert len(rets) == 101


def test_score_parameter_set(sample_market_data, sample_params):
    returns = extract_returns_for_symbols(sample_market_data, ["511360", "511880", "000300", "000905", "000922"])
    score = score_parameter_set(["511360", "511880", "000300", "000905", "000922"], returns, 0, 100, sample_params)
    assert isinstance(score, float)


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
        ["511360", "511880", "000300", "000905", "000922"],
        sample_bounds,
        num_parameter_sets=50,
        num_windows=3,
    )
    assert 0.0 <= summary.pbo_score <= 1.0
    assert summary.stability_score >= 0.0
    assert len(summary.results) == 3
    assert len(summary.pbo_ranking_matrix) == 3