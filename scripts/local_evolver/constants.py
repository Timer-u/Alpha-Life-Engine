"""Domain constants for the Alpha-Life strategy evolver.

2026-08-22 清理：本文件曾经声称是"唯一事实源"，但其中绝大多数常量
（参数默认值/搜索边界/各模块默认数）无任何引用，且与实际默认相互矛盾
（如 SYNTHETIC_DEFAULT_PATHS=500 vs 实际 5000、REGIME lookback=6 vs
实际 3 个月）。真正的单一事实源是：

- 参数默认值与搜索边界 → models.StrategyParameterSet / StrategyParameterBounds
- DCA / 交易成本默认 → models.DcaConfig / TransactionCostConfig（config.yaml 可覆盖）
- 各流程参数默认 → EvolverConfig / 各函数签名默认值

此处只保留真正被跨模块引用的常量。
"""

from __future__ import annotations

# ============================================================================
# Trading Calendar & Time
# ============================================================================
REBALANCE_FREQUENCY_DAYS: int = 21  # Monthly rebalance (~21 trading days)

# ============================================================================
# Monte Carlo
# ============================================================================
MC_DEFAULT_ESTIMATE_WINDOW_DAYS: int = 252  # 漂移/波动估计窗口（交易日）
MC_MIN_PATHS_FOR_CVAR: int = 100  # CVaR 估计所需的最少路径数

# ============================================================================
# Risk-Free Rate
# ============================================================================
DEFAULT_RISK_FREE_RATE: float = 0.025  # 2.5% annual risk-free rate

# ============================================================================
# Reproducibility
# ============================================================================
DEFAULT_SEED: int = 42  # Deterministic default RNG seed for the whole pipeline

# ============================================================================
# Minimum Observations for Statistical Validity
# ============================================================================
# 63 trading days ≈ one trading quarter. Below this, a daily-Sharpe estimate
# has unacceptably wide sampling error and skew/kurtosis estimates are noise.
# These are HARD gates in the walk-forward scoring path (C5): insufficient
# data must fail loudly instead of producing a meaningless score.
MIN_OBS_FOR_SHARPE: int = 63
MIN_OBS_FOR_SKEW: int = 63
MIN_OBS_FOR_KURTOSIS: int = 63
MIN_OBS_FOR_DRIFT: int = 63
MIN_OBS_FOR_BOOTSTRAP: int = 63
