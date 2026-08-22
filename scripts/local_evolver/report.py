"""Report generation, serialization, and push to cloud API."""

import json
import logging
import math
import os
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import requests
from config import (
    load_bootstrap_config,
    load_drift_config,
    load_regime_lookback,
    load_synthetic_n_paths,
)
from constants import MIN_OBS_FOR_BOOTSTRAP, MIN_OBS_FOR_SHARPE
from cpcv import generate_cpcv_folds
from dsr import bootstrap_ci, compute_sharpe_ratio
from models import (
    DEFAULT_EVOLVER_CONFIG,
    CVaRResult,
    DrawdownAnalytics,
    DriftResult,
    EvolverConfig,
    MarketDataInput,
    MonteCarloResult,
    MRCResult,
    PboResult,
    RegimeResult,
    SobolResult,
    StabilityReport,
    StrategyParameterSet,
    StrategyReportData,
    SyntheticScenarioResult,
    WalkForwardResult,
    WalkForwardSummary,
)
from monte_carlo import run_monte_carlo
from mpt import (
    _get_device,
    compute_covariance_matrix,
    compute_efficient_frontier_with_cpcv,
)
from risk import compute_mrc
from seeding import seed_all
from stability import check_stability
from synthetic import run_all_scenarios
from walk_forward import (
    compute_portfolio_returns_for_params,
    extract_dates_for_symbols,
    extract_prices_for_symbols,
    run_walk_forward,
)

logger = logging.getLogger(__name__)

# 推送失败/超时时本地兜底目录（原子写，可事后补推）
DEFAULT_REPORTS_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "reports"


def utc_now_iso() -> str:
    """UTC 时间戳，带 Z 后缀（后端 zod `.datetime()` 默认拒绝 +00:00 偏移）。"""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def utc_z(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def compute_bootstrap_from_walk_forward(
    data: MarketDataInput,
    symbols: list[str],
    wf_summary: WalkForwardSummary,
    recommended: StrategyParameterSet,
    config: EvolverConfig,
    risk_free_rate: float = 0.025,
) -> dict:
    """Block-bootstrap CI of the recommended strategy's OOS DCA daily returns.

    Bootstrapping the MC terminal cross-section (per-path final returns) is
    meaningless — it has no temporal structure. The strategy's actual
    out-of-sample daily return series (recommended walk-forward test window)
    carries real autocorrelation, which block bootstrap is designed for.

    The recommended strategy is matched against the walk-forward results by
    dataclass equality, so the bootstrapped window is always the OOS window of
    the strategy the report actually recommends (including the PBO/stability
    override path, where the default best-by-DSR selection would point at a
    different — potentially unstable — strategy).
    """
    best = next(
        (r for r in wf_summary.results if r.optimal_params == recommended), None
    )
    if best is None:
        return {}

    all_prices = extract_prices_for_symbols(data, symbols)
    oos_returns = compute_portfolio_returns_for_params(
        symbols,
        all_prices,
        best.window.test_start,
        best.window.test_end,
        best.optimal_params,
        config.transaction_costs,
        config.dca,
    )
    if len(oos_returns) < MIN_OBS_FOR_BOOTSTRAP:
        return {}

    bc = load_bootstrap_config()
    return bootstrap_ci(
        oos_returns,
        n_resamples=bc.get("n_resamples", 1000),
        block_size=bc.get("block_size", 5),
        risk_free_rate=risk_free_rate / 252,
    )


def generate_report(
    data: MarketDataInput,
    symbols: list[str],
    config: EvolverConfig | None = None,
    risk_free_rate: float = 0.025,
    seed: int | None = None,
) -> StrategyReportData:
    if config is None:
        config = DEFAULT_EVOLVER_CONFIG

    if seed is not None:
        seed_all(seed)

    # UTC 带 Z：服务端 zod `.datetime()` 拒绝 naive/带 +00:00 偏移的时间戳
    timestamp = utc_now_iso()

    # total_obs 必须与窗口化 MPT 统计量校验的同一长度源一致：日期对齐后的
    # 主索引长度（extract_prices_for_symbols），而非 min(len(close))——
    # 停牌/缺日时两者不同，折窗口索引会落在另一个日历上
    aligned_prices = extract_prices_for_symbols(data, symbols)
    total_obs = len(aligned_prices[0]) if aligned_prices else 0

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
        data.symbols[s].close[-1]
        if s in data.symbols and data.symbols[s].close
        else 1.0
        for s in symbols
    ]

    efficient_frontier = compute_efficient_frontier_with_cpcv(
        data,
        symbols,
        cpcv_folds,
        config,
        risk_free_rate,
        config.dsr_alpha,
    )

    max_sharpe_weights = (
        efficient_frontier.max_sharpe_portfolio.weights
        if efficient_frontier.max_sharpe_portfolio
        else None
    )

    # === Monte Carlo + CVaR + Drawdown Analytics ===
    mc_result = MonteCarloResult()
    mc_cvar = CVaRResult()
    mc_dd = DrawdownAnalytics()
    if max_sharpe_weights:
        mc_result, mc_cvar, mc_dd = run_monte_carlo(
            data,
            symbols,
            max_sharpe_weights,
            initial_prices,
            config.gbm_days,
            config.gbm_paths,
            estimate_window_days=config.mc_estimate_window_days,
        )

    # === Walk-Forward with transaction costs ===
    # config.dca / config.transaction_costs 必须传入主链路：否则优化目标回落
    # DcaConfig() 默认（1000 元/21 天），与 yaml 配置和 bootstrap CI 口径分裂
    wf_summary = run_walk_forward(
        data,
        symbols,
        config.parameter_bounds,
        config.walk_forward_param_sets,
        config.walk_forward_windows,
        config.walk_forward_train_ratio,
        risk_free_rate / 252,
        config.dsr_alpha,
        purge_days=config.purge_days,
        embargo_days=config.embargo_days,
        cost_config=config.transaction_costs,
        dca_config=config.dca,
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
        data,
        symbols,
        recommended,
        config.stability_neighborhood_radius,
        config.stability_gradient_threshold,
        risk_free_rate / 252,
        cost_config=config.transaction_costs,
        dca_config=config.dca,
    )

    if pbo_result.is_rejected:
        stable = [r for r in wf_summary.results if r.test_sharpe > 0]
        stable_with_check: list[tuple[WalkForwardResult, StabilityReport]] = []
        for r in stable:
            s = check_stability(
                data,
                symbols,
                r.optimal_params,
                config.stability_neighborhood_radius,
                config.stability_gradient_threshold,
                risk_free_rate / 252,
                cost_config=config.transaction_costs,
                dca_config=config.dca,
            )
            if s.is_stable:
                stable_with_check.append((r, s))
        if stable_with_check:
            stable_with_check.sort(key=lambda pair: pair[0].dsr, reverse=True)
            best_result, best_stability = stable_with_check[0]
            recommended = best_result.optimal_params
            # 报告新推荐参数自己的稳定性（循环里已算出），而非沿用初选参数
            # 的 gradient/threshold/neighborhood —— 那些数字属于另一组参数
            stability = best_stability

    # === Bootstrap CI (block bootstrap on the recommended strategy's OOS returns) ===
    bootstrap_result = compute_bootstrap_from_walk_forward(
        data, symbols, wf_summary, recommended, config, risk_free_rate
    )

    # === MRC (Marginal Risk Contribution) ===
    mrc_result = MRCResult()
    if max_sharpe_weights is not None:
        device = _get_device()
        cov_matrix = compute_covariance_matrix(data, symbols, device)
        mrc_result = compute_mrc(max_sharpe_weights.weights, symbols, cov_matrix)

    # === Regime Detection ===
    regime_result = RegimeResult()
    try:
        from regime import detect_regimes

        regime_lookback = load_regime_lookback()
        regime_result = detect_regimes(
            data,
            symbols,
            lookback=regime_lookback,
            n_states=3,
            hysteresis_window=21,
        )
    except Exception as e:  # noqa: BLE001
        # 缺 scipy/sklearn 或运行时错误不能伪装成"正常的 Sideways 报告"
        logger.warning("Regime detection failed (reporting empty regime): %s", e)

    # === Synthetic Stress Scenarios ===
    synthetic_results: list[SyntheticScenarioResult] = []
    if max_sharpe_weights is not None:
        try:
            n_paths = load_synthetic_n_paths()
            synthetic_results = run_all_scenarios(
                data,
                symbols,
                max_sharpe_weights.weights,
                initial_prices,
                days=config.gbm_days,
                n_paths=n_paths,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Synthetic stress scenarios failed (reporting no scenarios): %s", e
            )

    # === Sobol Sensitivity ===
    sobol_result = SobolResult()
    if wf_summary.results:
        try:
            from sensitivity import compute_sobol_indices

            wf_bounds = config.parameter_bounds
            param_names = [
                "trigger_line",
                "safe_ratio",
                "ambition_ratio",
                "bsm_threshold",
                "ma_short_window",
                "ma_long_window",
            ]
            bounds_arr = np.array([
                [wf_bounds.trigger_line[0], wf_bounds.trigger_line[1]],
                [wf_bounds.safe_ratio[0], wf_bounds.safe_ratio[1]],
                [wf_bounds.ambition_ratio[0], wf_bounds.ambition_ratio[1]],
                [wf_bounds.bsm_threshold[0], wf_bounds.bsm_threshold[1]],
                [
                    float(wf_bounds.ma_short_window[0]),
                    float(wf_bounds.ma_short_window[1]),
                ],
                [
                    float(wf_bounds.ma_long_window[0]),
                    float(wf_bounds.ma_long_window[1]),
                ],
            ])

            all_prices_wf = extract_prices_for_symbols(data, symbols)
            total_obs_wf = len(all_prices_wf[0]) if all_prices_wf else 252
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
                    rets = compute_portfolio_returns_for_params(
                        symbols,
                        all_prices_wf,
                        test_start,
                        total_obs_wf - 1,
                        p,
                        config.transaction_costs,
                        config.dca,
                    )
                    scores[i] = (
                        compute_sharpe_ratio(rets, risk_free_rate / 252)
                        if len(rets) >= MIN_OBS_FOR_SHARPE
                        else -1.0
                    )
                return scores

            import os as _os

            import yaml as _yaml

            _cfg_path = _os.path.join(
                _os.path.dirname(_os.path.abspath(__file__)), "config.yaml"
            )
            _sobol_n = 2048
            if _os.path.exists(_cfg_path):
                with open(_cfg_path, encoding="utf-8") as _f:
                    _raw = _yaml.safe_load(_f) or {}
                _sobol_n = int(_raw.get("sobol", {}).get("n_samples", 2048))
            sob_res = compute_sobol_indices(
                _wf_model,
                param_names,
                bounds_arr,
                n=_sobol_n,
            )
            sobol_result = SobolResult(
                first_order=sob_res["first_order"],
                total_order=sob_res["total_order"],
                confidence_first=sob_res["confidence_first"],
                confidence_total=sob_res["confidence_total"],
            )
        except Exception as e:  # noqa: BLE001
            import logging

            logging.warning("Sobol sensitivity analysis failed: %s", e)

    # === Drift Detection ===
    drift_result = DriftResult()
    try:
        from monitoring import detect_drift

        all_prices_drift = extract_prices_for_symbols(data, symbols)
        all_dates_drift = extract_dates_for_symbols(data, symbols)
        if all_prices_drift and len(all_prices_drift[0]) > 50:
            drift_cfg = load_drift_config()
            window_months = drift_cfg.get("window_months", 12)
            window_days = window_months * 21
            total_obs = len(all_prices_drift[0])

            # Backtest: use walk-forward out-of-sample test returns (real historical performance)
            backtest_returns = np.array([])
            if wf_summary.results:
                best_results = [r for r in wf_summary.results if r.test_sharpe > 0]
                if best_results:
                    best_results.sort(key=lambda r: r.dsr, reverse=True)
                    best = best_results[0]
                    backtest_returns = compute_portfolio_returns_for_params(
                        symbols,
                        all_prices_drift,
                        best.window.test_start,
                        best.window.test_end,
                        best.optimal_params,
                        config.transaction_costs,
                        config.dca,
                    )

            # Live: use most recent actual portfolio returns for recommended params
            live_returns = np.array([])
            if total_obs > window_days:
                live_start = total_obs - window_days
                live_returns = compute_portfolio_returns_for_params(
                    symbols,
                    all_prices_drift,
                    live_start,
                    total_obs - 1,
                    recommended,
                    config.transaction_costs,
                    config.dca,
                )

            if len(backtest_returns) > 20 and len(live_returns) > 20:
                # 窗口日期取数据主索引的真实交易日（live_start 起点与
                # total_obs-1 终点），而非"当前时间−N×30 天"的编造日历日期
                drift_result = detect_drift(
                    backtest_returns,
                    live_returns,
                    window_start=all_dates_drift[live_start],
                    window_end=all_dates_drift[total_obs - 1],
                    psi_threshold=drift_cfg.get("psi_threshold", 0.25),
                    ks_threshold=drift_cfg.get("ks_threshold", 0.05),
                )
    except Exception as e:  # noqa: BLE001
        import logging

        logging.warning("Drift detection failed: %s", e)

    return StrategyReportData(
        timestamp=timestamp,
        config=config,
        evolution_seed=seed,
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


def _sanitize_for_json(obj: Any) -> Any:
    import numpy as np

    if isinstance(obj, (float, np.floating)):
        if math.isnan(obj):
            return None
        if math.isinf(obj):
            # ±inf 写成 ±1e308 会伪装成"很大的有限数"；显式字符串哨兵
            # 让异常在报告里可见，而不是被序列化掩盖
            return "Infinity" if obj > 0 else "-Infinity"
    if isinstance(obj, np.integer):
        return int(obj)
    return obj


def _dataclass_to_dict(obj: Any) -> Any:
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


def save_report_locally(
    report: StrategyReportData,
    directory: Path | None = None,
) -> Path:
    """原子写本地 JSON（临时文件 + os.replace）。

    数小时演化产物在推云前先落盘：一次 502/超时不再丢整轮报告，
    事后可从本地文件补推。
    """
    target_dir = directory if directory is not None else DEFAULT_REPORTS_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_ts = report.timestamp.replace(":", "").replace("-", "").replace("T", "_")
    path = target_dir / f"evolution_report_{safe_ts}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(serialize_report(report), encoding="utf-8")
    os.replace(tmp, path)
    return path


def push_report_to_cloud(
    report: StrategyReportData,
    api_base_url: str,
    session_token: str,
    user_id: int = 0,
    max_attempts: int = 3,
) -> dict:
    report_json = serialize_report(report)

    param_count = (
        6
        + len(report.recommended_params.safe_allocation)
        + len(report.recommended_params.ambition_allocation)
    )

    next_dt = datetime.fromisoformat(report.timestamp) + timedelta(days=7)
    payload = {
        "report_data": report_json,
        "pbo_score": report.walk_forward_summary.pbo_score,
        "dsr_ranking": report.walk_forward_summary.dsr_rankings[0]
        if report.walk_forward_summary.dsr_rankings
        else 0.0,
        "parameter_count": param_count,
        "evolution_timestamp": report.timestamp,
        "next_scheduled_evolution": utc_z(next_dt),
    }

    url = f"{api_base_url}/api/strategy/reports"
    last_error = ""
    for attempt in range(1, max_attempts + 1):
        try:
            resp = requests.post(
                url,
                json=payload,
                cookies={"session_token": session_token},
                timeout=60,
            )
        except requests.RequestException as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        else:
            if resp.ok:
                return {"success": True}
            last_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
            # 4xx（非 429）是契约/认证问题，重试不会自愈
            if 400 <= resp.status_code < 500 and resp.status_code != 429:
                break
        if attempt < max_attempts:
            time.sleep(2.0 * attempt)

    return {"success": False, "error": last_error}
