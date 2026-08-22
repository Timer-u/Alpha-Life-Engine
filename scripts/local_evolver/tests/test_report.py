"""Tests for report.py module."""

from models import (
    EfficientFrontier,
    EvolverConfig,
    FrontierPoint,
    MonteCarloPercentiles,
    MonteCarloResult,
    MonteCarloSummary,
    PboResult,
    PortfolioWeights,
    StabilityReport,
    StrategyParameterSet,
    StrategyReportData,
    WalkForwardResult,
    WalkForwardSummary,
    WalkForwardWindow,
)
from report import (
    _dataclass_to_dict,
    _sanitize_for_json,
    compute_bootstrap_from_walk_forward,
    serialize_report,
)
from walk_forward import BACKTEST_SYMBOLS


def test_sanitize_for_json():
    assert _sanitize_for_json(1.0) == 1.0
    assert _sanitize_for_json(float("nan")) is None
    assert _sanitize_for_json(float("inf")) == "Infinity"
    assert _sanitize_for_json(float("-inf")) == "-Infinity"


def test_dataclass_to_dict():
    params = StrategyParameterSet(trigger_line=1667, safe_ratio=0.6)
    result = _dataclass_to_dict(params)
    assert result["trigger_line"] == 1667
    assert result["safe_ratio"] == 0.6


def test_dataclass_to_dict_nested():
    weights = PortfolioWeights(weights={"A": 0.5, "B": 0.5})
    point = FrontierPoint(
        weights=weights, expected_return=0.1, volatility=0.15, sharpe_ratio=0.8
    )
    result = _dataclass_to_dict(point)
    assert result["weights"]["weights"]["A"] == 0.5
    assert result["expected_return"] == 0.1


def test_serialize_report():
    config = EvolverConfig()
    params = StrategyParameterSet()
    weights = PortfolioWeights(weights={"A": 0.5})
    point = FrontierPoint(
        weights=weights, expected_return=0.1, volatility=0.15, sharpe_ratio=0.8
    )
    ef = EfficientFrontier(
        points=[point], max_sharpe_portfolio=point, min_vol_portfolio=point
    )
    mc = MonteCarloResult(
        summary=MonteCarloSummary(
            mean_return=0.1,
            median_return=0.09,
            std_return=0.15,
            var95=-0.2,
            var99=-0.3,
            max_drawdown=-0.4,
            percentiles=MonteCarloPercentiles(),
        )
    )
    wf = WalkForwardSummary(
        pbo_score=0.3,
        stability_score=0.05,
        results=[],
        dsr_rankings=[0.9],
        pbo_ranking_matrix=[[1.0, 2.0]],
    )
    stability = StabilityReport(
        gradient=0.05,
        threshold=0.1,
        is_stable=True,
        neighborhood_sharpe_ratios=[1.0, 1.1],
    )
    pbo = PboResult(
        score=0.3, threshold=0.5, is_rejected=False, ranking_matrix=[[1.0, 2.0]]
    )

    report = StrategyReportData(
        timestamp="2024-01-01T00:00:00",
        config=config,
        efficient_frontier=ef,
        monte_carlo_result=mc,
        walk_forward_summary=wf,
        stability_report=stability,
        pbo_result=pbo,
        recommended_params=params,
    )

    json_str = serialize_report(report)
    assert isinstance(json_str, str)
    assert "trigger_line" in json_str
    assert "efficient_frontier" in json_str


def test_serialize_report_handles_nan():
    summary = MonteCarloSummary(mean_return=float("nan"))
    mc = MonteCarloResult(summary=summary)
    report = StrategyReportData(
        timestamp="2024-01-01T00:00:00",
        config=EvolverConfig(),
        monte_carlo_result=mc,
        recommended_params=StrategyParameterSet(),
    )
    json_str = serialize_report(report)
    assert "null" in json_str.lower()


def test_bootstrap_from_walk_forward_oos_returns(sample_market_data, sample_params):
    summary = WalkForwardSummary(
        results=[
            WalkForwardResult(
                window=WalkForwardWindow(
                    train_start=0, train_end=100, test_start=120, test_end=219
                ),
                optimal_params=sample_params,
                train_sharpe=0.1,
                test_sharpe=0.05,
                dsr=0.5,
            )
        ]
    )
    result = compute_bootstrap_from_walk_forward(
        sample_market_data,
        BACKTEST_SYMBOLS,
        summary,
        sample_params,
        EvolverConfig(),
        0.025,
    )
    assert set(result.keys()) == {"sharpe", "sortino", "max_drawdown"}
    for key in result:
        assert result[key]["mean"] is not None
        assert len(result[key]["ci_95"]) == 2


def test_bootstrap_from_walk_forward_empty_when_no_positive(
    sample_market_data, sample_params
):
    summary = WalkForwardSummary(results=[])
    result = compute_bootstrap_from_walk_forward(
        sample_market_data,
        BACKTEST_SYMBOLS,
        summary,
        sample_params,
        EvolverConfig(),
        0.025,
    )
    assert result == {}
