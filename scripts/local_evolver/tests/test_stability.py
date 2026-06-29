"""Tests for stability.py module."""

from models import MarketDataInput, StrategyParameterSet
from stability import _perturb_weights, check_stability


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
    symbols = ["511360", "511880", "000300", "000905", "000922"]
    report = check_stability(sample_market_data, symbols, sample_params)
    assert report.gradient >= 0.0
    assert report.threshold > 0.0
    assert isinstance(report.is_stable, bool)
    assert len(report.neighborhood_sharpe_ratios) >= 2


def test_check_stability_empty_data():
    empty_data = MarketDataInput(symbols={})
    report = check_stability(empty_data, [], StrategyParameterSet())
    assert report.gradient == 1.0
    assert report.is_stable is False
