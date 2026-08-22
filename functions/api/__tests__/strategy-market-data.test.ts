import type { Env } from '../[[route]]';

import { describe, expect, it } from 'vitest';

import { marketDataRouter } from '../market-data';
import { strategyRouter } from '../strategy';

import { asD1, FakeD1 } from './helpers/fake-d1';

const SESSION_COOKIE = { Cookie: 'session_token=test-token' };

const executionCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

function testEnv(db: FakeD1): Env {
  return { DB: asD1(db), RESEND_API_KEY: '', ENVIRONMENT: 'test', SESSION_DAYS: '7' };
}

function sessionRule() {
  return {
    match: (sql: string) => sql.includes('FROM sessions'),
    rows: [{ id: 1, token: 't', user_id: 7, expires_at: '2099-01-01', created_at: '', last_active: '', email: 'a@b.c', name: null }],
  };
}

describe('POST /api/strategy/reports — zod datetime contract', () => {
  // 本测试守护 2026-08-22 的 P1：演化器曾用 naive isoformat 时间戳，
  // zod `.datetime()` 拒绝 → 推送必 400 → 整轮演化结果丢弃。
  function reportDb() {
    return new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('INSERT INTO strategy_reports'), rows: [{ id: 1 }] },
    ]);
  }

  async function postReport(db: FakeD1, timestamp: string): Promise<Response> {
    return strategyRouter.request('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({
        report_data: '{}',
        pbo_score: null,
        dsr_ranking: null,
        parameter_count: 12,
        evolution_timestamp: timestamp,
        next_scheduled_evolution: null,
      }),
    }, testEnv(db), executionCtx);
  }

  it('accepts a UTC timestamp with Z suffix', async () => {
    const res = await postReport(reportDb(), '2026-08-22T04:00:00.000Z');
    expect(res.status).toBe(200);
  });

  it('rejects a naive timestamp (the Python evolver bug class) with 400', async () => {
    const res = await postReport(reportDb(), '2026-08-22T04:00:00.000000');
    expect(res.status).toBe(400);
  });

  it('rejects a +00:00 offset (zod default offset: false)', async () => {
    const res = await postReport(reportDb(), '2026-08-22T04:00:00.000+00:00');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/market-data/history — date range validation', () => {
  it('rejects malformed start/end params with 400', async () => {
    for (const q of ['?start=20260819', '?end=not-a-date']) {
      const db = new FakeD1([sessionRule()]);
      const res = await marketDataRouter.request(`/history${q}`, {
        headers: SESSION_COOKIE,
      }, testEnv(db), executionCtx);
      expect(res.status).toBe(400);
    }
  });

  it('accepts valid start/end and defaults to full history', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM market_data'), rows: [] },
    ]);
    const res = await marketDataRouter.request('/history?start=2026-01-01&end=2026-02-01', {
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; count: number };
    expect(json.success).toBe(true);
    expect(json.count).toBe(0);
  });
});
