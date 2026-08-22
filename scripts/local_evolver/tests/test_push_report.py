"""Tests for report.push_report_to_cloud — 推送契约与重试。

2026-08-22 审计盲区：push_report_to_cloud 此前零测试；一个 zod 契约
测试即可抓住"naive 时间戳被服务端 .datetime() 拒绝 → 整轮演化结果丢弃"
的 P1（该链路修复前从未成功过）。
"""

import json
import re
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import requests
from models import StrategyReportData, WalkForwardSummary
from report import push_report_to_cloud, save_report_locally, utc_now_iso

# 服务端 strategy.ts 的 zod `.datetime()` 默认只接受 UTC `Z` 后缀
# （拒绝 naive 与 +00:00 偏移）
ZOD_DATETIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")


def _report(timestamp: str | None = None) -> StrategyReportData:
    return StrategyReportData(
        timestamp=timestamp or utc_now_iso(),
        walk_forward_summary=WalkForwardSummary(dsr_rankings=[0.7]),
    )


class TestTimestampContract:
    def test_utc_now_iso_matches_zod_datetime(self):
        assert ZOD_DATETIME_RE.match(utc_now_iso())

    def test_payload_timestamps_pass_zod_datetime(self):
        report = _report()
        resp = MagicMock()
        resp.ok = True
        captured = {}

        def _capture(url, json=None, cookies=None, timeout=None):
            captured["payload"] = json
            return resp

        with patch("report.requests.post", side_effect=_capture):
            result = push_report_to_cloud(report, "http://localhost:8787", "tok")
        assert result == {"success": True}
        assert ZOD_DATETIME_RE.match(captured["payload"]["evolution_timestamp"])
        assert ZOD_DATETIME_RE.match(captured["payload"]["next_scheduled_evolution"])

    def test_naive_timestamp_would_fail_zod(self):
        # 对照组：修复前的 naive isoformat 必须被正则拒绝（回归守卫）
        naive = datetime.now(UTC).replace(tzinfo=None).isoformat()
        assert not ZOD_DATETIME_RE.match(naive)


class TestRetryBehavior:
    def test_retries_on_502_then_succeeds(self):
        report = _report()
        bad = MagicMock()
        bad.ok = False
        bad.status_code = 502
        bad.text = "Bad Gateway"
        good = MagicMock()
        good.ok = True
        with (
            patch("report.requests.post", side_effect=[bad, good]),
            patch("report.time.sleep"),
        ):
            result = push_report_to_cloud(report, "http://x", "tok")
        assert result == {"success": True}

    def test_gives_up_after_max_attempts_with_error(self):
        report = _report()
        bad = MagicMock()
        bad.ok = False
        bad.status_code = 502
        bad.text = "Bad Gateway"
        with (
            patch("report.requests.post", side_effect=[bad, bad, bad, bad]),
            patch("report.time.sleep"),
        ):
            result = push_report_to_cloud(report, "http://x", "tok", max_attempts=3)
        assert result["success"] is False
        assert "502" in result["error"]

    def test_4xx_not_retried(self):
        report = _report()
        bad = MagicMock()
        bad.ok = False
        bad.status_code = 400
        bad.text = "Validation failed"
        calls = []

        def _track(*args, **kwargs):
            calls.append(1)
            return bad

        with patch("report.requests.post", side_effect=_track):
            result = push_report_to_cloud(report, "http://x", "tok", max_attempts=3)
        assert result["success"] is False
        assert len(calls) == 1

    def test_network_exception_retried(self):
        report = _report()
        good = MagicMock()
        good.ok = True
        with (
            patch(
                "report.requests.post",
                side_effect=[requests.ConnectionError("boom"), good],
            ),
            patch("report.time.sleep"),
        ):
            result = push_report_to_cloud(report, "http://x", "tok")
        assert result == {"success": True}


class TestSaveReportLocally:
    def test_atomic_write_creates_valid_json(self, tmp_path):
        report = _report()
        path = save_report_locally(report, directory=tmp_path)
        assert path.exists()
        assert path.suffix == ".json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["timestamp"] == report.timestamp
        # 无残留临时文件
        assert list(tmp_path.glob("*.tmp")) == []
