import type { Env } from '../[[route]]';

import { describe, expect, it } from 'vitest';

import { reconciliationRouter, variancePct } from '../reconciliation';

import { asD1, FakeD1 } from './helpers/fake-d1';

const SESSION_COOKIE = { Cookie: 'session_token=test-token' };

const executionCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

function testEnv(db: FakeD1): Env {
  return { DB: asD1(db), RESEND_API_KEY: '', ENVIRONMENT: 'test', SESSION_DAYS: '7' };
}

function sessionRule(): { match: (sql: string) => boolean; rows: unknown[] } {
  return {
    match: sql => sql.includes('FROM sessions'),
    rows: [{ id: 1, token: 'test-token', user_id: 7, expires_at: '2099-01-01', created_at: '', last_active: '', email: 'a@b.c', name: null }],
  };
}

describe('variancePct', () => {
  it('computes percentage of variance against a positive base', () => {
    expect(variancePct(100, 1000)).toBe(0.1);
  });

  it('treats zero variance on zero base as in-range', () => {
    expect(variancePct(0, 0)).toBe(0);
  });

  it('treats non-zero variance on zero base as out-of-range', () => {
    expect(variancePct(50, 0)).toBe(1);
  });
});

describe('GET /api/reconciliation pagination', () => {
  it('returns total, limit and offset for the paginated list', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('SELECT COUNT(*) AS total FROM reconciliations'), rows: [{ total: 42 }] },
      {
        match: sql => sql.includes('FROM reconciliations'),
        rows: Array.from({ length: 3 }, (_, i) => ({
          id: i + 1, user_id: 7, reconciliation_date: '2026-01', beginning_balance: 100000,
          deposits: 0, withdrawals: 0, gains: 0, fees: 0, ending_balance: 100000, variance: 0,
          notes: null, status: 'CONFIRMED', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
        })),
      },
    ]);
    const res = await reconciliationRouter.request('/?limit=3&offset=6', {
      method: 'GET',
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: unknown[];
      pagination: { total: number; limit: number; offset: number };
    };
    expect(json.success).toBe(true);
    expect(json.data.length).toBe(3);
    expect(json.pagination).toEqual({ total: 42, limit: 3, offset: 6 });
  });

  it('clamps invalid limit and offset to the allowed range', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('SELECT COUNT(*) AS total FROM reconciliations'), rows: [{ total: 42 }] },
      { match: sql => sql.includes('FROM reconciliations'), rows: [] },
    ]);
    const res = await reconciliationRouter.request('/?limit=9999&offset=-3', {
      method: 'GET',
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pagination: { limit: number; offset: number } };
    expect(json.pagination.limit).toBe(200);
    expect(json.pagination.offset).toBe(0);
  });

  it('defaults to limit 24 and offset 0', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('SELECT COUNT(*) AS total FROM reconciliations'), rows: [{ total: 42 }] },
      { match: sql => sql.includes('FROM reconciliations'), rows: [] },
    ]);
    const res = await reconciliationRouter.request('/', {
      method: 'GET',
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pagination: { limit: number; offset: number } };
    expect(json.pagination.limit).toBe(24);
    expect(json.pagination.offset).toBe(0);
  });
});

describe('POST /api/reconciliation/:id/calibrate', () => {
  it('clamps an inconsistent layer ratio so ambition cash never goes negative', async () => {
    // 现金层占比异常（safe 6000 / total 3000 = 2.0）：钳位后安全层拿全部现金，进取层为 0 而非负数
    const db = new FakeD1([
      sessionRule(),
      {
        match: sql => sql.includes('FROM reconciliations'),
        rows: [{ id: 1, user_id: 7, status: 'PENDING', ending_balance: 2000 }],
      },
      {
        match: sql => sql.includes('FROM portfolio'),
        rows: [{ total_balance: 3000, safe_layer_balance: 6000, ambition_layer_balance: -3000 }],
      },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => sql.includes('INSERT INTO audit_logs'), rows: [] },
    ]);

    const res = await reconciliationRouter.request('/1/calibrate', {
      method: 'POST',
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: {
        portfolio: { total_balance: number; safe_layer_balance: number; ambition_layer_balance: number };
        warnings: string[];
      };
    };
    expect(json.success).toBe(true);
    // holdingsValue=0（无持仓）→ targetCash = ending_balance - 0 = 2000
    expect(json.data.portfolio.safe_layer_balance).toBe(2000);
    expect(json.data.portfolio.ambition_layer_balance).toBe(0);
    expect(json.data.portfolio.safe_layer_balance + json.data.portfolio.ambition_layer_balance).toBe(
      json.data.portfolio.total_balance
    );
  });

  it('warns that the calibration absorbs the discrepancy into cash', async () => {
    const db = new FakeD1([
      sessionRule(),
      {
        match: sql => sql.includes('FROM reconciliations'),
        rows: [{ id: 1, user_id: 7, status: 'PENDING', ending_balance: 2000, variance: 150 }],
      },
      {
        match: sql => sql.includes('FROM portfolio'),
        rows: [{ total_balance: 1000, safe_layer_balance: 600, ambition_layer_balance: 400 }],
      },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => sql.includes('INSERT INTO audit_logs'), rows: [] },
    ]);

    const res = await reconciliationRouter.request('/1/calibrate', {
      method: 'POST',
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);

    const json = (await res.json()) as { data: { warnings: string[] } };
    expect(Array.isArray(json.data.warnings)).toBe(true);
    expect(json.data.warnings.length).toBeGreaterThan(0);
  });

  it('writes an audit_logs row within the calibrate batch', async () => {
    const db = new FakeD1([
      sessionRule(),
      {
        match: sql => sql.includes('FROM reconciliations'),
        rows: [{ id: 1, user_id: 7, status: 'PENDING', ending_balance: 2000, variance: 150 }],
      },
      {
        match: sql => sql.includes('FROM portfolio'),
        rows: [{ total_balance: 1000, safe_layer_balance: 600, ambition_layer_balance: 400 }],
      },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => sql.includes('INSERT INTO audit_logs'), rows: [] },
    ]);

    const res = await reconciliationRouter.request('/1/calibrate', {
      method: 'POST',
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });
});
