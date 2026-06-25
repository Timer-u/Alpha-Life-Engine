# Strategy Evolver

Python-based strategy optimization engine located at `scripts/local-evolver/`.

## Overview

The evolver performs walk-forward optimization with combinatorial purged cross-validation (CPCV) to find robust strategy parameters. It applies Deflated Sharpe Ratio (DSR) for ranking and Probability of Backtest Overfitting (PBO) for filtering.

## Pipeline

```
Market Data (CSV) → CPCV → Purge/Embargo → MPT Efficient Frontier
    → Walk-Forward Optimization → DSR Ranking → PBO Filter
    → Monte Carlo Stress Test → Sensitivity Analysis
    → Strategy Report → PATCH to Cloudflare API
```

## Modules

### `mpt.py` — Modern Portfolio Theory

- Computes the efficient frontier using CPCV-generated return paths
- Applies purge (removal of overlapping data) and embargo (gap between train/test)
- Outputs optimal weight allocations for the safe/ambition layer split

### `cpcv.py` — Combinatorial Purged Cross-Validation

- Generates multiple independent return paths from historical data
- Each path represents a different train/test split combination
- Returns distribution of Sharpe ratios across all paths

### `walk_forward.py` — Walk-Forward Optimization

- Iterates through time with rolling training windows
- Optimizes parameters on each training window
- Tests on out-of-sample data
- Produces parameter stability metrics

### `dsr.py` — Deflated Sharpe Ratio

- Adjusts Sharpe ratio for multiple testing (data snooping bias)
- Accounts for the number of trials, return distribution, and track record length
- Ranks parameter sets by DSR value

### `stability.py` — Stability Analysis

- Computes PBO (Probability of Backtest Overfitting)
- PBO > 50% → auto-reject parameter set
- Checks parameter consistency across training windows

### `sensitivity.py` — Sensitivity Analysis

- Examines gradient around optimal parameters
- Verifies that small parameter changes don't cause drastic performance drops
- Flags unstable optima

### `monte_carlo.py` — Monte Carlo Simulation

- Generates thousands of Geometric Brownian Motion (GBM) paths
- Tests strategy robustness across synthetic market scenarios
- Computes VaR, CVaR, and max drawdown distributions

### `risk.py` — Risk Metrics

- VaR (Value at Risk)
- CVaR (Conditional Value at Risk)
- Maximum drawdown
- Calmar ratio

### `regime.py` — Regime Detection

- Identifies market regimes (bull, bear, sideways, high/low volatility)
- Tests strategy performance across regimes
- Flags regime-specific vulnerabilities

### `report.py` — Report Generation

- Compiles all results into a structured report
- Generates JSON report for PATCH to Cloudflare API
- Saves HTML summary for local review

### `config.py` / `config.yaml` — Configuration

- Data paths
- CPCV parameters (test_size, embargo, purge)
- Walk-forward parameters (train_window, test_window, step)
- Monte Carlo parameters (n_simulations, time_horizon)

### `data.py` — Data Loading

- Loads market data CSV files
- Computes returns, volatility, correlations
- Handles missing data and outlier removal

## Usage

```bash
# Install dependencies
pip install -r scripts/local-evolver/requirements.txt

# Run full evolution
npm run evolve

# Or directly
python scripts/local-evolver/evolver.py
```

## Dependencies

- torch 2.5.1
- numpy 1.26.4
- pandas 2.2.3
- scikit-learn 1.6.0
- scipy 1.14.1
- click 8.1.7
- pyyaml 6.0.2
- requests 2.32.3

## Output

The evolver generates a strategy report and pushes it to:

```
PATCH /api/strategy/report
```

The report includes:
- Optimal parameter set
- DSR ranking
- PBO score
- Status color (green/yellow/red based on days since evolution + PBO)
- Next scheduled evolution timestamp
