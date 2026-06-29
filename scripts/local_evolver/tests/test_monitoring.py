"""Tests for monitoring.py module."""

import numpy as np
from models import DriftResult
from monitoring import compute_psi, detect_drift


def test_compute_psi_identical():
    returns = np.random.randn(200)
    psi = compute_psi(returns, returns)
    assert psi < 0.01


def test_compute_psi_different():
    a = np.random.randn(200)
    b = np.random.randn(200) * 2 + 1
    psi = compute_psi(a, b)
    assert psi > 0.0


def test_detect_drift_no_drift():
    returns = np.random.randn(200)
    result = detect_drift(returns, returns[-50:], psi_threshold=0.25, ks_threshold=0.05)
    assert isinstance(result, DriftResult)
    assert result.psi < 0.25


def test_detect_drift_insufficient():
    returns = np.random.randn(3)
    result = detect_drift(returns, np.array([0.1]))
    assert result.alert is False
