"""Fetch market data from the backend API."""

import logging
import os

import requests
from models import DataFrame, MarketDataInput
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger(__name__)

try:
    # 单一事实源 scripts/symbols.ts → npm run symbols:sync 生成
    from generated_symbols import TRACKED_SYMBOLS as _GENERATED_SYMBOLS
except ImportError:  # pragma: no cover - 生成文件缺失时兜底
    _GENERATED_SYMBOLS = []

if _GENERATED_SYMBOLS:
    TRACKED_SYMBOLS = _GENERATED_SYMBOLS
else:
    TRACKED_SYMBOLS = [  # 与 scripts/symbols.ts 人工对齐；改动宇宙后请运行 npm run symbols:sync
        "511360",
        "511880",
        "511990",
        "510300",
        "510500",
        "515080",
    ]


def _get_session_token() -> str:
    token = os.environ.get("SESSION_TOKEN", "")
    if not token:
        msg = (
            "SESSION_TOKEN environment variable not set. "
            "Login via web UI and copy the session_token cookie."
        )
        raise RuntimeError(msg)
    return token


def _create_retry_session() -> requests.Session:
    session = requests.Session()
    retries = Retry(
        total=3, backoff_factor=1.0, status_forcelist=[429, 500, 502, 503, 504]
    )
    session.mount("http://", HTTPAdapter(max_retries=retries))
    session.mount("https://", HTTPAdapter(max_retries=retries))
    return session


def _parse_rows(rows: list[dict]) -> dict[str, dict]:
    """API 行 → 逐标的 OHLCV 列。

    - close 为 NULL 的行直接丢弃（下载脚本允许 NULL 入库）：静默转 0.0 会在
      WF 路径注入 −100% 日收益、在 MPT 路径让 compute_returns_from_prices
      返回空导致全部折静默跳过；丢弃并告警，缺失日交给下游日期对齐处理
    - 每标的行按日期升序排序（不依赖 API 返回顺序）
    """
    by_symbol: dict[str, dict] = {}
    dropped: dict[str, int] = {}
    for row in rows:
        sym = row["symbol"]
        if row.get("close") is None:
            dropped[sym] = dropped.get(sym, 0) + 1
            continue
        entry = by_symbol.setdefault(
            sym,
            {"rows": []},
        )
        entry["rows"].append(row)
    if dropped:
        logger.warning(
            "dropped %d NULL-close rows (upstream download allows NULL): %s",
            sum(dropped.values()),
            dropped,
        )

    parsed: dict[str, dict] = {}
    for sym, entry in by_symbol.items():
        rows_sorted = sorted(entry["rows"], key=lambda r: r["date"])
        parsed[sym] = {
            "dates": [r["date"] for r in rows_sorted],
            "open": [
                float(r["open"]) if r.get("open") is not None else 0.0
                for r in rows_sorted
            ],
            "high": [
                float(r["high"]) if r.get("high") is not None else 0.0
                for r in rows_sorted
            ],
            "low": [
                float(r["low"]) if r.get("low") is not None else 0.0
                for r in rows_sorted
            ],
            "close": [float(r["close"]) for r in rows_sorted],
            "volume": [
                int(r["volume"]) if r.get("volume") is not None else 0
                for r in rows_sorted
            ],
        }
    return parsed


def fetch_market_data(api_base_url: str) -> MarketDataInput:
    token = _get_session_token()
    url = f"{api_base_url}/api/market-data/history"

    session = _create_retry_session()
    resp = session.get(url, cookies={"session_token": token}, timeout=120)
    resp.raise_for_status()
    body = resp.json()

    if not body.get("success"):
        msg = f"API error: {body.get('error', 'unknown')}"
        raise RuntimeError(msg)

    rows = body.get("data", [])
    if not isinstance(rows, list):
        msg = f"API returned non-list data: {type(rows).__name__}"
        raise TypeError(msg)

    parsed = _parse_rows(rows)

    symbols = {}
    for sym in TRACKED_SYMBOLS:
        d = parsed.get(sym)
        if d is not None:
            symbols[sym] = DataFrame(
                dates=d["dates"],
                close=d["close"],
                open=d["open"],
                high=d["high"],
                low=d["low"],
                volume=d["volume"],
            )
        else:
            symbols[sym] = DataFrame(
                dates=[], close=[], open=[], high=[], low=[], volume=[]
            )

    return MarketDataInput(symbols=symbols)
