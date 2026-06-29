"""Fetch market data from the backend API."""

import os

import requests
from models import DataFrame, MarketDataInput
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

TRACKED_SYMBOLS = ["511360", "511880", "000300", "000905", "000922"]


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


def fetch_market_data(api_base_url: str) -> MarketDataInput:
    token = _get_session_token()
    url = f"{api_base_url}/market-data/history"

    session = _create_retry_session()
    resp = session.get(url, cookies={"session_token": token}, timeout=120)
    resp.raise_for_status()
    body = resp.json()

    if not body.get("success"):
        msg = f"API error: {body.get('error', 'unknown')}"
        raise RuntimeError(msg)

    rows = body.get("data", [])
    by_symbol: dict[str, dict] = {}
    for row in rows:
        sym = row["symbol"]
        if sym not in by_symbol:
            by_symbol[sym] = {
                "dates": [],
                "open": [],
                "high": [],
                "low": [],
                "close": [],
                "volume": [],
            }
        by_symbol[sym]["dates"].append(row["date"])
        by_symbol[sym]["open"].append(
            float(row["open"]) if row["open"] is not None else 0.0
        )
        by_symbol[sym]["high"].append(
            float(row["high"]) if row["high"] is not None else 0.0
        )
        by_symbol[sym]["low"].append(
            float(row["low"]) if row["low"] is not None else 0.0
        )
        by_symbol[sym]["close"].append(
            float(row["close"]) if row["close"] is not None else 0.0
        )
        by_symbol[sym]["volume"].append(
            int(row["volume"]) if row["volume"] is not None else 0
        )

    symbols = {}
    for sym in TRACKED_SYMBOLS:
        if sym in by_symbol:
            d = by_symbol[sym]
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
