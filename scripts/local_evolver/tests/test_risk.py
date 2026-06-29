"""Tests for risk.py module."""

import torch
from models import MRCResult
from risk import compute_mrc


def test_compute_mrc(device):
    symbols = ["A", "B", "C"]
    weights = {"A": 0.4, "B": 0.3, "C": 0.3}
    cov = torch.tensor(
        [[0.04, 0.01, 0.005], [0.01, 0.06, 0.008], [0.005, 0.008, 0.05]], device=device
    )

    result = compute_mrc(weights, symbols, cov)
    assert isinstance(result, MRCResult)
    assert len(result.mrc) == 3
    assert abs(sum(result.mrc.values()) - 1.0) < 1e-4
    assert result.total_var > 0


def test_compute_mrc_zero_variance(device):
    symbols = ["A", "B"]
    weights = {"A": 0.5, "B": 0.5}
    cov = torch.zeros(2, 2, device=device)

    result = compute_mrc(weights, symbols, cov)
    assert result.total_var == 0.0
    assert all(v == 0.5 for v in result.mrc.values())
