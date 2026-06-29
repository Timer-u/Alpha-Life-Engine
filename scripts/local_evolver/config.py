"""Configuration loader for config.yaml."""

from pathlib import Path

import yaml
from models import (
    DEFAULT_EVOLVER_CONFIG,
    EvolverConfig,
    TransactionCostConfig,
)


def _resolve_config_path(path: str | None) -> Path:
    if path is not None:
        return Path(path)
    return Path(__file__).resolve().parent / "config.yaml"


def _load_yaml(path: Path) -> dict | None:
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_config(path: str | None = None) -> EvolverConfig:
    """从 config.yaml 加载配置，合并到 EvolverConfig。

    Args:
        path: YAML 配置文件路径。默认查找 scripts/local_evolver/config.yaml
    """
    p = _resolve_config_path(path)
    cfg = _load_yaml(p)

    if cfg is None:
        return DEFAULT_EVOLVER_CONFIG

    config = EvolverConfig()

    tc = cfg.get("transaction_costs", {})
    etf_bps = float(tc.get("etf_bps", 3.0))
    etf_min_yuan = float(tc.get("etf_min_yuan", 5.0))
    mmf_bps = float(tc.get("mmf_bps", 0.0))
    if etf_bps < 0:
        msg = f"etf_bps must be >= 0, got {etf_bps}"
        raise ValueError(msg)
    if etf_min_yuan < 0:
        msg = f"etf_min_yuan must be >= 0, got {etf_min_yuan}"
        raise ValueError(msg)
    config.transaction_costs = TransactionCostConfig(
        etf_bps=etf_bps,
        etf_min_yuan=etf_min_yuan,
        mmf_bps=mmf_bps,
    )

    synthetic_cfg = cfg.get("synthetic", {})
    config.gbm_paths = int(synthetic_cfg.get("n_paths_per_scenario", config.gbm_paths))

    return config


def load_regime_lookback(path: str | None = None) -> int:
    """从配置加载 regime lookback。"""
    p = _resolve_config_path(path)
    cfg = _load_yaml(p)

    if cfg is None:
        return 63

    return int(cfg.get("regime", {}).get("lookback_months", 3)) * 21


def load_synthetic_n_paths(path: str | None = None) -> int:
    p = _resolve_config_path(path)
    cfg = _load_yaml(p)

    if cfg is None:
        return 5000

    return int(cfg.get("synthetic", {}).get("n_paths_per_scenario", 5000))


def load_bootstrap_config(path: str | None = None) -> dict:
    p = _resolve_config_path(path)
    cfg = _load_yaml(p)

    if cfg is None:
        return {"n_resamples": 1000, "block_size": 5, "ci_levels": [0.95, 0.99]}

    return cfg.get(
        "bootstrap", {"n_resamples": 1000, "block_size": 5, "ci_levels": [0.95, 0.99]}
    )


def load_drift_config(path: str | None = None) -> dict:
    p = _resolve_config_path(path)
    cfg = _load_yaml(p)

    if cfg is None:
        return {"window_months": 12, "psi_threshold": 0.25, "ks_threshold": 0.05}

    return cfg.get(
        "drift", {"window_months": 12, "psi_threshold": 0.25, "ks_threshold": 0.05}
    )
