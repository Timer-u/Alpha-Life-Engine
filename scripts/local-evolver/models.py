from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class DataFrame:
    dates: list[str]
    close: list[float]
    open: list[float]
    high: list[float]
    low: list[float]
    volume: list[int]


@dataclass
class MarketDataInput:
    symbols: dict[str, DataFrame]


@dataclass
class CpcvFold:
    train_start: int
    train_end: int
    test_start: int
    test_end: int


@dataclass
class SharpePercentiles:
    p5: float = 0.0
    p25: float = 0.0
    p50: float = 0.0
    p75: float = 0.0
    p95: float = 0.0


@dataclass
class SharpeDistribution:
    mean: float = 0.0
    std: float = 0.0
    skewness: float = 0.0
    percentiles: SharpePercentiles = field(default_factory=SharpePercentiles)


@dataclass
class CpcvResult:
    folds: list[CpcvFold] = field(default_factory=list)
    fold_sharpe_ratios: list[float] = field(default_factory=list)
    sharpe_distribution: SharpeDistribution = field(default_factory=SharpeDistribution)
    dsr: float = 0.0


@dataclass
class PortfolioWeights:
    weights: dict[str, float]


@dataclass
class FrontierPoint:
    weights: PortfolioWeights
    expected_return: float = 0.0
    volatility: float = 0.0
    sharpe_ratio: float = 0.0
    cpcv_result: Optional[CpcvResult] = None


@dataclass
class EfficientFrontier:
    points: list[FrontierPoint] = field(default_factory=list)
    max_sharpe_portfolio: Optional[FrontierPoint] = None
    min_vol_portfolio: Optional[FrontierPoint] = None


@dataclass
class StrategyParameterSet:
    trigger_line: int = 1667
    safe_ratio: float = 0.6
    ambition_ratio: float = 0.4
    bsm_threshold: float = 1.4
    ma_short_window: int = 20
    ma_long_window: int = 60
    safe_allocation: dict[str, float] = field(default_factory=lambda: {"511360": 0.8, "511880": 0.2})
    ambition_allocation: dict[str, float] = field(default_factory=lambda: {"000300": 0.4, "000905": 0.4, "000922": 0.2})


@dataclass
class StrategyParameterBounds:
    trigger_line: tuple[float, float] = (1000, 3000)
    safe_ratio: tuple[float, float] = (0.3, 0.8)
    ambition_ratio: tuple[float, float] = (0.2, 0.7)
    bsm_threshold: tuple[float, float] = (1.0, 2.0)
    ma_short_window: tuple[int, int] = (5, 50)
    ma_long_window: tuple[int, int] = (20, 200)
    safe_allocation: dict[str, tuple[float, float]] = field(default_factory=lambda: {"511360": (0, 1), "511880": (0, 1)})
    ambition_allocation: dict[str, tuple[float, float]] = field(default_factory=lambda: {"000300": (0, 1), "000905": (0, 1), "000922": (0, 1)})


@dataclass
class WalkForwardWindow:
    train_start: int
    train_end: int
    test_start: int
    test_end: int


@dataclass
class WalkForwardResult:
    window: WalkForwardWindow
    optimal_params: StrategyParameterSet
    train_sharpe: float = 0.0
    test_sharpe: float = 0.0
    dsr: float = 0.0
    rank: int = 0


@dataclass
class WalkForwardSummary:
    results: list[WalkForwardResult] = field(default_factory=list)
    dsr_rankings: list[float] = field(default_factory=list)
    pbo_score: float = 1.0
    stability_score: float = 0.0
    pbo_ranking_matrix: list[list[float]] = field(default_factory=list)


@dataclass
class GbmPathData:
    dates: list[str] = field(default_factory=list)
    prices: list[list[float]] = field(default_factory=list)
    returns: list[list[float]] = field(default_factory=list)


@dataclass
class MonteCarloPercentiles:
    p1: float = 0.0
    p5: float = 0.0
    p10: float = 0.0
    p25: float = 0.0
    p50: float = 0.0
    p75: float = 0.0
    p90: float = 0.0
    p95: float = 0.0
    p99: float = 0.0


@dataclass
class MonteCarloSummary:
    mean_return: float = 0.0
    median_return: float = 0.0
    std_return: float = 0.0
    var95: float = 0.0
    var99: float = 0.0
    max_drawdown: float = 0.0
    percentiles: MonteCarloPercentiles = field(default_factory=MonteCarloPercentiles)


@dataclass
class MonteCarloResult:
    paths: GbmPathData = field(default_factory=GbmPathData)
    summary: MonteCarloSummary = field(default_factory=MonteCarloSummary)


@dataclass
class StabilityReport:
    gradient: float = 0.0
    threshold: float = 0.0
    is_stable: bool = False
    neighborhood_sharpe_ratios: list[float] = field(default_factory=list)


@dataclass
class PboResult:
    score: float = 0.0
    threshold: float = 0.5
    is_rejected: bool = False
    ranking_matrix: list[list[float]] = field(default_factory=list)


@dataclass
class TransactionCostConfig:
    """交易成本配置。A股ETF盘中买卖有价差，货基约零成本。"""
    etf_bps: float = 3.0          # ETF 万分之三佣金（含规费、过户费），建议 2-5 bps
    etf_min_yuan: float = 5.0     # 单笔最低佣金 5 元（默认不免5）；若券商免5改为 0
    mmf_bps: float = 0.0          # 货币基金（511360/511880）约 0 成本


@dataclass
class EvolverConfig:
    cpcv_splits: int = 10
    cpcv_test_size: float = 0.2
    purge_days: int = 5
    embargo_days: int = 5
    frontier_points: int = 50
    gbm_paths: int = 10000
    gbm_days: int = 252
    walk_forward_windows: int = 6
    walk_forward_train_ratio: float = 0.7
    stability_neighborhood_radius: float = 0.05
    stability_gradient_threshold: float = 0.1
    pbo_rejection_threshold: float = 0.5
    dsr_alpha: float = 0.05
    parameter_bounds: StrategyParameterBounds = field(default_factory=StrategyParameterBounds)
    transaction_costs: TransactionCostConfig = field(default_factory=TransactionCostConfig)


DEFAULT_EVOLVER_CONFIG = EvolverConfig()


@dataclass
class BootstrapCI:
    """Bootstrap 置信区间结果。"""
    mean: float = 0.0
    std: float = 0.0
    ci_95: tuple[float, float] = (0.0, 0.0)
    ci_99: tuple[float, float] = (0.0, 0.0)


@dataclass
class BootstrapResult:
    """Bootstrap 完整结果，含各指标的置信区间。"""
    sharpe: BootstrapCI = field(default_factory=BootstrapCI)
    dsr: BootstrapCI = field(default_factory=BootstrapCI)
    sortino: BootstrapCI = field(default_factory=BootstrapCI)
    max_drawdown: BootstrapCI = field(default_factory=BootstrapCI)


@dataclass
class CVaRResult:
    """Conditional VaR / Expected Shortfall。"""
    cvar_95: float = 0.0
    cvar_99: float = 0.0
    cvar_995: float = 0.0
    es_95: float = 0.0
    es_99: float = 0.0
    es_995: float = 0.0


@dataclass
class DrawdownAnalytics:
    """回撤分析指标。"""
    max_drawdown: float = 0.0
    avg_drawdown: float = 0.0
    max_dd_duration: int = 0       # 最大回撤持续天数
    recovery_time: int = 0          # 从最大回撤恢复所需天数
    ulcer_index: float = 0.0        # Ulcer Index（平方根均方回撤百分比）
    calmar_ratio: float = 0.0       # Calmar Ratio（年化收益 / 最大回撤）


@dataclass
class MRCResult:
    """Marginal Risk Contribution 结果。"""
    mrc: dict[str, float] = field(default_factory=dict)   # 各资产 MRC
    component_var: dict[str, float] = field(default_factory=dict)
    total_var: float = 0.0


@dataclass
class RegimeResult:
    """Regime detection 结果。"""
    current_regime: int = 1                 # 0=Bull, 1=Sideways, 2=Bear
    regime_label: str = "Sideways"
    regime_probs: list[float] = field(default_factory=lambda: [0.33, 0.34, 0.33])
    regime_labels_series: list[int] = field(default_factory=list)
    regime_covariances: list[list[list[float]]] = field(default_factory=list)
    regime_returns: list[float] = field(default_factory=list)
    regime_volatilities: list[float] = field(default_factory=list)


@dataclass
class SyntheticScenarioResult:
    """合成压力场景结果。"""
    scenario: str = ""
    n_paths: int = 0
    mean_return: float = 0.0
    var_95: float = 0.0
    var_99: float = 0.0
    cvar_95: float = 0.0
    max_drawdown: float = 0.0
    final_values_p5: float = 0.0
    final_values_p95: float = 0.0


@dataclass
class SobolResult:
    """Sobol 敏感性分析结果。"""
    first_order: dict[str, float] = field(default_factory=dict)
    total_order: dict[str, float] = field(default_factory=dict)
    confidence_first: dict[str, tuple[float, float]] = field(default_factory=dict)
    confidence_total: dict[str, tuple[float, float]] = field(default_factory=dict)


@dataclass
class DriftResult:
    """实盘漂移检测结果。"""
    psi: float = 0.0
    ks_statistic: float = 0.0
    ks_p_value: float = 1.0
    alert: bool = False
    window_start: str = ""
    window_end: str = ""


@dataclass
class StrategyReportData:
    timestamp: str = ""
    config: EvolverConfig = field(default_factory=EvolverConfig)
    efficient_frontier: EfficientFrontier = field(default_factory=EfficientFrontier)
    monte_carlo_result: MonteCarloResult = field(default_factory=MonteCarloResult)
    walk_forward_summary: WalkForwardSummary = field(default_factory=WalkForwardSummary)
    stability_report: StabilityReport = field(default_factory=StabilityReport)
    pbo_result: PboResult = field(default_factory=PboResult)
    recommended_params: StrategyParameterSet = field(default_factory=StrategyParameterSet)
    # 新增字段
    bootstrap_result: dict = field(default_factory=dict)
    cvar_result: CVaRResult = field(default_factory=CVaRResult)
    drawdown_analytics: DrawdownAnalytics = field(default_factory=DrawdownAnalytics)
    mrc_result: MRCResult = field(default_factory=MRCResult)
    regime_result: RegimeResult = field(default_factory=RegimeResult)
    synthetic_results: list[SyntheticScenarioResult] = field(default_factory=list)
    sobol_result: SobolResult = field(default_factory=SobolResult)
    drift_result: DriftResult = field(default_factory=DriftResult)
