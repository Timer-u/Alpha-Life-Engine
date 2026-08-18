"""Parameter stability check via per-parameter neighborhood gradient.

Perturbs each parameter individually (up/down) and measures:
  gradient_i = |score_up - score_base| / |param_up - param_base|

Averages all gradients and compares against threshold.
This prevents sensitivity in individual parameters from being masked
by cancellation in simultaneous random perturbations.
"""

import copy
from collections.abc import Callable

import numpy as np
from constants import MIN_OBS_FOR_SHARPE
from dsr import compute_sharpe_ratio
from models import (
    DcaConfig,
    MarketDataInput,
    StabilityReport,
    StrategyParameterSet,
    TransactionCostConfig,
)
from walk_forward import (
    compute_portfolio_returns_for_params,
    extract_prices_for_symbols,
    resolve_backtest_symbols,
)

RHO_EPSILON = 1e-12


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


def _perturb_split(
    safe_ratio: float, ambition_ratio: float, delta: float
) -> tuple[float, float]:
    """Perturb the safe/ambition split while preserving their sum (=1).

    Perturbing either ratio alone breaks the sum constraint and silently
    tests leverage; perturbing the fraction rho = safe/(safe+ambition)
    keeps the split on the simplex.
    """
    total = safe_ratio + ambition_ratio
    if total <= 0:
        return safe_ratio, ambition_ratio
    rho = safe_ratio / total
    new_rho = min(1.0, max(0.0, rho + delta))
    if abs(new_rho - rho) < RHO_EPSILON:
        return safe_ratio, ambition_ratio
    return new_rho * total, (1.0 - new_rho) * total


def _perturb_size(base_val: float | int, radius: float) -> float:
    """Perturbation step for a scalar parameter (>= 1 for integer params)."""
    if isinstance(base_val, int):
        return float(max(1, int(abs(base_val) * radius)))
    return max(radius, abs(base_val) * radius)


def _scalar_neighborhood_scores(
    params: StrategyParameterSet,
    name: str,
    base_val: float | int,
    perturb: float,
    base_sharpe: float,
    score_fn: Callable[[StrategyParameterSet], float],
) -> tuple[list[float], list[float]]:
    """Score ``params`` with scalar ``name`` shifted ``+/- perturb``."""
    sharpes: list[float] = []
    gradients: list[float] = []
    for delta in (perturb, -perturb):
        shifted = copy.deepcopy(params)
        new_val = base_val + delta
        if isinstance(base_val, int):
            setattr(shifted, name, int(round(max(0, new_val))))
        else:
            setattr(shifted, name, max(0.0, new_val))
        score = score_fn(shifted)
        sharpes.append(score)
        gradients.append(abs(score - base_sharpe) / perturb)
    return sharpes, gradients


def _weight_neighborhood_scores(
    params: StrategyParameterSet,
    weights_name: str,
    symbol: str,
    delta: float,
    base_sharpe: float,
    score_fn: Callable[[StrategyParameterSet], float],
) -> tuple[list[float], list[float]]:
    """Score ``params`` with allocation weight ``symbol`` shifted ``+/- delta``."""
    sharpes: list[float] = []
    gradients: list[float] = []
    for step in (delta, -delta):
        shifted = copy.deepcopy(params)
        weights = getattr(shifted, weights_name)
        setattr(shifted, weights_name, _perturb_weights(weights, symbol, step))
        score = score_fn(shifted)
        sharpes.append(score)
        gradients.append(abs(score - base_sharpe) / delta)
    return sharpes, gradients


def check_stability(
    data: MarketDataInput,
    symbols: list[str],
    params: StrategyParameterSet,
    neighborhood_radius: float = 0.05,
    gradient_threshold: float = 0.1,
    risk_free_rate: float = 0.0,
    test_ratio: float = 0.3,
    cost_config: TransactionCostConfig | None = None,
    dca_config: DcaConfig | None = None,
) -> StabilityReport:
    wf_symbols = resolve_backtest_symbols(data, symbols)
    all_prices = extract_prices_for_symbols(data, wf_symbols)

    total_obs = len(all_prices[0])
    test_start = int(total_obs * (1 - test_ratio))
    test_end = total_obs - 1

    def _score(pp: StrategyParameterSet) -> float:
        rets = compute_portfolio_returns_for_params(
            wf_symbols,
            all_prices,
            test_start,
            test_end,
            pp,
            cost_config,
            dca_config,
        )
        if len(rets) < MIN_OBS_FOR_SHARPE:
            return -1.0
        return compute_sharpe_ratio(rets, risk_free_rate)

    base_sharpe = _score(params)

    neighborhood_sharpes: list[float] = [base_sharpe]
    gradients: list[float] = []

    # Scalar parameters
    scalar_params: list[tuple[str, float | int]] = [
        ("trigger_line", params.trigger_line),
        ("bsm_threshold", params.bsm_threshold),
        ("ma_short_window", params.ma_short_window),
        ("ma_long_window", params.ma_long_window),
    ]

    for name, base_val in scalar_params:
        if base_val == 0:
            continue
        perturb = _perturb_size(base_val, neighborhood_radius)
        if perturb == 0:
            continue
        sharpes, grads = _scalar_neighborhood_scores(
            params, name, base_val, perturb, base_sharpe, _score
        )
        neighborhood_sharpes.extend(sharpes)
        gradients.extend(grads)

    # safe/ambition split: joint perturbation preserving sum = 1
    for delta in (neighborhood_radius, -neighborhood_radius):
        new_safe, new_amb = _perturb_split(
            params.safe_ratio, params.ambition_ratio, delta
        )
        if (new_safe, new_amb) == (params.safe_ratio, params.ambition_ratio):
            continue
        shifted = copy.deepcopy(params)
        shifted.safe_ratio = new_safe
        shifted.ambition_ratio = new_amb
        score = _score(shifted)
        neighborhood_sharpes.append(score)
        gradients.append(abs(score - base_sharpe) / neighborhood_radius)

    for weights_name, weights in (
        ("safe_allocation", params.safe_allocation),
        ("ambition_allocation", params.ambition_allocation),
    ):
        for symbol in weights:
            base_w = weights[symbol]
            delta = max(neighborhood_radius, abs(base_w) * neighborhood_radius)
            sharpes, grads = _weight_neighborhood_scores(
                params, weights_name, symbol, delta, base_sharpe, _score
            )
            neighborhood_sharpes.extend(sharpes)
            gradients.extend(grads)

    avg_gradient = np.mean(gradients) if gradients else 1.0

    return StabilityReport(
        gradient=float(avg_gradient),
        threshold=gradient_threshold,
        is_stable=bool(avg_gradient < gradient_threshold),
        neighborhood_sharpe_ratios=neighborhood_sharpes,
    )
