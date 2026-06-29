"""Tests for mpt.py module."""

import torch
from models import EvolverConfig
from mpt import (
    compute_covariance_matrix,
    compute_efficient_frontier,
    compute_mean_returns,
    evaluate_portfolio,
    extract_efficient_frontier,
    generate_random_portfolios,
)


def test_compute_mean_returns(sample_market_data, device):
    means = compute_mean_returns(sample_market_data, ["511360", "511880"], device)
    assert means.shape == (2,)
    assert torch.isfinite(means).all()


def test_compute_covariance_matrix(sample_market_data, device):
    cov = compute_covariance_matrix(sample_market_data, ["511360", "511880"], device)
    assert cov.shape == (2, 2)
    assert torch.allclose(cov, cov.T)
    assert torch.diagonal(cov).ge(0).all()


def test_generate_random_portfolios(device):
    weights = generate_random_portfolios(5, 100, device)
    assert weights.shape == (100, 5)
    assert torch.allclose(weights.sum(dim=1), torch.ones(100, device=device))
    assert (weights >= 0).all()


def test_evaluate_portfolio(device):
    mean_returns = torch.tensor([0.001, 0.002], device=device)
    cov_matrix = torch.tensor([[0.0001, 0.00005], [0.00005, 0.0002]], device=device)
    weights = torch.tensor([0.6, 0.4], device=device)
    exp_ret, vol, sharpe = evaluate_portfolio(weights, mean_returns, cov_matrix)
    assert isinstance(exp_ret.item(), float)
    assert isinstance(vol.item(), float)
    assert isinstance(sharpe.item(), float)


def test_extract_efficient_frontier(device):
    num_assets = 3
    weights = torch.rand(100, num_assets, device=device)
    weights = weights / weights.sum(dim=1, keepdim=True)
    mean_returns = torch.tensor([0.001, 0.0015, 0.0008], device=device)
    cov_matrix = torch.eye(num_assets, device=device) * 0.0001
    exp_returns, vols, sharpes = evaluate_portfolio(weights, mean_returns, cov_matrix)

    w_f, r_f, v_f, s_f = extract_efficient_frontier(
        weights, exp_returns, vols, sharpes, num_points=10
    )
    assert len(r_f) <= 10
    assert len(w_f) == len(r_f)
    assert torch.all(v_f[:-1] <= v_f[1:] + 1e-6)


def test_compute_efficient_frontier(sample_market_data, device):
    config = EvolverConfig(frontier_points=10)
    ef = compute_efficient_frontier(sample_market_data, ["511360", "511880"], config)
    assert len(ef.points) > 0
    assert ef.max_sharpe_portfolio is not None
    assert ef.min_vol_portfolio is not None
