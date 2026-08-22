"""Tests for cpcv.py module."""

import numpy as np
import pytest
from cpcv import (
    apply_fold_to_returns,
    compute_cpcv_result,
    compute_portfolio_returns,
    compute_returns_from_prices,
    generate_cpcv_folds,
)
from models import CpcvFold, MarketDataInput


def test_generate_cpcv_folds_basic():
    folds = generate_cpcv_folds(
        total_obs=252, num_groups=10, num_test_groups=2, num_splits=5
    )
    # 5 个不同测试组组合 → 5 折，不再静默塌缩
    assert len(folds) == 5
    for fold in folds:
        assert fold.train_length() > 0
        assert fold.test_length() >= 5


def test_generate_cpcv_folds_no_collapse_seed42_regression():
    """2026-08-22 审计回归：seed 42、total_obs=3295、10 组、2 测试组、10 splits
    旧实现只存活 2 折且 test 全为 [2966, 3289]（min/max 折叠 + 越界夹取静默丢折）。"""
    folds = generate_cpcv_folds(
        total_obs=3295, num_groups=10, num_test_groups=2, num_splits=10
    )
    assert len(folds) == 10
    # 测试窗互不相同（每折是不同组的并集）
    test_windows = {tuple(f.test_segments) for f in folds}
    assert len(test_windows) == 10
    # 每折 test 总长 = 2 组
    for fold in folds:
        assert fold.test_length() == 2 * (3295 // 10)
    # train 段不与任何 test 段重叠，且紧邻 test 的 train 段按 purge/embargo 裁剪
    for fold in folds:
        for tlo, thi in fold.test_segments:
            for rlo, rhi in fold.train_segments:
                assert rhi < tlo or rlo > thi


def test_generate_cpcv_folds_disjoint_test_groups_stay_disjoint():
    """非连续测试组（如组 0 和组 5）必须保留两段，不折叠成 min/max 大区间。"""
    folds = generate_cpcv_folds(
        total_obs=1000, num_groups=10, num_test_groups=2, num_splits=45
    )
    disjoint = [f for f in folds if len(f.test_segments) == 2]
    assert disjoint, "expected at least one fold with non-adjacent test groups"
    for fold in disjoint:
        first_hi = fold.test_segments[0][1]
        second_lo, _ = fold.test_segments[1]
        assert first_hi + 1 < second_lo  # 中间的组属于 train（purge/embargo 裁剪后）
        assert fold.train_length() > 0


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
    returns = compute_portfolio_returns(
        sample_market_data, ["511360", "511880"], weights
    )
    assert len(returns) > 0


def test_compute_portfolio_returns_missing_symbol(sample_market_data):
    weights = {"511360": 0.5, "INVALID": 0.5}
    returns = compute_portfolio_returns(
        sample_market_data, ["511360", "INVALID"], weights
    )
    assert len(returns) > 0


def test_apply_fold_to_returns():
    returns = np.random.normal(0.001, 0.02, 200)
    fold = CpcvFold(train_segments=[(0, 99)], test_segments=[(105, 150)])
    train, test = apply_fold_to_returns(returns, fold)
    assert len(train) == 100
    assert len(test) == 46


def test_compute_cpcv_result(sample_market_data, sample_params):
    folds = generate_cpcv_folds(
        total_obs=499, num_groups=10, num_test_groups=2, num_splits=5
    )
    weights = sample_params.safe_allocation
    result = compute_cpcv_result(
        sample_market_data, ["511360", "511880"], weights, folds
    )
    assert result.dsr >= 0.0
    assert len(result.fold_sharpe_ratios) <= len(folds)


def test_compute_cpcv_result_empty():
    empty_data = MarketDataInput(symbols={})
    folds = [CpcvFold(train_segments=[(0, 10)], test_segments=[(15, 20)])]
    result = compute_cpcv_result(empty_data, [], {}, folds)
    assert result.dsr == 0.0


def test_compute_returns_from_prices_invalid_prices():
    assert len(compute_returns_from_prices([100.0, 0.0, 110.0])) == 0
    assert len(compute_returns_from_prices([100.0, -5.0, 110.0])) == 0
    assert len(compute_returns_from_prices([100.0, float("nan"), 110.0])) == 0
    assert len(compute_returns_from_prices([100.0, float("inf"), 110.0])) == 0
