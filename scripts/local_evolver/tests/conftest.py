"""Pytest configuration and shared fixtures."""

import numpy as np
import pytest
import torch
from models import (
    DataFrame,
    MarketDataInput,
    StrategyParameterBounds,
    StrategyParameterSet,
)


@pytest.fixture
def sample_market_data() -> MarketDataInput:
    np.random.seed(42)
    n_days = 500
    base_prices = {
        "511360": 113.0,
        "511880": 100.0,
        "511990": 100.0,
        "510300": 4.0,
        "510500": 6.0,
        "515080": 1.5,
    }
    safe_funds = {"511360", "511880", "511990"}
    ambition_etfs = {"510300", "510500", "515080"}
    symbols = {}
    for sym, base in base_prices.items():
        vol = 0.0002 if sym in safe_funds else 0.01
        returns = np.random.normal(0.0002, vol, n_days)
        if sym in ambition_etfs:
            # Inject a -40% single-day crash (day 300) so the ambition composite
            # experiences a real panic episode: panic_ratio jumps to ~1.7 then
            # decays through the 1.4 bsm_threshold band over ~20 days. Without it
            # the fixture's max panic is ~1.09, so bsm_threshold and the MA-window
            # SKIP/BSM interplay would be inert in the scoring tests.
            returns[300] -= 0.4
        prices = base * np.cumprod(1 + returns)
        dates = [f"2023-{i // 30 + 1:02d}-{i % 30 + 1:02d}" for i in range(n_days)]
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
        safe_allocation={"511880": 0.5, "511990": 0.3, "511360": 0.2},
        ambition_allocation={"510300": 0.4, "510500": 0.4, "515080": 0.2},
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
        safe_allocation={"511880": (0, 1), "511990": (0, 1), "511360": (0, 1)},
        ambition_allocation={"510300": (0, 1), "510500": (0, 1), "515080": (0, 1)},
    )


@pytest.fixture
def device() -> torch.device:
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")
