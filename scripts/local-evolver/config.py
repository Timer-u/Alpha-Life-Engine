"""Configuration loader for config.yaml."""

import os
from typing import Optional

import yaml

from models import (
    DEFAULT_EVOLVER_CONFIG,
    EvolverConfig,
    StrategyParameterBounds,
    TransactionCostConfig,
)


def load_config(path: Optional[str] = None) -> EvolverConfig:
    """从 config.yaml 加载配置，合并到 EvolverConfig。

    Args:
        path: YAML 配置文件路径。默认查找 scripts/local-evolver/config.yaml
    """
    if path is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(script_dir, "config.yaml")

    if not os.path.exists(path):
        return DEFAULT_EVOLVER_CONFIG

    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    if cfg is None:
        return DEFAULT_EVOLVER_CONFIG

    config = EvolverConfig()

    tc = cfg.get("transaction_costs", {})
    etf_bps = float(tc.get("etf_bps", 3.0))
    etf_min_yuan = float(tc.get("etf_min_yuan", 5.0))
    mmf_bps = float(tc.get("mmf_bps", 0.0))
    if etf_bps < 0:
        raise ValueError(f"etf_bps must be >= 0, got {etf_bps}")
    if etf_min_yuan < 0:
        raise ValueError(f"etf_min_yuan must be >= 0, got {etf_min_yuan}")
    config.transaction_costs = TransactionCostConfig(
        etf_bps=etf_bps,
        etf_min_yuan=etf_min_yuan,
        mmf_bps=mmf_bps,
    )

    synthetic_cfg = cfg.get("synthetic", {})
    config.gbm_paths = int(synthetic_cfg.get("n_paths_per_scenario", config.gbm_paths))

    return config


def load_regime_lookback(path: Optional[str] = None) -> int:
    """从配置加载 regime lookback。"""
    if path is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(script_dir, "config.yaml")

    if not os.path.exists(path):
        return 63

    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    return int(cfg.get("regime", {}).get("lookback_months", 3)) * 21


def load_synthetic_n_paths(path: Optional[str] = None) -> int:
    if path is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(script_dir, "config.yaml")

    if not os.path.exists(path):
        return 5000

    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    return int(cfg.get("synthetic", {}).get("n_paths_per_scenario", 5000))


def load_bootstrap_config(path: Optional[str] = None) -> dict:
    if path is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(script_dir, "config.yaml")

    if not os.path.exists(path):
        return {"n_resamples": 1000, "block_size": 5, "ci_levels": [0.95, 0.99]}

    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    return cfg.get("bootstrap", {"n_resamples": 1000, "block_size": 5, "ci_levels": [0.95, 0.99]})


def load_drift_config(path: Optional[str] = None) -> dict:
    if path is None:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        path = os.path.join(script_dir, "config.yaml")

    if not os.path.exists(path):
        return {"window_months": 12, "psi_threshold": 0.25, "ks_threshold": 0.05}

    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)

    return cfg.get("drift", {"window_months": 12, "psi_threshold": 0.25, "ks_threshold": 0.05})
