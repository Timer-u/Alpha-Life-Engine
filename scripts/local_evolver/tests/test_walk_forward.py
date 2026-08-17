"""Tests for walk_forward.py module."""

import dataclasses

import numpy as np
import pytest
from constants import MIN_OBS_FOR_SHARPE
from models import DataFrame, DcaConfig, MarketDataInput, TransactionCostConfig
from walk_forward import (
    BACKTEST_SYMBOLS,
    INVALID_SCORE,
    _compute_pbo,
    _weighted_composite,
    check_data_sufficiency,
    compute_portfolio_returns_for_params,
    extract_prices_for_symbols,
    extract_returns_for_symbols,
    generate_random_parameter_sets,
    generate_walk_forward_windows,
    resolve_backtest_symbols,
    run_walk_forward,
    score_parameter_set,
)


def _df(dates: list[str], closes: list[float]) -> DataFrame:
    return DataFrame(
        dates=list(dates),
        close=list(closes),
        open=[],
        high=[],
        low=[],
        volume=[],
    )


def test_generate_walk_forward_windows():
    windows = generate_walk_forward_windows(
        total_obs=1500, num_windows=6, train_ratio=0.7
    )
    assert len(windows) <= 6
    for w in windows:
        assert w.train_end > w.train_start
        assert w.test_end >= w.test_start
        assert w.test_end - w.test_start + 1 >= MIN_OBS_FOR_SHARPE


def test_generate_walk_forward_windows_insufficient():
    with pytest.raises(ValueError):
        generate_walk_forward_windows(total_obs=200, num_windows=6)


def test_generate_random_parameter_sets(sample_bounds):
    sets = generate_random_parameter_sets(sample_bounds, 10)
    assert len(sets) == 10
    for s in sets:
        assert 1000 <= s.trigger_line <= 3000
        assert 0.3 <= s.safe_ratio <= 0.8
        assert 0.2 <= s.ambition_ratio <= 0.7
        assert abs(s.safe_ratio + s.ambition_ratio - 1.0) < 1e-6
        assert 5 <= s.ma_short_window <= 50
        assert s.ma_long_window > s.ma_short_window
        assert abs(sum(s.safe_allocation.values()) - 1.0) < 1e-6
        assert abs(sum(s.ambition_allocation.values()) - 1.0) < 1e-6


def test_extract_prices_for_symbols_aligned(sample_market_data):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    assert len(prices) == len(BACKTEST_SYMBOLS)
    assert all(len(p) == len(prices[0]) for p in prices)
    assert len(prices[0]) == 500


def _six_symbol_df(
    n_days: int = 100,
    late_safe_start: int | None = None,
    late_ambition_start: int | None = None,
) -> MarketDataInput:
    dates = [f"2023-{i // 30 + 1:02d}-{i % 30 + 1:02d}" for i in range(n_days)]
    symbols: dict[str, DataFrame] = {}
    for i, sym in enumerate(BACKTEST_SYMBOLS):
        sym_dates = dates
        if sym == "511360" and late_safe_start is not None:
            sym_dates = dates[late_safe_start:]
        if sym == "515080" and late_ambition_start is not None:
            sym_dates = dates[late_ambition_start:]
        price = 100.0 + i
        symbols[sym] = _df(sym_dates, [price] * len(sym_dates))
    return MarketDataInput(symbols=symbols)


def test_extract_prices_union_join_pads_late_listings():
    data = _six_symbol_df(n_days=100, late_safe_start=30, late_ambition_start=50)
    prices = extract_prices_for_symbols(data, BACKTEST_SYMBOLS)
    assert len(prices) == len(BACKTEST_SYMBOLS)
    # 两层均最早从第 0 天有数据（511880/511990/510300/510500 全量）→ 主索引 100 天
    assert len(prices[0]) == 100
    idx_511360 = BACKTEST_SYMBOLS.index("511360")
    assert np.isnan(prices[idx_511360][:30]).all()
    assert np.isfinite(prices[idx_511360][30:]).all()
    idx_515080 = BACKTEST_SYMBOLS.index("515080")
    assert np.isnan(prices[idx_515080][:50]).all()
    assert np.isfinite(prices[idx_515080][50:]).all()


def test_extract_prices_union_join_truncates_before_both_layers_exist():
    # 进取层全部第 30 天才上市 → 主索引起点 = 第 30 天（两层都可用之后）
    dates = [f"2023-{i // 30 + 1:02d}-{i % 30 + 1:02d}" for i in range(100)]
    symbols: dict[str, DataFrame] = {}
    for i, sym in enumerate(BACKTEST_SYMBOLS):
        sym_dates = dates[30:] if sym in ("510300", "510500", "515080") else dates
        price = 100.0 + i
        symbols[sym] = _df(sym_dates, [price] * len(sym_dates))
    prices = extract_prices_for_symbols(
        MarketDataInput(symbols=symbols), BACKTEST_SYMBOLS
    )
    assert len(prices[0]) == 70
    for p in prices:
        assert np.isfinite(p).all()


def test_weighted_composite_chain_linked_no_entry_jump():
    # 旧实现重标定价格水平：515080 上市日（~1.0 元）会瞬间拉低进取层水平线
    # （510300/510500 为 4-6 元）→ 组合出现虚假的 ~15% 单日下跌。
    # 修复后按收益率加权 + 链式复利：新上市标的在其上市日无 t-1 价格 → 被剔除，
    # 组合收益只反映在位标的 → 构造性无跳变。
    all_prices = [
        np.array([1.0, 1.0, 1.0, 1.0]),  # X：第 0 天就在位
        np.array([np.nan, np.nan, 5.0, 5.5]),  # Y：第 2 天才上市（价位 5.0）
    ]
    symbols = ["X", "Y"]
    indices = [0, 1]
    weights = {"X": 0.5, "Y": 0.5}
    composite = _weighted_composite(all_prices, symbols, indices, weights)
    # 第 0 天为锚点：nav = 1.0
    assert composite[0] == pytest.approx(1.0)
    # 第 1 天仅 X 有收益率（0%）→ nav 不变
    assert composite[1] == pytest.approx(1.0)
    # 第 2 天 Y 上市：X 收益率有限、Y 无 t-1 → 只按 X 加权 → 仍无跳变
    # （旧实现价格水平 = 0.5*1 + 0.5*5 = 3.0，会突兀跳升）
    assert composite[2] == pytest.approx(1.0)
    # 第 3 天两者均有收益率 → r = 0.5*0 + 0.5*(5.5/5 - 1) = 0.05 → nav = 1.05
    assert composite[3] == pytest.approx(1.05)
    # 链式一致性：nav[t]/nav[t-1] - 1 == 当日加权收益率
    assert composite[3] / composite[2] - 1.0 == pytest.approx(0.05)
    # 所有可用权重均为 0 → 返回 NaN，绝不静默输出 0 复合水平
    zero = _weighted_composite(all_prices, symbols, [0], {"Y": 1.0})
    assert zero[0] == pytest.approx(1.0)
    assert np.isnan(zero[1:]).all()


def test_extract_prices_for_symbols_inner_joins_on_dates():
    a = _df(
        ["2023-01-01", "2023-01-02", "2023-01-03", "2023-01-04"],
        [10.0, 11.0, 12.0, 13.0],
    )
    b = _df(
        ["2023-01-02", "2023-01-03", "2023-01-04", "2023-01-05"],
        [5.0, 6.0, 7.0, 8.0],
    )
    prices = extract_prices_for_symbols(
        MarketDataInput(symbols={"A": a, "B": b}), ["A", "B"]
    )
    assert len(prices) == 2
    assert len(prices[0]) == 3
    np.testing.assert_allclose(prices[0], [11.0, 12.0, 13.0])
    np.testing.assert_allclose(prices[1], [5.0, 6.0, 7.0])


def test_extract_prices_for_symbols_missing_raises(sample_market_data):
    with pytest.raises(ValueError, match="no close data"):
        extract_prices_for_symbols(sample_market_data, ["000300", "INVALID"])


def test_extract_returns_for_symbols(sample_market_data):
    returns = extract_returns_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    assert len(returns) == len(BACKTEST_SYMBOLS)
    assert all(len(r) == len(returns[0]) for r in returns)
    assert len(returns[0]) == 500


def test_check_data_sufficiency_rejects_short_series():
    dates = [f"2023-01-{d:02d}" for d in range(1, 21)]
    data = MarketDataInput(symbols={"000300": _df(dates, [1.0] * 20)})
    with pytest.raises(ValueError, match="000300"):
        check_data_sufficiency(data, ["000300"], min_obs=MIN_OBS_FOR_SHARPE)


def test_resolve_backtest_symbols_missing_proxy_raises():
    data = MarketDataInput(symbols={})
    with pytest.raises(ValueError, match="missing"):
        resolve_backtest_symbols(data, list(BACKTEST_SYMBOLS))


def test_compute_portfolio_returns_for_params(sample_market_data, sample_params):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    rets = compute_portfolio_returns_for_params(
        BACKTEST_SYMBOLS,
        prices,
        0,
        100,
        sample_params,
        cost_config=TransactionCostConfig(),
        dca_config=DcaConfig(),
    )
    assert len(rets) == 101


def test_score_parameter_set(sample_market_data, sample_params):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    score = score_parameter_set(
        BACKTEST_SYMBOLS,
        prices,
        0,
        199,
        sample_params,
        cost_config=TransactionCostConfig(),
        dca_config=DcaConfig(),
    )
    assert isinstance(score, float)
    assert score != INVALID_SCORE


def test_score_parameter_set_too_short_returns_invalid(
    sample_market_data, sample_params
):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    score = score_parameter_set(
        BACKTEST_SYMBOLS,
        prices,
        0,
        30,
        sample_params,
    )
    assert score == INVALID_SCORE


def test_all_six_params_affect_score(sample_market_data, sample_params):
    prices = extract_prices_for_symbols(sample_market_data, BACKTEST_SYMBOLS)
    cost = TransactionCostConfig()
    dca = DcaConfig()
    base = sample_params
    start, end = 0, 399

    base_score = score_parameter_set(
        BACKTEST_SYMBOLS, prices, start, end, base, cost_config=cost, dca_config=dca
    )
    assert base_score != INVALID_SCORE

    variants = [
        dataclasses.replace(base, trigger_line=base.trigger_line + 500),
        # The fixture's panic ratios peak ~1.09, so raising the threshold is a
        # no-op; lowering it to 1.0 lets panic days (1.0 < panic < 1.4) execute
        # that the default defers — bsm_threshold must change outcomes.
        dataclasses.replace(base, bsm_threshold=max(1.0, base.bsm_threshold - 0.4)),
        dataclasses.replace(base, ma_short_window=base.ma_short_window + 5),
        dataclasses.replace(base, ma_long_window=base.ma_long_window + 20),
        # 0.49/0.51 crosses a 100-share lot boundary at fixture prices (~4.2):
        # amount 850.17 -> 200 shares vs base 666.8 -> 100 shares. A small
        # split delta (0.55/0.45) is absorbed by lot rounding (Task 3).
        dataclasses.replace(base, safe_ratio=0.49, ambition_ratio=0.51),
        dataclasses.replace(base, safe_allocation={"511880": 0.5, "511990": 0.5}),
    ]
    for variant in variants:
        score = score_parameter_set(
            BACKTEST_SYMBOLS,
            prices,
            start,
            end,
            variant,
            cost_config=cost,
            dca_config=dca,
        )
        assert np.isfinite(score), (
            f"parameter variant produced non-finite score: {variant}"
        )
        assert score != base_score, f"parameter variant had no effect: {variant}"


def test_compute_pbo():
    train_ranks = [[1, 2, 3], [2, 1, 3], [3, 2, 1]]
    test_ranks = [[2, 1, 3], [1, 3, 2], [3, 1, 2]]
    pbo, matrix = _compute_pbo(train_ranks, test_ranks)
    assert 0.0 <= pbo <= 1.0
    assert len(matrix) == 3
    assert all(len(row) == 2 for row in matrix)


def test_run_walk_forward(sample_market_data, sample_bounds):
    summary = run_walk_forward(
        sample_market_data,
        BACKTEST_SYMBOLS,
        sample_bounds,
        num_parameter_sets=50,
        num_windows=2,
    )
    assert 0.0 <= summary.pbo_score <= 1.0
    assert summary.stability_score >= 0.0
    assert len(summary.results) == 2
    assert len(summary.pbo_ranking_matrix) == 2


def test_run_walk_forward_insufficient_data_raises(sample_bounds):
    data = MarketDataInput(
        symbols={"000300": _df([f"2023-01-{d:02d}" for d in range(1, 10)], [1.0] * 9)}
    )
    with pytest.raises(ValueError):
        run_walk_forward(
            data,
            BACKTEST_SYMBOLS,
            sample_bounds,
            num_parameter_sets=5,
            num_windows=2,
        )


def test_generate_walk_forward_windows_purge_embargo():
    windows = generate_walk_forward_windows(
        total_obs=1320, num_windows=6, train_ratio=0.7, purge_days=5, embargo_days=5
    )
    assert len(windows) == 6
    w0 = windows[0]
    # gap_span = (5+5)*5 = 50; (1320-50)//6 = 211/折 → train 147, test 64
    # w0: train_end = 146, purge 后 141; test_start = 146+1+5 = 152; test_end = 215
    assert w0.train_start == 0
    assert w0.train_end == 141
    assert w0.test_start == 152
    assert w0.test_end == 215
    for w in windows:
        assert w.test_end - w.test_start + 1 >= MIN_OBS_FOR_SHARPE
        # purge/embargo: test 与 train 尾部有间隔
        assert w.test_start > w.train_end + 1


def test_generate_walk_forward_windows_resizes_when_gaps_overflow():
    # 500 obs、2 窗口、gap 各 5：原始跨度 250*2+10=510 > 500 → 缩为 (500-10)//2=245
    windows = generate_walk_forward_windows(
        total_obs=500, num_windows=2, train_ratio=0.7, purge_days=5, embargo_days=5
    )
    assert len(windows) == 2
    # w0: test_start = 170+1+5 = 176, test_end = 249
    # w1: ws = 245, train_end = 415, purge 后 410; test_start = 421, test_end = 494
    assert windows[0].test_end == 249
    assert windows[1].test_end == 494


def test_generate_walk_forward_windows_gap_too_large_raises():
    with pytest.raises(ValueError):
        generate_walk_forward_windows(
            total_obs=500,
            num_windows=2,
            train_ratio=0.7,
            purge_days=80,
            embargo_days=80,
        )


def test_generate_walk_forward_windows_purge_exceeds_train():
    # purge=150 >= train_size=119 → 训练窗口被整体清除，必须报错
    with pytest.raises(ValueError, match="purge"):
        generate_walk_forward_windows(
            total_obs=500,
            num_windows=2,
            train_ratio=0.7,
            purge_days=150,
            embargo_days=10,
        )
