"""Tests for sensitivity.py module."""

import numpy as np
from sensitivity import compute_sobol_indices


def _linear_model(X: np.ndarray) -> np.ndarray:
    return X[:, 0] * 2 + X[:, 1] * 0.5


def test_compute_sobol_indices_basic():
    param_names = ["x1", "x2"]
    bounds = np.array([[0.0, 1.0], [0.0, 1.0]])

    result = compute_sobol_indices(_linear_model, param_names, bounds, n=256)
    assert "first_order" in result
    assert "total_order" in result
    assert len(result["first_order"]) == 2
    assert result["first_order"]["x1"] > result["first_order"]["x2"]


def test_compute_sobol_indices_zero_var():
    def constant_model(X: np.ndarray) -> np.ndarray:
        return np.ones(X.shape[0])

    param_names = ["x1"]
    bounds = np.array([[0.0, 1.0]])

    result = compute_sobol_indices(constant_model, param_names, bounds, n=128)
    assert result["first_order"]["x1"] == 0.0
