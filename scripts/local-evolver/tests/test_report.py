"""Tests for report.py module."""

import pytest

from report import serialize_report, _dataclass_to_dict, _sanitize_for_json
from models import (
    StrategyReportData,
    StrategyParameterSet,
    PortfolioWeights,
    FrontierPoint,
    EfficientFrontier,
    MonteCarloResult,
    MonteCarloSummary,
    MonteCarloPercentiles,
    WalkForwardSummary,
    WalkForwardResult,
    WalkForwardWindow,
    StabilityReport,
    PboResult,
    CpcvFold,
    EvolverConfig,
)


def test_sanitize_for_json():
    assert _sanitize_for_json(1.0) == 1.0
    assert _sanitize_for_json(float("nan")) is None
    assert _sanitize_for_json(float("inf")) == 1e308
    assert _sanitize_for_json(float("-inf")) == -1e308


def test_dataclass_to_dict():
    params = StrategyParameterSet(trigger_line=1667, safe_ratio=0.6)
    result = _dataclass_to_dict(params)
    assert result["trigger_line"] == 1667
    assert result["safe_ratio"] == 0.6


def test_dataclass_to_dict_nested():
    weights = PortfolioWeights(weights={"A": 0.5, "B": 0.5})
    point = FrontierPoint(weights=weights, expected_return=0.1, volatility=0.15, sharpe_ratio=0.8)
    result = _dataclass_to_dict(point)
    assert result["weights"]["weights"]["A"] == 0.5
    assert result["expected_return"] == 0.1


def test_serialize_report():
    config = EvolverConfig()
    params = StrategyParameterSet()
    weights = PortfolioWeights(weights={"A": 0.5})
    point = FrontierPoint(weights=weights, expected_return=0.1, volatility=0.15, sharpe_ratio=0.8)
    ef = EfficientFrontier(points=[point], max_sharpe_portfolio=point, min_vol_portfolio=point)
    mc = MonteCarloResult(summary=MonteCarloSummary(
        mean_return=0.1, median_return=0.09, std_return=0.15,
        var95=-0.2, var99=-0.3, max_drawdown=-0.4,
        percentiles=MonteCarloPercentiles()
    ))
    wf = WalkForwardSummary(pbo_score=0.3, stability_score=0.05, results=[],
                            dsr_rankings=[0.9], pbo_ranking_matrix=[[1.0, 2.0]])
    stability = StabilityReport(gradient=0.05, threshold=0.1, is_stable=True, neighborhood_sharpe_ratios=[1.0, 1.1])
    pbo = PboResult(score=0.3, threshold=0.5, is_rejected=False, ranking_matrix=[[1.0, 2.0]])

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