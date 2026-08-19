import type { Env } from '../[[route]]';

import { describe, expect, it } from 'vitest';

import { dividendsRouter } from '../dividends';

import { asD1, FakeD1 } from './helpers/fake-d1';

const SESSION_COOKIE = { Cookie: 'session_token=test-token' };

const SESSION_ROW = { id: 1, token: 'test-token', user_id: 7, expires_at: '2099-01-01', created_at: '', last_active: '', email: 'a@b.c', name: null };

const executionCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

function testEnv(db: FakeD1): Env {
  return { DB: asD1(db), RESEND_API_KEY: '', ENVIRONMENT: 'test', SESSION_DAYS: '7' };
}

function sessionRule(): { match: (sql: string) => boolean; rows: unknown[] } {
  return {
    match: sql => sql.includes('FROM sessions'),
    rows: [SESSION_ROW],
  };
}

function dividendEventRule(rows: unknown[], changes = 1) {
  return { match: (sql: string) => sql.includes('INSERT INTO dividend_events'), rows, changes };
}

function auditLogRule() {
  return { match: (sql: string) => sql.includes('INSERT INTO audit_logs'), rows: [{ id: 1 }], changes: 1 };
}

describe('POST /api/dividends', () => {
  it('records a cash dividend and credits the layer balance', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 1000, layer: 'safe' }] },
      dividendEventRule([{ id: 1, user_id: 7, symbol: '511360' }]),
      auditLogRule(),
    ]);

    const res = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', ex_date: '2026-08-10', type: 'cash', amount_per_share: 0.05 }),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(201);
    const json = (await res.json()) as { success: boolean; data: { duplicate: boolean; applied_positions: number } };
    expect(json.success).toBe(true);
    expect(json.data.duplicate).toBe(false);
    expect(json.data.applied_positions).toBe(1);

    const portfolioUpdate = db.statements.find(s => s.includes('UPDATE portfolio'));
    expect(portfolioUpdate).toBeDefined();
    expect(portfolioUpdate).toContain('safe_layer_balance = safe_layer_balance + ?');
    expect(db.statements.some(s => s.includes('INSERT INTO audit_logs'))).toBe(true);
  });

  it('records a split and adjusts shares/avg_price', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 1000, layer: 'safe' }] },
      dividendEventRule([{ id: 2, user_id: 7, symbol: '510300' }]),
      auditLogRule(),
    ]);

    const res = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '510300', ex_date: '2026-06-01', type: 'split', split_ratio: 2 }),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(201);
    const json = (await res.json()) as { success: boolean; data: { duplicate: boolean; applied_positions: number } };
    expect(json.success).toBe(true);
    expect(json.data.duplicate).toBe(false);
    expect(json.data.applied_positions).toBe(1);

    const splitUpdate = db.statements.find(s => s.includes('UPDATE positions'));
    expect(splitUpdate).toBeDefined();
    expect(splitUpdate).toContain('shares = ROUND(shares * ?, 6)');
    expect(splitUpdate).toContain('avg_price = avg_price / ?');
    expect(db.statements.some(s => s.includes('INSERT INTO audit_logs'))).toBe(true);
  });

  it('duplicate (user, symbol, ex_date, type) returns duplicate: true', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM positions'), rows: [] },
      dividendEventRule([], 0),
      { match: sql => sql.includes('FROM dividend_events'), rows: [{ id: 1, ex_date: '2026-08-10' }] },
      auditLogRule(),
    ]);

    const res = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', ex_date: '2026-08-10', type: 'cash', amount_per_share: 0.05 }),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { duplicate: boolean } };
    expect(json.success).toBe(true);
    expect(json.data.duplicate).toBe(true);
  });

  it('rejects cash without amount_per_share and split without split_ratio', async () => {
    const db = new FakeD1([sessionRule()]);

    const cashRes = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', ex_date: '2026-08-10', type: 'cash' }),
    }, testEnv(db), executionCtx);
    expect(cashRes.status).toBe(400);
    expect(((await cashRes.json()) as { error: string }).error).toBe('验证失败');

    const splitRes = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '510300', ex_date: '2026-06-01', type: 'split' }),
    }, testEnv(db), executionCtx);
    expect(splitRes.status).toBe(400);
    expect(((await splitRes.json()) as { error: string }).error).toBe('验证失败');
  });

  it('rejects invalid ex_date format', async () => {
    const db = new FakeD1([sessionRule()]);

    const res = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', ex_date: '2026/08/10', type: 'cash', amount_per_share: 0.05 }),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('验证失败');
  });
});