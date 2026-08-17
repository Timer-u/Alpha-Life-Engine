"""Tests for config.py module."""

"""Tests for config.py module."""

import tempfile
from pathlib import Path

import yaml
from config import load_config, load_regime_lookback, load_synthetic_n_paths
from models import EvolverConfig


def test_load_config_default():
    config = load_config(path="nonexistent.yaml")
    assert isinstance(config, EvolverConfig)
    assert config.transaction_costs.etf_bps == 3.0
    assert config.transaction_costs.etf_min_yuan == 5.0
    assert config.transaction_costs.mmf_bps == 0.0


def test_load_config_custom():
    cfg = {
        "transaction_costs": {"etf_bps": 5.0, "etf_min_yuan": 0.0, "mmf_bps": 0.0},
        "synthetic": {"n_paths_per_scenario": 1000},
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        yaml.dump(cfg, f)
        tmp_path = Path(f.name)

    try:
        config = load_config(path=str(tmp_path))
        assert config.transaction_costs.etf_bps == 5.0
        assert config.transaction_costs.etf_min_yuan == 0.0
        n_paths = load_synthetic_n_paths(path=str(tmp_path))
        assert n_paths == 1000
    finally:
        tmp_path.unlink()


def test_load_regime_lookback():
    cfg = {"regime": {"lookback_months": 6}}
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        yaml.dump(cfg, f)
        tmp_path = Path(f.name)

    try:
        lookback = load_regime_lookback(path=str(tmp_path))
        assert lookback == 6 * 21  # 126 days
    finally:
        tmp_path.unlink()


def test_load_config_new_rules_defaults():
    config = load_config(path="nonexistent.yaml")
    assert config.transaction_costs.etf_spread == 0.002
    assert config.dca.price_limit == 0.10
    assert config.dca.lot_size == 100
    assert config.mc_estimate_window_days == 252


def test_load_config_new_rules_custom():
    cfg = {
        "transaction_costs": {"etf_spread": 0.001},
        "dca": {"price_limit": 0.05, "lot_size": 200},
        "mc": {"estimate_window_days": 126},
    }
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
        yaml.dump(cfg, f)
        tmp_path = Path(f.name)
    try:
        config = load_config(path=str(tmp_path))
        assert config.transaction_costs.etf_spread == 0.001
        assert config.dca.price_limit == 0.05
        assert config.dca.lot_size == 200
        assert config.mc_estimate_window_days == 126
    finally:
        tmp_path.unlink()
