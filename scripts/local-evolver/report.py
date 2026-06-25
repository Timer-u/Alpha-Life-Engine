"""Report generation, serialization, and push to cloud API."""

import json
import math

import numpy as np
import requests

from config import load_bootstrap_config, load_config, load_drift_config, load_regime_lookback, load_synthetic_n_paths
from cpcv import generate_cpcv_folds, generate_nested_cpcv_folds
from dsr import bootstrap_ci, compute_annualized_sharpe, compute_haircut_sharpe
from models import (
    CVaRResult,
    CpcvFold,
    DEFAULT_EVOLVER_CONFIG,
    DrawdownAnalytics,
    DriftResult,
    EfficientFrontier,
    EvolverConfig,
    MarketDataInput,
    MonteCarloResult,
    PboResult,
    RegimeResult,
    SobolResult,
    StabilityReport,
    StrategyParameterSet,
    StrategyReportData,
    SyntheticScenarioResult,
    TransactionCostConfig,
    WalkForwardSummary,
)
from monte_carlo import run_monte_carlo
from mpt import compute_efficient_frontier_with_cpcv, compute_regime_blended_frontier
from risk import compute_mrc
from stability import check_stability
from synthetic import run_all_scenarios
from walk_forward import run_walk_forward


def generate_report(
    data: MarketDataInput,
    symbols: list[str],
    config: EvolverConfig | None = None,
    risk_free_rate: float = 0.025,
) -> StrategyReportData:
    if config is None:
        config = DEFAULT_EVOLVER_CONFIG

    timestamp = __import__("datetime").datetime.now().isoformat()

    first_symbol = symbols[0]
    total_obs = len(data.symbols[first_symbol].close) if first_symbol in data.symbols else 0

    num_groups = 10
    num_test_groups = max(1, round(num_groups * config.cpcv_test_size))
    cpcv_folds = generate_cpcv_folds(
        total_obs - 1,
        num_groups,
        num_test_groups,
        config.cpcv_splits,
        config.purge_days,
        config.embargo_days,
    )

    initial_prices = [
        data.symbols[s].close[-1] if s in data.symbols and data.symbols[s].close else 1.0
        for s in symbols
    ]

    efficient_frontier = compute_efficient_frontier_with_cpcv(
        data, symbols, cpcv_folds, config, risk_free_rate, config.dsr_alpha,
    )

    max_sharpe_weights = efficient_frontier.max_sharpe_portfolio.weights if efficient_frontier.max_sharpe_portfolio else None

    # === Monte Carlo + CVaR + Drawdown Analytics ===
    mc_result = MonteCarloResult()
    mc_cvar = CVaRResult()
    mc_dd = DrawdownAnalytics()
    if max_sharpe_weights:
        mc_result, mc_cvar, mc_dd = run_monte_carlo(
            data, symbols, max_sharpe_weights, initial_prices,
            config.gbm_days, config.gbm_paths,
        )

    # === Walk-Forward with transaction costs ===
    wf_summary = run_walk_forward(
        data, symbols, config.parameter_bounds, 200,
        config.walk_forward_windows, config.walk_forward_train_ratio,
        risk_free_rate / 252, config.dsr_alpha,
        cost_config=config.transaction_costs,
    )

    pbo_result = PboResult(
        score=wf_summary.pbo_score,
        threshold=config.pbo_rejection_threshold,
        is_rejected=wf_summary.pbo_score >= config.pbo_rejection_threshold,
        ranking_matrix=wf_summary.pbo_ranking_matrix,
    )

    recommended: StrategyParameterSet
    best_results = [r for r in wf_summary.results if r.test_sharpe > 0]
    if best_results:
        best_results.sort(key=lambda r: r.dsr, reverse=True)
        recommended = best_results[0].optimal_params
    else:
        recommended = StrategyParameterSet()

    stability = check_stability(
        data, symbols, recommended,
        config.stability_neighborhood_radius,
        config.stability_gradient_threshold,
        risk_free_rate / 252,
    )

    if pbo_result.is_rejected:
        stable = [
            r for r in wf_summary.results
            if r.test_sharpe > 0
        ]
        stable_with_check = []
        for r in stable:
            s = check_stability(
                data, symbols, r.optimal_params,
                config.stability_neighborhood_radius,
                config.stability_gradient_threshold,
                risk_free_rate / 252,
            )
            if s.is_stable:
                stable_with_check.append(r)
        if stable_with_check:
            stable_with_check.sort(key=lambda r: r.dsr, reverse=True)
            recommended = stable_with_check[0].optimal_params
            stability.is_stable = True

    # === Bootstrap CI ===
    bootstrap_result = {}
    if max_sharpe_weights is not None and mc_result.paths.returns:
        last_returns = np.array(mc_result.paths.returns[-1]) if mc_result.paths.returns and len(mc_result.paths.returns) > 0 else np.array([])
        if len(last_returns) > 10:
            bc = load_bootstrap_config()
            bootstrap_result = bootstrap_ci(
                last_returns,
                n_resamples=bc.get("n_resamples", 1000),
                block_size=bc.get("block_size", 5),
                risk_free_rate=risk_free_rate / 252,
            )

    # === MRC (Marginal Risk Contribution) ===
    mrc_result = MRCResult()
    if max_sharpe_weights is not None:
        from mpt import compute_covariance_matrix, _get_device
        device = _get_device()
        cov_matrix = compute_covariance_matrix(data, symbols, device)
        mrc_result = compute_mrc(max_sharpe_weights.weights, symbols, cov_matrix)

    # === Regime Detection ===
    regime_result = RegimeResult()
    try:
        from regime import detect_regimes
        regime_lookback = load_regime_lookback()
        regime_result = detect_regimes(
            data, symbols,
            lookback=regime_lookback,
            n_states=3,
            hysteresis_window=21,
        )
    except Exception:
        pass

    # === Synthetic Stress Scenarios ===
    synthetic_results: list[SyntheticScenarioResult] = []
    if max_sharpe_weights is not None:
        try:
            n_paths = load_synthetic_n_paths()
            synthetic_results = run_all_scenarios(
                data, symbols, max_sharpe_weights.weights, initial_prices,
                days=config.gbm_days,
                n_paths=n_paths,
            )
        except Exception:
            pass

    # === Sobol Sensitivity ===
    sobol_result = SobolResult()
    if wf_summary.results:
        try:
            from sensitivity import compute_sobol_indices

            wf_bounds = config.parameter_bounds
            param_names = ["trigger_line", "safe_ratio", "ambition_ratio", "bsm_threshold",
                           "ma_short_window", "ma_long_window"]
            bounds_arr = np.array([
                [wf_bounds.trigger_line[0], wf_bounds.trigger_line[1]],
                [wf_bounds.safe_ratio[0], wf_bounds.safe_ratio[1]],
                [wf_bounds.ambition_ratio[0], wf_bounds.ambition_ratio[1]],
                [wf_bounds.bsm_threshold[0], wf_bounds.bsm_threshold[1]],
                [float(wf_bounds.ma_short_window[0]), float(wf_bounds.ma_short_window[1])],
                [float(wf_bounds.ma_long_window[0]), float(wf_bounds.ma_long_window[1])],
            ])

            all_returns = __import__("walk_forward", fromlist=["extract_returns_for_symbols"]).extract_returns_for_symbols(data, symbols)
            total_obs_wf = len(all_returns[0]) if all_returns else 252
            test_start = int(total_obs_wf * 0.7)

            def _wf_model(X: np.ndarray) -> np.ndarray:
                scores = np.zeros(X.shape[0])
                for i in range(X.shape[0]):
                    p = StrategyParameterSet(
                        trigger_line=int(X[i, 0]),
                        safe_ratio=X[i, 1],
                        ambition_ratio=X[i, 2],
                        bsm_threshold=X[i, 3],
                        ma_short_window=int(X[i, 4]),
                        ma_long_window=int(X[i, 5]),
                    )
                    rets = __import__("walk_forward", fromlist=["compute_portfolio_returns_for_params"]).compute_portfolio_returns_for_params(
                        symbols, all_returns, test_start, total_obs_wf - 1, p,
                    )
                    scores[i] = __import__("dsr", fromlist=["compute_sharpe_ratio"]).compute_sharpe_ratio(rets, risk_free_rate / 252) if len(rets) >= 5 else -1.0
                return scores

            import yaml as _yaml
            import os as _os
            _cfg_path = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "config.yaml")
            _sobol_n = 2048
            if _os.path.exists(_cfg_path):
                with open(_cfg_path, "r", encoding="utf-8") as _f:
                    _raw = _yaml.safe_load(_f) or {}
                _sobol_n = int(_raw.get("sobol", {}).get("n_samples", 2048))
            sob_res = compute_sobol_indices(
                _wf_model, param_names, bounds_arr,
                n=_sobol_n,
            )
            sobol_result = SobolResult(
                first_order=sob_res["first_order"],
                total_order=sob_res["total_order"],
                confidence_first=sob_res["confidence_first"],
                confidence_total=sob_res["confidence_total"],
            )
        except Exception as e:
            import logging
            logging.warning(f"Sobol sensitivity analysis failed: {e}")

    # === Drift Detection ===
    drift_result = DriftResult()
    try:
        from monitoring import detect_drift
        from walk_forward import compute_portfolio_returns_for_params, extract_returns_for_symbols

        all_returns = extract_returns_for_symbols(data, symbols)
        if all_returns and len(all_returns[0]) > 50:
            drift_cfg = load_drift_config()
            window_months = drift_cfg.get("window_months", 12)
            window_days = window_months * 21
            total_obs = len(all_returns[0])

            # Backtest: use walk-forward out-of-sample test returns (real historical performance)
            backtest_returns = np.array([])
            if wf_summary.results:
                best_results = [r for r in wf_summary.results if r.test_sharpe > 0]
                if best_results:
                    best_results.sort(key=lambda r: r.dsr, reverse=True)
                    best = best_results[0]
                    backtest_returns = compute_portfolio_returns_for_params(
                        symbols, all_returns, best.window.test_start, best.window.test_end, best.optimal_params,
                    )

            # Live: use most recent actual portfolio returns for recommended params
            live_returns = np.array([])
            if total_obs > window_days:
                live_start = total_obs - window_days
                live_returns = compute_portfolio_returns_for_params(
                    symbols, all_returns, live_start, total_obs - 1, recommended,
                )

            if len(backtest_returns) > 20 and len(live_returns) > 20:
                import datetime
                end_dt = datetime.datetime.now()
                start_dt = end_dt - datetime.timedelta(days=window_months * 30)

                drift_result = detect_drift(
                    backtest_returns, live_returns,
                    window_start=start_dt.strftime("%Y-%m-%d"),
                    window_end=end_dt.strftime("%Y-%m-%d"),
                    psi_threshold=drift_cfg.get("psi_threshold", 0.25),
                    ks_threshold=drift_cfg.get("ks_threshold", 0.05),
                )
    except Exception as e:
        import logging
        logging.warning(f"Drift detection failed: {e}")

    return StrategyReportData(
        timestamp=timestamp,
        config=config,
        efficient_frontier=efficient_frontier,
        monte_carlo_result=mc_result,
        walk_forward_summary=wf_summary,
        stability_report=stability,
        pbo_result=pbo_result,
        recommended_params=recommended,
        bootstrap_result=bootstrap_result,
        cvar_result=mc_cvar,
        drawdown_analytics=mc_dd,
        mrc_result=mrc_result,
        regime_result=regime_result,
        synthetic_results=synthetic_results,
        sobol_result=sobol_result,
        drift_result=drift_result,
    )


def _sanitize_for_json(obj):
    import numpy as np
    if isinstance(obj, (float, np.floating)):
        if math.isnan(obj):
            return None
        if math.isinf(obj):
            return 1e308 if obj > 0 else -1e308
    if isinstance(obj, np.integer):
        return int(obj)
    return obj


def _dataclass_to_dict(obj):
    import torch
    if isinstance(obj, torch.Tensor):
        return obj.detach().cpu().tolist()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if hasattr(obj, "__dataclass_fields__"):
        result = {}
        for field_name in obj.__dataclass_fields__:
            val = getattr(obj, field_name)
            result[field_name] = _dataclass_to_dict(val)
        return result
    if isinstance(obj, dict):
        return {k: _dataclass_to_dict(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_dataclass_to_dict(v) for v in obj]
    return _sanitize_for_json(obj)


def serialize_report(report: StrategyReportData) -> str:
    return json.dumps(
        _dataclass_to_dict(report),
        ensure_ascii=False,
        default=str,
    )


def push_report_to_cloud(
    report: StrategyReportData,
    api_base_url: str,
    session_token: str,
    user_id: int = 0,
) -> dict:
    report_json = serialize_report(report)

    param_count = (
        6
        + len(report.recommended_params.safe_allocation)
        + len(report.recommended_params.ambition_allocation)
    )

    payload = {
        "report_data": report_json,
        "pbo_score": report.walk_forward_summary.pbo_score,
        "dsr_ranking": report.walk_forward_summary.dsr_rankings[0]
        if report.walk_forward_summary.dsr_rankings
        else 0.0,
        "parameter_count": param_count,
        "evolution_timestamp": report.timestamp,
        "next_scheduled_evolution": (
            __import__("datetime").datetime.fromisoformat(report.timestamp)
            + __import__("datetime").timedelta(days=7)
        ).isoformat(),
    }

    url = f"{api_base_url}/strategy/reports"
    resp = requests.post(
        url,
        json=payload,
        cookies={"session_token": session_token},
        timeout=60,
    )

    if not resp.ok:
        return {"success": False, "error": f"HTTP {resp.status_code}: {resp.text}"}

    return {"success": True}
