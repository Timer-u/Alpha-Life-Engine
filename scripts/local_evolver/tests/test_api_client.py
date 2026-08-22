"""Tests for api_client.py — data-integrity first gate.

2026-08-22 审计盲区：api_client 此前零测试（NULL 毒化 / 非 200 /
行序假设全未覆盖）。
"""

from unittest.mock import MagicMock, patch

import pytest
import requests as requests_mod
from api_client import _parse_rows, fetch_market_data
from models import MarketDataInput


def _row(symbol: str, date: str, close: float | None, volume: int | None = 1000):
    return {
        "symbol": symbol,
        "date": date,
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "volume": volume,
    }


class TestParseRows:
    def test_null_close_rows_are_dropped_not_zeroed(self):
        rows = [
            _row("511880", "2026-01-02", 100.0),
            _row("511880", "2026-01-03", None),
            _row("511880", "2026-01-04", 101.0),
        ]
        parsed = _parse_rows(rows)
        assert parsed["511880"]["dates"] == ["2026-01-02", "2026-01-04"]
        assert parsed["511880"]["close"] == [100.0, 101.0]

    def test_rows_sorted_by_date_regardless_of_api_order(self):
        rows = [
            _row("511880", "2026-01-05", 103.0),
            _row("511880", "2026-01-02", 100.0),
            _row("511880", "2026-01-04", 102.0),
        ]
        parsed = _parse_rows(rows)
        assert parsed["511880"]["dates"] == ["2026-01-02", "2026-01-04", "2026-01-05"]
        assert parsed["511880"]["close"] == [100.0, 102.0, 103.0]

    def test_null_volume_becomes_zero_but_row_kept(self):
        rows = [_row("510300", "2026-01-02", 4.0, volume=None)]
        parsed = _parse_rows(rows)
        assert parsed["510300"]["volume"] == [0]
        assert parsed["510300"]["close"] == [4.0]

    def test_empty_rows(self):
        assert _parse_rows([]) == {}


class TestFetchMarketData:
    def test_success_payload_maps_all_tracked_symbols(self, monkeypatch):
        monkeypatch.setenv("SESSION_TOKEN", "tok")
        payload = {
            "success": True,
            "data": [
                _row("511880", "2026-01-02", 100.0),
                _row("510300", "2026-01-02", 4.0),
            ],
        }
        resp = MagicMock()
        resp.json.return_value = payload
        resp.raise_for_status.return_value = None
        with patch("api_client.requests.Session.get", return_value=resp):
            data = fetch_market_data("http://localhost:8787")
        assert isinstance(data, MarketDataInput)
        assert data.symbols["511880"].close == [100.0]
        # 未返回的跟踪标的 → 空 DataFrame（下游 loud-fail），非 KeyError
        assert data.symbols["515080"].close == []

    def test_success_false_raises(self, monkeypatch):
        monkeypatch.setenv("SESSION_TOKEN", "tok")
        resp = MagicMock()
        resp.json.return_value = {"success": False, "error": "Unauthorized"}
        resp.raise_for_status.return_value = None
        with (
            patch("api_client.requests.Session.get", return_value=resp),
            pytest.raises(RuntimeError, match="Unauthorized"),
        ):
            fetch_market_data("http://localhost:8787")

    def test_non_list_data_raises(self, monkeypatch):
        monkeypatch.setenv("SESSION_TOKEN", "tok")
        resp = MagicMock()
        resp.json.return_value = {"success": True, "data": {"oops": True}}
        resp.raise_for_status.return_value = None
        with (
            patch("api_client.requests.Session.get", return_value=resp),
            pytest.raises(TypeError, match="non-list"),
        ):
            fetch_market_data("http://localhost:8787")

    def test_http_error_propagates(self, monkeypatch):
        monkeypatch.setenv("SESSION_TOKEN", "tok")

        resp = MagicMock()
        resp.raise_for_status.side_effect = requests_mod.HTTPError("500")
        with (
            patch("api_client.requests.Session.get", return_value=resp),
            pytest.raises(requests_mod.HTTPError),
        ):
            fetch_market_data("http://localhost:8787")

    def test_missing_session_token_raises(self, monkeypatch):
        monkeypatch.delenv("SESSION_TOKEN", raising=False)
        with pytest.raises(RuntimeError, match="SESSION_TOKEN"):
            fetch_market_data("http://localhost:8787")
