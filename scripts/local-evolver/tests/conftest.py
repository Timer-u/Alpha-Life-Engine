"""Pytest configuration and shared fixtures."""

import pytest
import numpy as np
import torch

from models import (
    DataFrame,
    MarketDataInput,
    StrategyParameterBounds,
    StrategyParameterSet,
    DEFAULT_EVOLVER_CONFIG,
)


@pytest.fixture
def sample_market_data() -> MarketDataInput:
    np.random.seed(42)
    n_days = 500
    base_prices = {
        "511360": 100.0,
        "511880": 100.0,
        "000300": 4000.0,
        "000905": 6000.0,
        "000922": 3000.0,
    }
    symbols = {}
    for sym, base in base_prices.items():
        returns = np.random.normal(0.0002, 0.01, n_days)
        prices = base * np.cumprod(1 + returns)
        dates = [f"2023-{i//30+1:02d}-{i%30+1:02d}" for i in range(n_days)]
        symbols[sym] = DataFrame(
            dates=dates,
            close=prices.tolist(),
            open=(prices * 0.999).tolist(),
            high=(prices * 1.002).tolist(),
            low=(prices * 0.998).tolist(),
            volume=[1000000] * n_days,
        )
    return MarketDataInput(symbols=symbols)


@pytest.fixture
def sample_params() -> StrategyParameterSet:
    return StrategyParameterSet(
        trigger_line=1667,
        safe_ratio=0.6,
        ambition_ratio=0.4,
        bsm_threshold=1.4,
        ma_short_window=20,
        ma_long_window=60,
        safe_allocation={"511360": 0.8, "511880": 0.2},
        ambition_allocation={"000300": 0.4, "000905": 0.4, "000922": 0.2},
    )


@pytest.fixture
def sample_bounds() -> StrategyParameterBounds:
    return StrategyParameterBounds(
        trigger_line=(1000, 3000),
        safe_ratio=(0.3, 0.8),
        ambition_ratio=(0.2, 0.7),
        bsm_threshold=(1.0, 2.0),
        ma_short_window=(5, 50),
        ma_long_window=(20, 200),
        safe_allocation={"511360": (0, 1), "511880": (0, 1)},
        ambition_allocation={"000300": (0, 1), "000905": (0, 1), "000922": (0, 1)},
    )


@pytest.fixture
def device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")