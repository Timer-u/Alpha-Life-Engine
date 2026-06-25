"""Tests for regime.py module."""

import numpy as np
import pytest
import torch

from regime import (
    compute_equal_weighted_returns,
    extract_regime_features,
    detect_regimes,
    _hysteresis_smooth,
)
from models import RegimeResult


def test_compute_equal_weighted_returns(sample_market_data):
    returns = compute_equal_weighted_returns(sample_market_data, ["511360", "511880"])
    assert len(returns) > 0


def test_compute_equal_weighted_returns_missing(sample_market_data):
    returns = compute_equal_weighted_returns(sample_market_data, ["INVALID"])
    assert len(returns) == 0


def test_extract_regime_features(sample_market_data):
    features = extract_regime_features(sample_market_data, ["511360", "511880"], lookback=20)
    if len(features) > 0:
        assert features.shape[1] == 2


def test_hysteresis_smooth():
    labels = np.array([0, 0, 1, 1, 0, 0, 1, 1, 0, 0])
    smoothed = _hysteresis_smooth(labels, window=3)
    assert len(smoothed) == len(labels)
    assert all(s in [0, 1] for s in smoothed)


def test_detect_regimes(sample_market_data):
    result = detect_regimes(
        sample_market_data, ["511360", "511880", "000300", "000905", "000922"],
        lookback=20, n_states=3, hysteresis_window=5,
    )
    assert isinstance(result, RegimeResult)
    assert result.current_regime in [0, 1, 2]
    assert result.regime_label in ["Bull", "Sideways", "Bear"]
    assert len(result.regime_probs) == 3
