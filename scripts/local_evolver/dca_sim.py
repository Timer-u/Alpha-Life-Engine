"""DCA (dollar-cost-averaging) cash-flow simulator.

This models the real Alpha-Life strategy: a fixed monthly contribution
accumulates in the safe layer, earning the safe-layer return while it waits,
and is pushed into the ambition layer when the pool balance crosses the
trigger line *and* the price-derived signal approves.

Signal mapping (a documented modeling choice — questions of fidelity are P1):

  Build an ambition composite price series from `ambition_allocation` weights.
  For trading day t the moving averages use ONLY data in ``[.., t-1]`` —
  there is zero lookahead:

    ma_short[t] = mean(composite[t - ma_short_window : t])
    ma_long[t]  = mean(composite[t - ma_long_window : t])
    panic_ratio[t] = ma_long[t] / composite[t]

  A long MA requires a FULL window: when fewer than ``ma_long_window`` prior
  bars exist the long MA is undefined, so the day is treated as neutral
  ``NORMAL`` (no trade signal) instead of averaging a short history — a short
  window would bias the MA toward whatever the early bars happened to be.

  Signal classification is pure price structure — ``bsm_threshold`` is NOT
  used here (mirroring the TS engine, where the signal type arrives from
  outside the decision logic):

    - ``ma_short[t] < ma_long[t] and p[t] < ma_short[t]`` → ``SKIP`` (confirmed downtrend)
    - ``panic_ratio[t] > 1`` (price below long trend)    → ``BSM``, signal_value = panic_ratio
    - otherwise                                          → ``NORMAL``

Decision branches mirror ``makeTriggerDecision`` in ``src/lib/trigger-engine.ts``:

  - ``balance < trigger_line``                    → DEFER (money stays in safe layer)
  - ``SKIP`` signal                               → SKIP (money stays in safe layer)
  - ``BSM`` with signal_value >= bsm_threshold    → EXECUTE
  - ``NORMAL`` / ``DOUBLE``                       → EXECUTE
  - ``BSM`` with signal_value <  bsm_threshold    → DEFER

  Because classification is threshold-free, the ``BSM < bsm_threshold``
  branch is reachable (it was dead code when the type was derived from the
  same threshold): a high threshold makes panic days defer, so it genuinely
  changes execution timing.

A-share trading rules (P1, all configurable):
  - Contributions settle T+1: day-t contribution is pending (not earning,
    not spendable) until day t+1.
  - ETF buys settle T+1: cash leaves on the trade day, shares are credited
    and start earning on the next day.
  - 100-share lot rounding at execution price close*(1+spread/2); leftover
    cash stays in the safe layer; commission charged on actual notional.
    The ambition layer is credited at FAIR VALUE (shares * close): the
    spread paid above close is a realized cost, not a subsidy into the
    higher-yield layer.
  - Limit-up days (return >= price_limit) skip execution (cannot fill).

On EXECUTE the executed amount equals the trigger line and is split
``safe_amount = executed * safe_ratio``, ``ambition_amount = executed *
ambition_ratio``. Exchange-traded-equity commission (C3) is charged on the
actual trade notional — the ambition leg only, since the money-fund safe leg
is ~zero cost:

    commission = max(ambition_amount * etf_bps / 10000, etf_min_yuan)   # yuan

Objective / TWR: the portfolio receives external cash inflows, so raw
value-change returns would be money-weighted and not comparable across
parameter sets. We unitize: contributions on day ``t`` are priced at the
day-``t`` unit value (new units issued at prevailing NAV) and therefore do
not distort the daily unit-value return series, which we return for the
existing Sharpe/DSR machinery.

Known modeling choice (P1, documented): under the default monthly
contribution (1000 yuan / 21 trading days) the pool's accumulation speed is
below the trigger line, so bsm_threshold changes execution TIMING but not
the execution COUNT (liquidity-ceiling saturation). Raising the monthly
contribution or lowering the trigger line makes the count responsive.
"""

import numpy as np
from models import DcaConfig, StrategyParameterSet, TransactionCostConfig


class DcaOutcome:
    """Result of a DCA simulation over ``[start, end]``."""

    def __init__(
        self,
        returns: np.ndarray,
        num_executions: int,
        total_commission: float,
        final_nav: float,
    ) -> None:
        self.returns = returns
        self.num_executions = num_executions
        self.total_commission = total_commission
        self.final_nav = final_nav


class DecisionOutcome:
    """Mirror of the TS trigger decision on a single day."""

    def __init__(
        self,
        decision: str,
        executed_amount: float = 0.0,
        safe_amount: float = 0.0,
        ambition_amount: float = 0.0,
    ) -> None:
        self.decision = decision
        self.executed_amount = executed_amount
        self.safe_amount = safe_amount
        self.ambition_amount = ambition_amount


def compute_commission(notional: float, cost_config: TransactionCostConfig) -> float:
    """Commission in yuan on a real trade notional.

    ``max(notional * etf_bps / 10000, etf_min_yuan)`` — the yuan floor is
    never divided by trade notional (that was the C3 defect).
    """
    if notional <= 0.0:
        return 0.0
    proportional = notional * cost_config.etf_bps / 10000.0
    return float(max(proportional, cost_config.etf_min_yuan))


def compute_signal_at(
    ambition_prices: np.ndarray,
    params: StrategyParameterSet,
    t: int,
) -> tuple[str, float, float]:
    """Return ``(signal_type, signal_value, panic_ratio)`` at day ``t``.

    Moving averages at day ``t`` use price data strictly before ``t``
    (window ``[.., t-1]``) — not day ``t`` itself: zero lookahead.

    ``bsm_threshold`` is deliberately NOT consulted here: classification is
    pure price structure (``panic_ratio > 1`` → ``BSM`` candidate). The
    threshold gates EXECUTE vs DEFER inside ``compute_decision``, mirroring
    ``src/lib/trigger-engine.ts`` where the signal type arrives from outside.
    """
    price_t = float(ambition_prices[t])
    if t < max(params.ma_short_window, params.ma_long_window):
        return "NORMAL", 1.0, 1.0

    ma_short = float(np.mean(ambition_prices[t - params.ma_short_window : t]))
    ma_long = float(np.mean(ambition_prices[t - params.ma_long_window : t]))
    anchor = max(ma_long, 1e-12)
    panic_ratio = anchor / price_t if price_t > 1e-12 else 1.0

    if ma_short < ma_long and price_t < ma_short:
        return "SKIP", panic_ratio, panic_ratio
    if panic_ratio > 1.0:
        return "BSM", panic_ratio, panic_ratio
    return "NORMAL", panic_ratio, panic_ratio


def compute_signal_series(
    ambition_prices: np.ndarray,
    params: StrategyParameterSet,
) -> tuple[list[str], np.ndarray, np.ndarray]:
    """Per-day signal classification over the whole price series."""
    types: list[str] = []
    values = np.empty(len(ambition_prices))
    panics = np.empty(len(ambition_prices))
    for t in range(len(ambition_prices)):
        sig_type, sig_value, panic = compute_signal_at(ambition_prices, params, t)
        types.append(sig_type)
        values[t] = sig_value
        panics[t] = panic
    return types, values, panics


def compute_decision(
    balance: float,
    signal_type: str,
    signal_value: float,
    params: StrategyParameterSet,
) -> DecisionOutcome:
    """Mirror ``makeTriggerDecision`` (src/lib/trigger-engine.ts)."""
    if balance < params.trigger_line:
        return DecisionOutcome(decision="DEFER", safe_amount=balance)
    if signal_type == "SKIP":
        return DecisionOutcome(decision="SKIP", safe_amount=balance)
    if signal_type == "BSM" and signal_value < params.bsm_threshold:
        return DecisionOutcome(decision="DEFER", safe_amount=balance)

    executed = float(params.trigger_line)
    return DecisionOutcome(
        decision="EXECUTE",
        executed_amount=executed,
        safe_amount=executed * params.safe_ratio,
        ambition_amount=executed * params.ambition_ratio,
    )


def simulate_dca(
    safe_returns: np.ndarray,
    ambition_returns: np.ndarray,
    ambition_prices: np.ndarray,
    params: StrategyParameterSet,
    cost_config: TransactionCostConfig,
    dca_config: DcaConfig,
    start: int,
    end: int,
) -> DcaOutcome:
    """Run the DCA simulator over days ``[start, end]`` (inclusive).

    Returned series are daily returns of the unitized (TWR) unit value,
    ready to feed ``compute_sharpe_ratio`` / DSR.
    """
    if start < 0 or end < start:
        msg = f"invalid window start={start}, end={end}"
        raise ValueError(msg)

    n_min = min(len(safe_returns), len(ambition_returns), len(ambition_prices))
    if end >= n_min:
        msg = f"end={end} out of range (max index {n_min - 1})"
        raise ValueError(msg)

    freq = max(1, dca_config.contribution_freq_days)
    length = end - start + 1

    safe_cash = 0.0
    pending_safe = 0.0
    ambition_value = 0.0
    pending_ambition = 0.0
    units = 0.0
    nav_prev = 1.0
    num_executions = 0
    total_commission = 0.0

    returns = np.empty(length)
    for idx, t in enumerate(range(start, end + 1)):
        # T+1 结算：昨日定投/买入今日到账，并开始参与收益
        safe_cash += pending_safe
        pending_safe = 0.0
        ambition_value += pending_ambition
        pending_ambition = 0.0

        safe_cash *= 1.0 + float(safe_returns[t])
        ambition_value *= 1.0 + float(ambition_returns[t])

        if (t - start) % freq == 0:
            nav_now = (
                (safe_cash + pending_safe + ambition_value + pending_ambition) / units
                if units > 0
                else 1.0
            )
            new_units = dca_config.monthly_contribution / nav_now
            pending_safe += dca_config.monthly_contribution
            units += new_units

        sig_type, sig_value, _ = compute_signal_at(ambition_prices, params, t)
        decision = compute_decision(
            safe_cash + ambition_value, sig_type, sig_value, params
        )

        if decision.decision == "EXECUTE":
            if float(ambition_returns[t]) >= dca_config.price_limit:
                pass  # 涨停无法成交，跳过
            else:
                # 买入按 ask 价成交：spread 摊到买卖两侧，单边支付一半
                exec_price = float(ambition_prices[t]) * (
                    1.0 + cost_config.etf_spread / 2.0
                )
                lot = dca_config.lot_size
                shares = int(decision.ambition_amount // exec_price // lot) * lot
                actual = shares * exec_price
                commission = (
                    compute_commission(actual, cost_config) if shares > 0 else 0.0
                )
                if shares > 0 and safe_cash >= actual + commission:
                    safe_cash -= actual + commission
                    fair = shares * float(ambition_prices[t])
                    pending_ambition += fair
                    num_executions += 1
                    total_commission += commission

        nav = (
            (safe_cash + pending_safe + ambition_value + pending_ambition) / units
            if units > 0
            else nav_prev
        )
        returns[idx] = nav / nav_prev - 1.0 if nav_prev > 0 else 0.0
        nav_prev = nav

    return DcaOutcome(
        returns=returns,
        num_executions=num_executions,
        total_commission=total_commission,
        final_nav=float(nav_prev),
    )
