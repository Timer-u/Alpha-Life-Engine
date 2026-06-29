"""Domain constants for the Alpha-Life strategy evolver.

All magic numbers with business meaning are centralized here.
Import these constants instead of using raw literals in business logic.
"""

from __future__ import annotations

# ============================================================================
# Trading Calendar & Time
# ============================================================================
TRADING_DAYS_PER_YEAR: int = 252  # A-share trading days per year
TRADING_DAYS_PER_MONTH: int = 21  # Approximate trading days per month
TRADING_DAYS_PER_WEEK: int = 5
REBALANCE_FREQUENCY_DAYS: int = 21  # Monthly rebalance (~21 trading days)

# ============================================================================
# Strategy Default Parameters
# ============================================================================
DEFAULT_TRIGGER_LINE: int = 1667  # Default trigger line in yuan
DEFAULT_SAFE_RATIO: float = 0.6  # Default safe asset allocation ratio
DEFAULT_AMBITION_RATIO: float = 0.4  # Default ambition asset allocation ratio
DEFAULT_BSM_THRESHOLD: float = 1.4  # Default BSM threshold
DEFAULT_MA_SHORT_WINDOW: int = 20  # Default short MA window (days)
DEFAULT_MA_LONG_WINDOW: int = 60  # Default long MA window (days)

# ============================================================================
# Parameter Search Bounds
# ============================================================================
TRIGGER_LINE_MIN: int = 1000
TRIGGER_LINE_MAX: int = 3000
SAFE_RATIO_MIN: float = 0.3
SAFE_RATIO_MAX: float = 0.8
AMBITION_RATIO_MIN: float = 0.2
AMBITION_RATIO_MAX: float = 0.7
BSM_THRESHOLD_MIN: float = 1.0
BSM_THRESHOLD_MAX: float = 2.0
MA_SHORT_WINDOW_MIN: int = 5
MA_SHORT_WINDOW_MAX: int = 50
MA_LONG_WINDOW_MIN: int = 20
MA_LONG_WINDOW_MAX: int = 200

# ============================================================================
# Transaction Costs
# ============================================================================
ETF_COMMISSION_BPS: float = 3.0  # ETF commission in basis points (万三)
ETF_MIN_COMMISSION_YUAN: float = 5.0  # Minimum commission per trade (yuan)
MMF_COMMISSION_BPS: float = 0.0  # Money market fund: ~zero cost
ETF_BPS_TO_RATIO: float = 10000.0  # Convert basis points to decimal

# ============================================================================
# Walk-Forward Optimization
# ============================================================================
WF_DEFAULT_NUM_WINDOWS: int = 6
WF_DEFAULT_TRAIN_RATIO: float = 0.7
WF_DEFAULT_NUM_PARAM_SETS: int = 200
WF_MIN_OBSERVATIONS: int = 50

# ============================================================================
# Monte Carlo Simulation
# ============================================================================
MC_DEFAULT_DAYS: int = 252
MC_DEFAULT_PATHS: int = 10000
MC_MIN_PATHS_FOR_CVAR: int = 100

# ============================================================================
# Efficient Frontier
# ============================================================================
EF_DEFAULT_POINTS: int = 50
EF_MIN_POINTS: int = 10

# ============================================================================
# CP-CV (Combinatorial Purged Cross-Validation)
# ============================================================================
CPCV_DEFAULT_GROUPS: int = 10
CPCV_DEFAULT_TEST_SIZE: float = 0.2
CPCV_DEFAULT_SPLITS: int = 10
CPCV_DEFAULT_PURGE_DAYS: int = 5
CPCV_DEFAULT_EMBARGO_DAYS: int = 5

# ============================================================================
# Risk-Free Rate
# ============================================================================
DEFAULT_RISK_FREE_RATE: float = 0.025  # 2.5% annual risk-free rate

# ============================================================================
# Stability & PBO
# ============================================================================
STABILITY_NEIGHBORHOOD_RADIUS: float = 0.05
STABILITY_GRADIENT_THRESHOLD: float = 0.1
PBO_REJECTION_THRESHOLD: float = 0.5
DSR_ALPHA: float = 0.05

# ============================================================================
# Regime Detection
# ============================================================================
REGIME_N_STATES: int = 3  # Bull / Sideways / Bear
REGIME_DEFAULT_LOOKBACK_MONTHS: int = 6
REGIME_HYSTERESIS_WINDOW: int = 21

# ============================================================================
# Bootstrap
# ============================================================================
BOOTSTRAP_DEFAULT_RESAMPLES: int = 1000
BOOTSTRAP_DEFAULT_BLOCK_SIZE: int = 5

# ============================================================================
# Sobol Sensitivity
# ============================================================================
SOBOL_DEFAULT_N_SAMPLES: int = 2048

# ============================================================================
# Synthetic Scenario Generation
# ============================================================================
SYNTHETIC_DEFAULT_PATHS: int = 500
SYNTHETIC_FAT_TAIL_DOF: float = 3.0  # t-distribution degrees of freedom

# ============================================================================
# Minimum Observations for Statistical Validity
# ============================================================================
MIN_OBS_FOR_SHARPE: int = 5  # Minimum returns for Sharpe ratio
MIN_OBS_FOR_SKEW: int = 3  # Minimum returns for skewness
MIN_OBS_FOR_KURTOSIS: int = 4  # Minimum returns for kurtosis
MIN_OBS_FOR_DRIFT: int = 20  # Minimum returns for drift detection
MIN_OBS_FOR_BOOTSTRAP: int = 10  # Minimum returns for bootstrap CI

# ============================================================================
# Numerical Constants
# ============================================================================
EPSILON: float = 1e-15  # Numerical zero
EULER_MASCHERONI: float = 0.5772156649  # Euler-Mascheroni constant
