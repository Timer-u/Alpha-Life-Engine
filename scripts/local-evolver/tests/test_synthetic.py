"""Tests for synthetic.py module."""

import torch
import pytest

from models import SyntheticScenarioResult
from synthetic import (
    generate_fat_tails,
    generate_regime_shift,
    generate_corr_breakdown,
    run_all_scenarios,
)


def test_generate_fat_tails(device):
    prices = torch.tensor([100.0, 200.0], device=device)
    mean_returns = torch.tensor([0.0003, 0.0004], device=device)
    cov = torch.tensor([[0.0004, 0.0001], [0.0001, 0.0006]], device=device)
    weights = torch.tensor([0.5, 0.5], device=device)

    result = generate_fat_tails(prices, mean_returns, cov, weights, days=50, n_paths=50, device=device)
    assert isinstance(result, SyntheticScenarioResult)
    assert result.scenario == "fat_tails"
    assert result.n_paths == 50


def test_generate_regime_shift(device):
    prices = torch.tensor([100.0, 200.0], device=device)
    mean_returns = torch.tensor([0.0003, 0.0004], device=device)
    cov = torch.tensor([[0.0004, 0.0001], [0.0001, 0.0006]], device=device)
    weights = torch.tensor([0.5, 0.5], device=device)

    result = generate_regime_shift(prices, mean_returns, cov, weights, days=50, n_paths=50, shift_day=25, device=device)
    assert isinstance(result, SyntheticScenarioResult)
    assert result.scenario == "regime_shift"


def test_generate_corr_breakdown(device):
    prices = torch.tensor([100.0, 200.0], device=device)
    mean_returns = torch.tensor([0.0003, 0.0004], device=device)
    cov = torch.tensor([[0.0004, 0.0001], [0.0001, 0.0006]], device=device)
    weights = torch.tensor([0.5, 0.5], device=device)

    result = generate_corr_breakdown(prices, mean_returns, cov, weights, days=50, n_paths=50, breakdown_day=25, device=device)
    assert isinstance(result, SyntheticScenarioResult)
    assert result.scenario == "corr_breakdown"
