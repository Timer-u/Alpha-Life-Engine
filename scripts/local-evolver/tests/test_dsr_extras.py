"""Tests for newly added dsr.py functions: haircut_sharpe, block_bootstrap, bootstrap_ci, sortino."""

import numpy as np
import pytest

from dsr import (
    block_bootstrap,
    bootstrap_ci,
    compute_haircut_sharpe,
    compute_sortino_ratio,
)


def test_compute_haircut_sharpe():
    sr = compute_haircut_sharpe(1.0, 200)
    assert sr < 1.0
    assert sr > 0.0
    sr_single = compute_haircut_sharpe(1.0, 1)
    assert sr_single == 1.0


def test_compute_sortino_ratio():
    returns = np.array([0.01, 0.02, -0.01, 0.005, -0.02, 0.015])
    sr = compute_sortino_ratio(returns, 0.0)
    assert isinstance(sr, float)


def test_compute_sortino_ratio_insufficient():
    returns = np.array([0.01])
    sr = compute_sortino_ratio(returns, 0.0)
    assert sr == 0.0


def test_block_bootstrap_shape():
    returns = np.random.randn(100)
    boot = block_bootstrap(returns, n_resamples=50, block_size=5)
    assert boot.shape == (50, 100)


def test_block_bootstrap_small_n():
    returns = np.random.randn(3)
    boot = block_bootstrap(returns, n_resamples=10, block_size=5)
    assert boot.shape == (10, 3)


def test_bootstrap_ci():
    returns = np.random.randn(200) * 0.01 + 0.0005
    result = bootstrap_ci(returns, n_resamples=50, block_size=5)
    assert "sharpe" in result
    assert "sortino" in result
    assert "max_drawdown" in result
    assert len(result["sharpe"]["ci_95"]) == 2
    assert len(result["sharpe"]["ci_99"]) == 2
    assert result["sharpe"]["ci_95"][0] <= result["sharpe"]["ci_95"][1]
