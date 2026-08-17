"""Tests for stability.py module."""

import pytest
from models import MarketDataInput, StrategyParameterSet
from stability import _perturb_split, _perturb_weights, check_stability
from walk_forward import BACKTEST_SYMBOLS


class TestPerturbSplit:
    def test_preserves_sum(self):
        for delta in (0.05, -0.05, 0.2, -0.2):
            s, a = _perturb_split(0.6, 0.4, delta)
            assert abs(s + a - 1.0) < 1e-9
            assert 0.0 <= s <= 1.0
            assert 0.0 <= a <= 1.0

    def test_shift_direction(self):
        s, a = _perturb_split(0.6, 0.4, 0.05)
        assert s == pytest.approx(0.65)
        assert a == pytest.approx(0.35)

    def test_clamp(self):
        s, a = _perturb_split(0.95, 0.05, 0.1)
        assert s == pytest.approx(1.0)
        assert a == pytest.approx(0.0)
        s, a = _perturb_split(0.05, 0.95, -0.1)
        assert s == pytest.approx(0.0)
        assert a == pytest.approx(1.0)


class TestPerturbWeights:
    def test_normal(self):
        weights = {"A": 0.5, "B": 0.5}
        perturbed = _perturb_weights(weights, "A", 0.1)
        assert set(perturbed.keys()) == set(weights.keys())
        assert abs(sum(perturbed.values()) - 1.0) < 1e-6
        assert all(v >= 0 for v in perturbed.values())

    def test_missing_symbol_creates_entry(self):
        perturbed = _perturb_weights({}, "A", 0.1)
        assert perturbed == {"A": 1.0}

    def test_negative_delta(self):
        weights = {"A": 0.8, "B": 0.2}
        perturbed = _perturb_weights(weights, "A", -0.3)
        assert perturbed["A"] >= 0.0
        assert abs(sum(perturbed.values()) - 1.0) < 1e-6

    def test_clamp_to_zero(self):
        weights = {"A": 0.01, "B": 0.99}
        perturbed = _perturb_weights(weights, "A", -0.1)
        assert perturbed["A"] >= 0.0
        assert abs(sum(perturbed.values()) - 1.0) < 1e-6

    def test_single_key(self):
        weights = {"A": 1.0}
        perturbed = _perturb_weights(weights, "A", 0.1)
        assert abs(perturbed["A"] - 1.0) < 1e-6


def test_check_stability(sample_market_data, sample_params):
    report = check_stability(sample_market_data, BACKTEST_SYMBOLS, sample_params)
    assert report.gradient >= 0.0
    assert report.threshold > 0.0
    assert isinstance(report.is_stable, bool)
    assert len(report.neighborhood_sharpe_ratios) >= 2


def test_check_stability_empty_data_raises():
    empty_data = MarketDataInput(symbols={})
    with pytest.raises(ValueError, match="backtest universe"):
        check_stability(empty_data, [], StrategyParameterSet())
