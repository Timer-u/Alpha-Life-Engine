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


def test_bootstrap_ci_max_drawdown_on_monotonic_up_series():
    """2026-08-22 审计回归：净值单调上涨的真实最大回撤为 0。

    旧实现在日收益率序列上直接 accumulate，把"距历史最佳单日收益的
    距离"当回撤，实测 0% 回撤序列报 mean max_drawdown ≈ −52.8%。
    """
    returns = np.full(100, 0.001)  # 每日 +0.1%，净值单调上升
    result = bootstrap_ci(returns, n_resamples=20, block_size=5)
    md = result["max_drawdown"]
    assert md["mean"] == 0.0
    assert md["ci_95"] == [0.0, 0.0]
    assert md["ci_99"] == [0.0, 0.0]


def test_bootstrap_ci_max_drawdown_matches_nav_definition():
    """max_drawdown 应等于各 bootstrap 样本净值曲线最深回撤（负值口径）。

    同 seed 复现 block_bootstrap 的样本，逐样本按 (peak-trough)/peak 定义
    解析计算，与 bootstrap_ci 报告的 mean 逐一相等。
    """
    returns = np.concatenate([
        np.full(5, 0.02),
        np.full(5, -0.10),
        np.full(5, 0.02),
    ])

    def _nav_max_dd(sample: np.ndarray) -> float:
        nav = np.cumprod(1.0 + sample)
        peak = np.maximum.accumulate(nav)
        return float(-np.max((peak - nav) / peak))

    rng_expected = np.random.default_rng(7)
    boot = block_bootstrap(returns, n_resamples=6, block_size=5, rng=rng_expected)
    expected_mean = float(np.mean([_nav_max_dd(b) for b in boot]))

    rng_actual = np.random.default_rng(7)
    result = bootstrap_ci(returns, n_resamples=6, block_size=5, rng=rng_actual)
    assert result["max_drawdown"]["mean"] == pytest.approx(expected_mean)
    assert result["max_drawdown"]["mean"] < 0.0
