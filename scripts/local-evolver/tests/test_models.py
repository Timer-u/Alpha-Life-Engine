"""Tests for models.py dataclasses."""

from models import (
    DataFrame,
    MarketDataInput,
    StrategyParameterSet,
    StrategyParameterBounds,
    PortfolioWeights,
    FrontierPoint,
    EfficientFrontier,
    CpcvFold,
    CpcvResult,
    SharpeDistribution,
    SharpePercentiles,
    WalkForwardWindow,
    WalkForwardResult,
    WalkForwardSummary,
    GbmPathData,
    MonteCarloPercentiles,
    MonteCarloSummary,
    MonteCarloResult,
    StabilityReport,
    PboResult,
    EvolverConfig,
    StrategyReportData,
    DEFAULT_EVOLVER_CONFIG,
)


def test_dataclass_defaults():
    params = StrategyParameterSet()
    assert params.trigger_line == 1667
    assert params.safe_ratio == 0.6
    assert params.ambition_ratio == 0.4
    assert params.ma_short_window == 20
    assert params.ma_long_window == 60


def test_dataclass_custom():
    params = StrategyParameterSet(
        trigger_line=2000,
        safe_ratio=0.7,
        ambition_ratio=0.3,
        safe_allocation={"A": 1.0},
        ambition_allocation={"B": 1.0},
    )
    assert params.trigger_line == 2000
    assert params.safe_allocation == {"A": 1.0}


def test_bounds_defaults():
    bounds = StrategyParameterBounds()
    assert bounds.trigger_line == (1000, 3000)
    assert bounds.ma_short_window == (5, 50)
    assert bounds.ma_long_window == (20, 200)


def test_portfolio_weights():
    pw = PortfolioWeights(weights={"A": 0.5, "B": 0.5})
    assert pw.weights["A"] == 0.5


def test_evolver_config():
    config = EvolverConfig(gbm_paths=5000, frontier_points=25)
    assert config.gbm_paths == 5000
    assert config.frontier_points == 25


def test_default_evolver_config():
    assert DEFAULT_EVOLVER_CONFIG.gbm_paths == 10000
    assert DEFAULT_EVOLVER_CONFIG.frontier_points == 50


def test_cpcv_fold():
    fold = CpcvFold(train_start=0, train_end=99, test_start=105, test_end=150)
    assert fold.train_end == 99


def test_strategy_report_data():
    report = StrategyReportData(
        timestamp="2024-01-01",
        config=DEFAULT_EVOLVER_CONFIG,
        recommended_params=StrategyParameterSet(),
    )
    assert report.timestamp == "2024-01-01"
    assert isinstance(report.config, EvolverConfig)