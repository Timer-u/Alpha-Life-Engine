"""Tests for dsr.py statistical functions."""

import numpy as np
from dsr import (
    annualize_return,
    annualize_volatility,
    compute_dsr,
    compute_kurtosis,
    compute_sharpe_ratio,
    compute_skewness,
    normal_cdf,
    normal_inv_cdf,
)


def test_compute_sharpe_ratio_basic():
    returns = np.array([0.01, 0.02, -0.01, 0.015, -0.005])
    sr = compute_sharpe_ratio(returns, risk_free_rate=0.0)
    assert isinstance(sr, float)
    assert sr > 0


def test_compute_sharpe_ratio_zero_std():
    returns = np.array([0.01, 0.01, 0.01, 0.01])
    sr = compute_sharpe_ratio(returns, risk_free_rate=0.0)
    assert sr == 0.0


def test_compute_sharpe_ratio_insufficient_data():
    returns = np.array([0.01])
    sr = compute_sharpe_ratio(returns, risk_free_rate=0.0)
    assert sr == 0.0


def test_compute_skewness():
    returns = np.array([0.01, 0.02, -0.01, 0.015, -0.005, 0.03, -0.02])
    skew = compute_skewness(returns)
    assert isinstance(skew, float)


def test_compute_skewness_insufficient_data():
    returns = np.array([0.01, 0.02])
    skew = compute_skewness(returns)
    assert skew == 0.0


def test_compute_kurtosis():
    returns = np.array([0.01, 0.02, -0.01, 0.015, -0.005, 0.03, -0.02, 0.01])
    kurt = compute_kurtosis(returns)
    assert isinstance(kurt, float)


def test_compute_kurtosis_insufficient_data():
    returns = np.array([0.01, 0.02, 0.03])
    kurt = compute_kurtosis(returns)
    assert kurt == 0.0


def test_annualize_return():
    daily = 0.001
    annual = annualize_return(daily, 252)
    expected = (1.0 + daily) ** 252 - 1.0
    assert abs(annual - expected) < 1e-10


def test_annualize_volatility():
    daily_std = 0.01
    annual_vol = annualize_volatility(daily_std, 252)
    expected = daily_std * np.sqrt(252)
    assert abs(annual_vol - expected) < 1e-10


def test_normal_cdf():
    assert abs(normal_cdf(0.0) - 0.5) < 1e-6
    assert normal_cdf(1.96) > 0.97
    assert normal_cdf(-1.96) < 0.03


def test_normal_inv_cdf():
    assert abs(normal_inv_cdf(0.5)) < 1e-6
    assert abs(normal_inv_cdf(0.975) - 1.96) < 0.02
    assert normal_inv_cdf(0.0) == float("-inf")
    assert normal_inv_cdf(1.0) == float("inf")


def test_compute_dsr_basic():
    sharpe = 1.0
    n = 252
    dsr = compute_dsr(sharpe, n, skewness=0.0, alpha=0.05, excess_kurtosis=0.0)
    assert 0.0 <= dsr <= 1.0


def test_compute_dsr_high_sharpe():
    sharpe = 3.0
    n = 252
    dsr = compute_dsr(sharpe, n, skewness=0.0, alpha=0.05, excess_kurtosis=0.0)
    assert dsr > 0.99


def test_compute_dsr_insufficient_data():
    dsr = compute_dsr(1.0, 1, skewness=0.0, alpha=0.05, excess_kurtosis=0.0)
    assert dsr == 0.0


def test_compute_dsr_negative_denominator():
    sharpe = 10.0
    n = 252
    dsr = compute_dsr(sharpe, n, skewness=10.0, alpha=0.05, excess_kurtosis=0.0)
    assert dsr == 0.0
