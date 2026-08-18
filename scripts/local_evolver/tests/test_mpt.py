"""Tests for mpt.py module."""

import numpy as np
import pytest
import torch
from models import CpcvFold, DataFrame, EvolverConfig, MarketDataInput
from mpt import (
    compute_covariance_matrix,
    compute_efficient_frontier,
    compute_efficient_frontier_on_window,
    compute_efficient_frontier_with_cpcv,
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


def test_windowed_stats_use_cpcv_inclusive_slice(device):
    n = 12
    dates = [f"2023-01-{i + 1:02d}" for i in range(n)]
    data = MarketDataInput(
        symbols={
            "A": DataFrame(
                dates=dates,
                close=list(np.arange(1.0, n + 1)),
                open=[],
                high=[],
                low=[],
                volume=[],
            ),
            "B": DataFrame(
                dates=dates,
                close=list(np.arange(2.0, 2 * n + 1, 2.0)),
                open=[],
                high=[],
                low=[],
                volume=[],
            ),
        }
    )
    # rets[i] = (i+2)/(i+1) - 1 = 1/(i+1) for i in 0..n-2
    rets = np.arange(2.0, n + 1) / np.arange(1.0, n) - 1.0
    # Window slice must match cpcv.apply_fold_to_returns train convention:
    # rets[start : end+1] — start=0 must NOT drop rets[0], and rets[end]
    # (price end+1, inside the embargo gap) must be included.
    means = compute_mean_returns(data, ["A"], device, start=0, end=n - 1)
    assert means.cpu()[0].item() == pytest.approx(float(rets[0:n].mean()), rel=1e-5)
    means_mid = compute_mean_returns(data, ["A"], device, start=2, end=n - 1)
    assert means_mid.cpu()[0].item() == pytest.approx(float(rets[2:n].mean()), rel=1e-5)
    cov = compute_covariance_matrix(data, ["A", "B"], device, start=0, end=n - 1)
    expected_var = float(np.var(rets[0:n], ddof=1))
    assert cov[0, 0].item() == pytest.approx(expected_var, rel=1e-5)
    assert cov[0, 1].item() == pytest.approx(expected_var, rel=1e-5)


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


def _flat_df(dates: list[str], closes: list[float]) -> DataFrame:
    return DataFrame(
        dates=dates, close=list(closes), open=[], high=[], low=[], volume=[]
    )


def test_compute_mean_returns_windowed(sample_market_data, device):
    means_full = compute_mean_returns(sample_market_data, ["511360", "511880"], device)
    means_window = compute_mean_returns(
        sample_market_data, ["511360", "511880"], device, start=0, end=99
    )
    assert means_window.shape == (2,)
    assert torch.isfinite(means_window).all()
    assert not torch.allclose(means_full, means_window)


def test_frontier_weights_do_not_use_test_data():
    # A: 低波动温和正漂移; B: train 段高波动中等漂移、test 段 +5%/日暴涨
    # 逐折估计只看 train → 权重不会压向 B；全样本统计（旧实现）会看到暴涨 → w_B ≈ 1.0
    n = 400
    dates = [f"2023-{i // 30 + 1:02d}-{i % 30 + 1:02d}" for i in range(n)]
    rng = np.random.default_rng(11)
    a_closes = 100.0 * np.cumprod(1 + 0.0003 + rng.normal(0, 0.001, n))
    b_train = 100.0 * np.cumprod(1 + 0.001 + rng.normal(0, 0.01, 300))
    b_closes = np.concatenate([
        b_train,
        b_train[-1] * (1.05 ** np.arange(1, 101)),
    ])
    data = MarketDataInput(
        symbols={
            "A": _flat_df(dates, a_closes.tolist()),
            "B": _flat_df(dates, b_closes.tolist()),
        }
    )
    folds = [
        CpcvFold(train_start=0, train_end=199, test_start=200, test_end=399),
        CpcvFold(train_start=0, train_end=99, test_start=100, test_end=349),
    ]
    ef = compute_efficient_frontier_with_cpcv(
        data, ["A", "B"], folds, EvolverConfig(frontier_points=10)
    )
    assert ef.max_sharpe_portfolio is not None
    w_b = ef.max_sharpe_portfolio.weights.weights["B"]
    # train 段 A 的 Sharpe(≈0.2) 高于 B(≈0.09) → 切点组合偏好 A
    assert w_b <= 0.8
    assert ef.max_sharpe_portfolio.cpcv_result is not None
    assert ef.max_sharpe_portfolio.sharpe_ratio == pytest.approx(
        ef.max_sharpe_portfolio.cpcv_result.dsr
    )


def _a_b_regime_data() -> MarketDataInput:
    """A 前段涨后段跌；B 前段跌后段涨（波动率相同）。"""
    n = 300
    dates = [f"2023-{i // 30 + 1:02d}-{i % 30 + 1:02d}" for i in range(n)]
    rng = np.random.default_rng(5)
    vol = 0.001
    a_returns = np.concatenate([
        rng.normal(0.002, vol, 100),
        rng.normal(-0.002, vol, 100),
        rng.normal(0.0, vol, 100),
    ])
    b_returns = np.concatenate([
        rng.normal(-0.002, vol, 100),
        rng.normal(0.002, vol, 100),
        rng.normal(0.0, vol, 100),
    ])
    return MarketDataInput(
        symbols={
            "A": _flat_df(dates, (100.0 * np.cumprod(1 + a_returns)).tolist()),
            "B": _flat_df(dates, (100.0 * np.cumprod(1 + b_returns)).tolist()),
        }
    )


def test_per_fold_frontiers_follow_their_own_train_window():
    data = _a_b_regime_data()
    config = EvolverConfig(frontier_points=10)
    ef1 = compute_efficient_frontier_on_window(
        data, ["A", "B"], config, start=0, end=99
    )
    ef2 = compute_efficient_frontier_on_window(
        data, ["A", "B"], config, start=100, end=199
    )
    assert ef1.max_sharpe_portfolio is not None
    assert ef2.max_sharpe_portfolio is not None
    w_a1 = ef1.max_sharpe_portfolio.weights.weights["A"]
    w_b1 = ef1.max_sharpe_portfolio.weights.weights["B"]
    w_a2 = ef2.max_sharpe_portfolio.weights.weights["A"]
    w_b2 = ef2.max_sharpe_portfolio.weights.weights["B"]
    # 每折只看自己的 train 窗口：折1 前段 A 涨 B 跌 → 偏好 A；折2 后段反之 → 偏好 B
    assert w_a1 > w_b1
    assert w_b2 > w_a2


def test_cpcv_reports_latest_fold_frontier_and_oos_per_fold_sharpes():
    data = _a_b_regime_data()
    folds = [
        CpcvFold(train_start=0, train_end=99, test_start=150, test_end=199),
        CpcvFold(train_start=100, train_end=199, test_start=200, test_end=299),
    ]
    ef = compute_efficient_frontier_with_cpcv(
        data, ["A", "B"], folds, EvolverConfig(frontier_points=10)
    )
    assert ef.max_sharpe_portfolio is not None
    # 报告的 frontier = 最新折（test_end=299，train [100,199] 偏好 B）
    assert (
        ef.max_sharpe_portfolio.weights.weights["B"]
        > ef.max_sharpe_portfolio.weights.weights["A"]
    )
    # 逐折 OOS：fold1 的权重偏好 A，但其 test 窗口 [150,199] A 正在下跌 → 折1 Sharpe 为负；
    # fold2 权重偏好 B，其 test 窗口 [200,299] 两者都平 → ~0。逐折估计必然产生此差异。
    cpcv = ef.max_sharpe_portfolio.cpcv_result
    assert cpcv is not None
    assert len(cpcv.fold_sharpe_ratios) == 2
    assert cpcv.fold_sharpe_ratios[0] < cpcv.fold_sharpe_ratios[1]
    assert ef.max_sharpe_portfolio.sharpe_ratio == pytest.approx(cpcv.dsr)
