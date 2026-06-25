"""Tests for monte_carlo.py module."""

import numpy as np
import pytest
import torch

from monte_carlo import (
    cholesky_decomposition,
    covariance_to_correlation,
    generate_correlated_gbm_paths,
    compute_max_drawdown,
    compute_portfolio_path_returns,
    compute_monte_carlo_summary,
    run_monte_carlo,
)
from models import CVaRResult, DrawdownAnalytics, MarketDataInput, DataFrame, PortfolioWeights, MonteCarloResult


def test_cholesky_decomposition_psd(device):
    matrix = torch.tensor([[1.0, 0.5], [0.5, 1.0]], device=device)
    L = cholesky_decomposition(matrix)
    assert torch.allclose(L @ L.T, matrix, atol=1e-5)


def test_cholesky_decomposition_non_psd(device):
    matrix = torch.tensor([[1.0, 1.5], [1.5, 1.0]], device=device)
    L = cholesky_decomposition(matrix)
    assert L.shape == (2, 2)
    assert torch.isfinite(L).all()


def test_covariance_to_correlation(device):
    cov = torch.tensor([[0.04, 0.02], [0.02, 0.01]], device=device)
    corr, std = covariance_to_correlation(cov)
    assert corr.shape == (2, 2)
    assert torch.allclose(corr.diag(), torch.ones(2, device=device))
    assert torch.allclose(std, torch.tensor([0.2, 0.1], device=device))


def test_generate_correlated_gbm_paths(device):
    initial = torch.tensor([100.0, 200.0], device=device)
    returns = torch.tensor([0.1, 0.15], device=device)
    vols = torch.tensor([0.2, 0.25], device=device)
    cov = torch.tensor([[0.04, 0.01], [0.01, 0.0625]], device=device)

    paths = generate_correlated_gbm_paths(initial, returns, vols, cov, days=10, num_paths=100, device=device)
    assert paths.shape == (100, 11, 2)
    assert torch.allclose(paths[:, 0, :], initial.view(1, 2).expand(100, 2))
    assert (paths > 0).all()


def test_compute_max_drawdown():
    prices = torch.tensor([100.0, 110.0, 105.0, 120.0, 100.0, 130.0])
    mdd = compute_max_drawdown(prices)
    assert mdd <= 0.0
    assert abs(mdd - (-20.0/120.0)) < 0.01


def test_compute_portfolio_path_returns(device):
    paths = torch.rand(50, 20, 3, device=device).abs() + 100.0
    weights = torch.tensor([0.4, 0.3, 0.3], device=device)
    returns, values = compute_portfolio_path_returns(paths, weights)
    assert returns.shape == (50, 20)
    assert values.shape == (50, 20)
    assert torch.allclose(returns[:, 0], torch.zeros(50, device=device))


def test_compute_monte_carlo_summary(device):
    returns = torch.randn(1000, 252, device=device) * 0.01 + 0.0005
    values = torch.cumprod(1 + returns, dim=1) * 100
    summary, cvar, dd = compute_monte_carlo_summary(returns, values)
    assert summary.mean_return is not None
    assert summary.median_return is not None
    assert summary.std_return >= 0
    assert summary.var95 <= 0
    assert summary.max_drawdown <= 0
    assert cvar.cvar_95 <= 0
    assert cvar.cvar_99 <= 0
    assert dd.max_drawdown <= 0


def test_run_monte_carlo(sample_market_data):
    weights = PortfolioWeights(weights={"511360": 0.5, "511880": 0.5})
    initial_prices = [100.0, 100.0]
    result, cvar, dd = run_monte_carlo(sample_market_data, ["511360", "511880"], weights, initial_prices, days=10, num_paths=100)
    assert isinstance(result, MonteCarloResult)
    assert result.summary.mean_return is not None
    assert len(result.paths.dates) == 11
    assert isinstance(cvar, CVaRResult)
    assert isinstance(dd, DrawdownAnalytics)