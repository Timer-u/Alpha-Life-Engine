"""Tests for cpcv.py module."""

import numpy as np
import pytest

from cpcv import (
    generate_cpcv_folds,
    compute_returns_from_prices,
    compute_portfolio_returns,
    apply_fold_to_returns,
    compute_cpcv_result,
)
from models import CpcvFold, MarketDataInput, DataFrame


def test_generate_cpcv_folds_basic():
    folds = generate_cpcv_folds(total_obs=252, num_groups=10, num_test_groups=2, num_splits=5)
    assert len(folds) <= 5
    for fold in folds:
        assert fold.train_end > fold.train_start
        assert fold.test_end >= fold.test_start


def test_generate_cpcv_folds_insufficient_data():
    with pytest.raises(ValueError):
        generate_cpcv_folds(total_obs=5, num_groups=10)


def test_compute_returns_from_prices():
    prices = [100.0, 101.0, 102.0, 101.0, 103.0]
    returns = compute_returns_from_prices(prices)
    assert len(returns) == len(prices) - 1
    expected = np.array([0.01, 0.0099, -0.0098, 0.0198])
    np.testing.assert_allclose(returns, expected, rtol=1e-3)


def test_compute_portfolio_returns(sample_market_data):
    weights = {"511360": 0.5, "511880": 0.5}
    returns = compute_portfolio_returns(sample_market_data, ["511360", "511880"], weights)
    assert len(returns) > 0


def test_compute_portfolio_returns_missing_symbol(sample_market_data):
    weights = {"511360": 0.5, "INVALID": 0.5}
    returns = compute_portfolio_returns(sample_market_data, ["511360", "INVALID"], weights)
    assert len(returns) > 0


def test_apply_fold_to_returns():
    returns = np.random.normal(0.001, 0.02, 200)
    fold = CpcvFold(train_start=0, train_end=99, test_start=105, test_end=150)
    train, test = apply_fold_to_returns(returns, fold)
    assert len(train) == 100
    assert len(test) == 46


def test_compute_cpcv_result(sample_market_data, sample_params):
    folds = generate_cpcv_folds(total_obs=499, num_groups=10, num_test_groups=2, num_splits=5)
    weights = sample_params.safe_allocation
    result = compute_cpcv_result(sample_market_data, ["511360", "511880"], weights, folds)
    assert result.dsr >= 0.0
    assert len(result.fold_sharpe_ratios) <= len(folds)


def test_compute_cpcv_result_empty():
    from models import MarketDataInput
    empty_data = MarketDataInput(symbols={})
    folds = [CpcvFold(train_start=0, train_end=10, test_start=15, test_end=20)]
    result = compute_cpcv_result(empty_data, [], {}, folds)
    assert result.dsr == 0.0