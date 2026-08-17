"""Tests for dca_sim.py — DCA decision branches, signal mapping, commission, TWR."""

import dataclasses

import numpy as np
import pytest
from dca_sim import (
    compute_commission,
    compute_decision,
    compute_signal_at,
    compute_signal_series,
    simulate_dca,
)
from models import DcaConfig, StrategyParameterSet, TransactionCostConfig

TRIGGER = 1667
SAFE_RATIO = 0.6
AMBITION_RATIO = 0.4


def _params(
    bsm_threshold: float = 1.4, trigger_line: int = TRIGGER
) -> StrategyParameterSet:
    return StrategyParameterSet(
        trigger_line=trigger_line,
        safe_ratio=SAFE_RATIO,
        ambition_ratio=AMBITION_RATIO,
        bsm_threshold=bsm_threshold,
        ma_short_window=5,
        ma_long_window=20,
    )


def _cost(
    *, bps: float = 3.0, min_yuan: float = 5.0, spread: float = 0.002
) -> TransactionCostConfig:
    return TransactionCostConfig(etf_bps=bps, etf_min_yuan=min_yuan, etf_spread=spread)


def _dca(monthly: float = 1000.0, freq: int = 21) -> DcaConfig:
    return DcaConfig(monthly_contribution=monthly, contribution_freq_days=freq)


# ============================================================================
# C3 — commission on real trade notional
# ============================================================================
def test_commission_charged_on_notional_with_bps_floor_and_min():
    cost = _cost()
    assert compute_commission(300, cost) == pytest.approx(5.0)
    assert compute_commission(10_000, cost) == pytest.approx(5.0)
    assert compute_commission(200_000, cost) == pytest.approx(60.0)


def test_commission_zero_when_floor_disabled():
    cost = _cost(min_yuan=0.0)
    assert compute_commission(300, cost) == pytest.approx(0.09, abs=1e-9)
    assert compute_commission(0.0, cost) == pytest.approx(0.0)


def test_commission_zero_bps_charges_nothing():
    cost = _cost(bps=0.0, min_yuan=0.0)
    assert compute_commission(666.8, cost) == pytest.approx(0.0)


# ============================================================================
# C2 — decision branches mirroring src/lib/trigger-engine.ts makeTriggerDecision
# ============================================================================
def test_decision_defer_when_balance_below_trigger():
    d = compute_decision(1000.0, "NORMAL", 1.0, _params())
    assert d.decision == "DEFER"
    assert d.executed_amount == 0.0


def test_decision_skip_when_signal_skip():
    d = compute_decision(TRIGGER + 10.0, "SKIP", 1.0, _params())
    assert d.decision == "SKIP"


def test_decision_execute_bsm_when_threshold_met():
    p = _params(bsm_threshold=1.4)
    d = compute_decision(TRIGGER, "BSM", 2.0, p)
    assert d.decision == "EXECUTE"
    assert d.executed_amount == TRIGGER
    assert d.safe_amount == pytest.approx(TRIGGER * SAFE_RATIO)
    assert d.ambition_amount == pytest.approx(TRIGGER * AMBITION_RATIO)


def test_decision_defer_bsm_below_threshold():
    p = _params(bsm_threshold=1.4)
    d = compute_decision(TRIGGER, "BSM", 1.0, p)
    assert d.decision == "DEFER"


def test_decision_execute_normal_and_double():
    for signal in ("NORMAL", "DOUBLE"):
        d = compute_decision(TRIGGER, signal, 1.0, _params())
        assert d.decision == "EXECUTE"


def test_decision_defer_bsm_even_above_balance_when_value_below_threshold():
    d = compute_decision(TRIGGER + 5000.0, "BSM", 1.0, _params(1.4))
    assert d.decision == "DEFER"


# ============================================================================
# C2 — lookahead-free signal derivation
# ============================================================================
def test_signal_ma_uses_only_priorto_t_data():
    prices = np.arange(1.0, 201.0)
    p = _params()
    t = 70
    sig_type, sig_value, panic = compute_signal_at(prices, p, t)
    expected_ma_short = float(prices[t - 5 : t].mean())
    expected_ma_long = float(prices[t - 20 : t].mean())
    expected_panic = expected_ma_long / float(prices[t])
    assert panic == pytest.approx(expected_panic)
    assert sig_value == pytest.approx(expected_panic)
    assert sig_type in ("BSM", "SKIP", "NORMAL")


def test_signal_bsm_when_price_deep_under_long_trend():
    prices = np.concatenate([np.full(40, 100.0), np.full(10, 40.0)])
    p = _params()
    sig_type, sig_value, _ = compute_signal_at(prices, p, 45)
    # Full ma_long window [25:45] = (15*100 + 5*40)/20 = 85.0; panic = 85/40 = 2.125.
    # 40 bars @100 then 10 bars @40; at t=45 the short MA has collapsed to 40 so
    # price == ma_short (not SKIP), and panic > 1 classifies as BSM.
    assert sig_type == "BSM"
    assert sig_value == pytest.approx(85.0 / 40.0)


def test_signal_neutral_until_full_long_window_available():
    prices = np.concatenate([np.full(40, 100.0), np.full(10, 40.0)])
    p = _params()
    sig_type, sig_value, panic = compute_signal_at(prices, p, p.ma_long_window - 1)
    assert sig_type == "NORMAL"
    assert sig_value == 1.0
    assert panic == 1.0
    sig_type, _, _ = compute_signal_at(prices, p, p.ma_long_window)
    assert sig_type == "NORMAL"  # t=20 still trades at 100 → panic = 1, no signal
    sig_type, sig_value, _ = compute_signal_at(prices, p, 40)
    assert sig_type == "BSM"
    assert sig_value == pytest.approx(100.0 / 40.0)


def test_signal_skip_in_confirmed_downtrend():
    prices = np.arange(100.0, 20.0, -1.0)
    p = _params()
    sig_type, _, _ = compute_signal_at(prices, p, 40)
    assert sig_type == "SKIP"


def test_signal_normal_when_no_extreme():
    prices = np.full(80, 100.0)
    p = _params()
    sig_type, _, _ = compute_signal_at(prices, p, 40)
    assert sig_type == "NORMAL"


def test_signal_series_length_and_values():
    prices = np.arange(1.0, 101.0)
    p = _params()
    types, values, panics = compute_signal_series(prices, p)
    assert len(types) == len(prices)
    assert values.shape == (len(prices),)
    assert panics.shape == (len(prices),)
    assert all(t in ("BSM", "SKIP", "NORMAL") for t in types)


# ============================================================================
# C2 — DCA simulation, TWR unitization, costs deducted from cash
# ============================================================================
def test_simulate_dca_twr_flat_market_no_cost():
    length = 200
    flat = np.zeros(length)
    prices = np.ones(length)
    p = _params()
    out = simulate_dca(
        flat,
        flat,
        prices,
        p,
        _cost(bps=0.0, min_yuan=0.0, spread=0.0),
        _dca(),
        0,
        length - 1,
    )
    assert len(out.returns) == length
    assert float(np.max(np.abs(out.returns))) < 1e-12
    assert out.num_executions > 0


def test_simulate_dca_commission_deducted_from_cash():
    length = 200
    flat = np.zeros(length)
    prices = np.ones(length)
    p = _params()
    out = simulate_dca(flat, flat, prices, p, _cost(), _dca(), 0, length - 1)
    assert out.num_executions > 0
    assert out.total_commission == pytest.approx(5.0 * out.num_executions)
    assert float(np.min(out.returns)) < 0.0
    assert out.final_nav > 0.0


def test_simulate_dca_rejects_out_of_range():
    short = np.zeros(10)
    prices = np.ones(11)
    p = _params()
    with pytest.raises(ValueError, match="out of range"):
        simulate_dca(short, short, prices, p, _cost(), _dca(), 0, 10)


def test_simulate_dca_trigger_and_bsm_change_execution_timing():
    length = 300
    rng = np.random.default_rng(7)
    amb_returns = rng.normal(0.0001, 0.01, length)
    amb_prices = np.cumprod(1 + amb_returns)
    safe_returns = np.zeros(length)
    # A large monthly contribution keeps safe_cash liquid so execution COUNT is
    # gated by signal/trigger decisions, not by available cash. At the default
    # 1000/month the number of executions saturates the same liquidity ceiling
    # for every bsm_threshold, making the parameter look like a no-op.
    dca = _dca(monthly=5000.0)

    p_trigger = _params(trigger_line=1000)
    p_trigger_high = _params(trigger_line=2400)
    o1 = simulate_dca(
        safe_returns, amb_returns, amb_prices, p_trigger, _cost(), dca, 0, length - 1
    )
    o2 = simulate_dca(
        safe_returns,
        amb_returns,
        amb_prices,
        p_trigger_high,
        _cost(),
        dca,
        0,
        length - 1,
    )
    assert o1.num_executions != o2.num_executions

    p_bsm_lo = dataclasses.replace(p_trigger, bsm_threshold=1.0)
    p_bsm_hi = dataclasses.replace(p_trigger, bsm_threshold=2.0)
    o3 = simulate_dca(
        safe_returns, amb_returns, amb_prices, p_bsm_lo, _cost(), dca, 0, length - 1
    )
    o4 = simulate_dca(
        safe_returns, amb_returns, amb_prices, p_bsm_hi, _cost(), dca, 0, length - 1
    )
    assert o3.num_executions != o4.num_executions


def test_execution_uses_lot_rounding_and_spread_price():
    length = 120
    flat = np.zeros(length)
    prices = np.ones(length) * 4.05
    p = _params()
    dca = _dca(monthly=2000.0)
    out = simulate_dca(flat, flat, prices, p, _cost(bps=300.0), dca, 0, length - 1)
    assert out.num_executions > 0
    # 执行价 = 4.05 * (1 + 0.002/2) = 4.05405
    # 整手: floor(666.8 / 4.05405 / 100) * 100 = 100 股 → actual = 405.405
    # 佣金 = max(405.405 * 3%, 5) = 12.16215/笔（3% 佣金使整手差异被放大）
    per_exec = 4.05 * 1.001 * 100 * 0.03
    assert out.total_commission == pytest.approx(
        per_exec * out.num_executions, rel=1e-9
    )


def test_spread_is_realized_cost_not_ambition_subsidy():
    # 与上面同市场/参数，唯一差异是 etf_spread。佣金归零以隔离价差效应：
    # 修复前 pending_ambition += actual（价差又回流进取层）→ 两种 spread 下
    # final_nav 相等；修复后进取层按 fair value 入账 → 价差成为已实现成本，
    # final_nav(spread=0.002) 严格低于 final_nav(spread=0.0)。
    length = 120
    flat = np.zeros(length)
    prices = np.ones(length) * 4.05
    p = _params()
    dca = _dca(monthly=2000.0)
    out_spread = simulate_dca(
        flat, flat, prices, p, _cost(bps=0.0, min_yuan=0.0, spread=0.002), dca, 0, length - 1
    )
    out_flat = simulate_dca(
        flat, flat, prices, p, _cost(bps=0.0, min_yuan=0.0, spread=0.0), dca, 0, length - 1
    )
    assert out_spread.num_executions > 0
    assert out_spread.num_executions == out_flat.num_executions
    assert out_spread.final_nav < out_flat.final_nav


def test_execution_skipped_on_limit_up():
    length = 31  # 窗口在第 30 天（涨停日）结束：价格尖峰不会波及后续执行
    flat = np.zeros(length)
    limit_returns = np.zeros(length)
    limit_returns[30] = 0.10  # 涨停日（也是窗口最后一天）
    flat_prices = np.ones(length)
    limit_prices = np.cumprod(1 + limit_returns)
    p = _params()
    dca = _dca(monthly=10000.0)  # 大月供保证第 30 天余额 >= 触发线（非涨停日会执行）
    out_ctrl = simulate_dca(flat, flat, flat_prices, p, _cost(), dca, 0, length - 1)
    out_lim = simulate_dca(
        flat, limit_returns, limit_prices, p, _cost(), dca, 0, length - 1
    )
    # 两条路径现金流完全一致，唯一差异是第 30 天涨停 → 恰好少 1 次执行
    assert out_lim.num_executions == out_ctrl.num_executions - 1


def test_execution_settles_t_plus_1_not_same_day():
    length = 30
    flat = np.zeros(length)
    amb_returns = np.zeros(length)
    amb_returns[1] = 0.05  # 次日尖峰：当日结算（旧行为）会吃到，T+1 结算错过
    amb_prices = np.cumprod(1 + amb_returns)
    p = _params(trigger_line=1000)
    dca = DcaConfig(monthly_contribution=5000.0, contribution_freq_days=1)
    out = simulate_dca(
        flat,
        amb_returns,
        amb_prices,
        p,
        _cost(bps=0.0, min_yuan=0.0, spread=0.0),
        dca,
        0,
        length - 1,
    )
    assert out.num_executions >= 1
    # 零成本 + 平直市场 + T+1：nav 恒为 1.0 → 全零收益序列。
    # 旧实现第 0 天定投当日可执行（买入后持有过第 1 天尖峰）→ returns[1] ≈ +0.6% ≠ 0
    assert float(np.max(np.abs(out.returns))) < 1e-12
