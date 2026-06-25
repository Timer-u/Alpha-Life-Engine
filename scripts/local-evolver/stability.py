"""Parameter stability check via per-parameter neighborhood gradient.

Perturbs each parameter individually (up/down) and measures:
  gradient_i = |score_up - score_base| / |param_up - param_base|

Averages all gradients and compares against threshold.
This prevents sensitivity in individual parameters from being masked
by cancellation in simultaneous random perturbations.
"""

import copy

import numpy as np

from dsr import compute_sharpe_ratio
from models import MarketDataInput, StabilityReport, StrategyParameterSet
from walk_forward import compute_portfolio_returns_for_params, extract_returns_for_symbols


def _perturb_weights(
    weights: dict[str, float],
    symbol: str,
    delta: float,
) -> dict[str, float]:
    result = dict(weights)
    current = result.get(symbol, 0.0)
    adjusted = max(0.0, min(1.0, current + delta))
    result[symbol] = adjusted

    other_keys = [k for k in result if k != symbol]
    other_total = sum(result[k] for k in other_keys)
    diff = adjusted - current

    if other_total > 0 and len(other_keys) > 0:
        for k in other_keys:
            result[k] = result[k] - diff * (result[k] / other_total)

    total = sum(result.values())
    if total > 0:
        for k in result:
            result[k] /= total

    return result


def check_stability(
    data: MarketDataInput,
    symbols: list[str],
    params: StrategyParameterSet,
    neighborhood_radius: float = 0.05,
    gradient_threshold: float = 0.1,
    risk_free_rate: float = 0.0,
    test_ratio: float = 0.3,
) -> StabilityReport:
    all_rets = extract_returns_for_symbols(data, symbols)
    if not all_rets:
        return StabilityReport(gradient=1.0, threshold=gradient_threshold, is_stable=False)

    total_obs = len(all_rets[0])
    test_start = int(total_obs * (1 - test_ratio))
    test_end = total_obs - 1

    base_rets = compute_portfolio_returns_for_params(
        symbols, all_rets, test_start, test_end, params,
    )
    base_sharpe = compute_sharpe_ratio(base_rets, risk_free_rate) if len(base_rets) >= 5 else -1.0

    neighborhood_sharpes: list[float] = [base_sharpe]
    gradients: list[float] = []

    # Scalar parameters
    scalar_params: list[tuple[str, float | int]] = [
        ("trigger_line", params.trigger_line),
        ("safe_ratio", params.safe_ratio),
        ("ambition_ratio", params.ambition_ratio),
        ("bsm_threshold", params.bsm_threshold),
        ("ma_short_window", params.ma_short_window),
        ("ma_long_window", params.ma_long_window),
    ]

    for _name, base_val in scalar_params:
        if base_val == 0:
            continue
        if isinstance(base_val, int):
            perturb = max(1, int(abs(base_val) * neighborhood_radius))
        else:
            perturb = max(neighborhood_radius, abs(base_val) * neighborhood_radius)
        if perturb == 0:
            continue

        p_up = copy.deepcopy(params)
        new_val_up = base_val + perturb
        if isinstance(base_val, int):
            setattr(p_up, _name, int(round(new_val_up)))
        else:
            setattr(p_up, _name, new_val_up)
        pr_up = compute_portfolio_returns_for_params(
            symbols, all_rets, test_start, test_end, p_up,
        )
        score_up = compute_sharpe_ratio(pr_up, risk_free_rate) if len(pr_up) >= 5 else -1.0
        neighborhood_sharpes.append(score_up)
        gradients.append(abs(score_up - base_sharpe) / perturb)

        p_down = copy.deepcopy(params)
        new_val_down = max(0, base_val - perturb)
        if isinstance(base_val, int):
            setattr(p_down, _name, int(round(new_val_down)))
        else:
            setattr(p_down, _name, new_val_down)
        pr_down = compute_portfolio_returns_for_params(
            symbols, all_rets, test_start, test_end, p_down,
        )
        score_down = compute_sharpe_ratio(pr_down, risk_free_rate) if len(pr_down) >= 5 else -1.0
        neighborhood_sharpes.append(score_down)
        gradients.append(abs(score_down - base_sharpe) / perturb)

    # Allocation weights
    for sym in params.safe_allocation:
        base_w = params.safe_allocation[sym]
        delta = max(neighborhood_radius, abs(base_w) * neighborhood_radius)

        p_up = copy.deepcopy(params)
        p_up.safe_allocation = _perturb_weights(p_up.safe_allocation, sym, delta)
        pr_up = compute_portfolio_returns_for_params(
            symbols, all_rets, test_start, test_end, p_up,
        )
        score_up = compute_sharpe_ratio(pr_up, risk_free_rate) if len(pr_up) >= 5 else -1.0
        neighborhood_sharpes.append(score_up)
        gradients.append(abs(score_up - base_sharpe) / delta)

        p_down = copy.deepcopy(params)
        p_down.safe_allocation = _perturb_weights(p_down.safe_allocation, sym, -delta)
        pr_down = compute_portfolio_returns_for_params(
            symbols, all_rets, test_start, test_end, p_down,
        )
        score_down = compute_sharpe_ratio(pr_down, risk_free_rate) if len(pr_down) >= 5 else -1.0
        neighborhood_sharpes.append(score_down)
        gradients.append(abs(score_down - base_sharpe) / delta)

    for sym in params.ambition_allocation:
        base_w = params.ambition_allocation[sym]
        delta = max(neighborhood_radius, abs(base_w) * neighborhood_radius)

        p_up = copy.deepcopy(params)
        p_up.ambition_allocation = _perturb_weights(p_up.ambition_allocation, sym, delta)
        pr_up = compute_portfolio_returns_for_params(
            symbols, all_rets, test_start, test_end, p_up,
        )
        score_up = compute_sharpe_ratio(pr_up, risk_free_rate) if len(pr_up) >= 5 else -1.0
        neighborhood_sharpes.append(score_up)
        gradients.append(abs(score_up - base_sharpe) / delta)

        p_down = copy.deepcopy(params)
        p_down.ambition_allocation = _perturb_weights(p_down.ambition_allocation, sym, -delta)
        pr_down = compute_portfolio_returns_for_params(
            symbols, all_rets, test_start, test_end, p_down,
        )
        score_down = compute_sharpe_ratio(pr_down, risk_free_rate) if len(pr_down) >= 5 else -1.0
        neighborhood_sharpes.append(score_down)
        gradients.append(abs(score_down - base_sharpe) / delta)

    avg_gradient = np.mean(gradients) if gradients else 1.0

    return StabilityReport(
        gradient=float(avg_gradient),
        threshold=gradient_threshold,
        is_stable=bool(avg_gradient < gradient_threshold),
        neighborhood_sharpe_ratios=neighborhood_sharpes,
    )
