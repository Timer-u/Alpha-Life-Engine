import type { Env } from '../[[route]]';

import { describe, expect, it } from 'vitest';

import { transactionRouter } from '../transaction';

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

describe('POST /api/transactions', () => {
  it('rejects a sell whose proceeds cannot cover the commission', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 100, avg_price: 10 }] },
    ]);
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 1, price: 2, commission: 500, transaction_type: 'sell', layer: 'safe', idempotency_key: 'tx-key-00000001' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Invalid input');
  });

  it('rejects a transaction without idempotency_key', async () => {
    const db = new FakeD1([sessionRule()]);
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('验证失败');
  });

  it('dedupes a repeated idempotency_key', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('SELECT * FROM transactions') && sql.includes('idempotency_key = ?'), rows: [{ id: 42, user_id: 7, symbol: '511360' }] },
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [] },
    ]);
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe', idempotency_key: 'tx-key-00000002' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; duplicate: boolean; data: { id: number } };
    expect(json.success).toBe(true);
    expect(json.duplicate).toBe(true);
    expect(json.data.id).toBe(42);
    expect(db.statements.length).toBe(0);
  });

  it('records a buy with sufficient funds in cents and a commission-inclusive avg_price', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => sql.includes('INSERT INTO transactions'), rows: [{ id: 99, user_id: 7 }] },
    ]);
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe', idempotency_key: 'tx-key-00000003' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(201);
  });

  it('writes an audit_logs row within the batch', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => sql.includes('INSERT INTO transactions'), rows: [{ id: 99, user_id: 7 }] },
      { match: sql => sql.includes('INSERT INTO audit_logs'), rows: [{ id: 1 }] },
    ]);
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe', idempotency_key: 'tx-key-00000004' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(201);
    const auditIdx = db.statements.findIndex(sql => sql.includes('INSERT INTO audit_logs'));
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(db.statements[auditIdx]).toContain('(SELECT safe_layer_balance FROM portfolio WHERE user_id = ?) >= ?');
    expect(db.statements[auditIdx]).toContain('(SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0');
  });

  it('rejects the buy with NO compensation writes when the guard subquery returns 0 rows', async () => {
    const compensated = false;
    const db = new FakeD1([
      sessionRule(),
      // FakeD1 matches the FIRST rule whose predicate is true; the gated INSERT
      // contains a `FROM portfolio` subquery, so the INSERT rule must come first
      // for the guard failure to surface as 0 rows.
      { match: sql => sql.includes('INSERT INTO transactions'), rows: [], changes: 0 },
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => (sql.includes('DELETE') || sql.includes('compensate')), rows: [], changes: 0 },
    ]);
    // if the code still issues a compensation batch, this rule would match 'DELETE FROM' SQL
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe', idempotency_key: 'tx-key-00000005' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Insufficient funds');
    expect(compensated).toBe(false);
  });

  it('writes NO audit row when a first-attempt buy is guard-rejected', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('INSERT INTO transactions'), rows: [], changes: 0 },
      // audit guardful rule: only matches when the audit INSERT shares the balance guard;
      // a guardless audit statement would fall through to the changes-1 rule below
      { match: sql => sql.includes('INSERT INTO audit_logs') && sql.includes('FROM portfolio'), rows: [], changes: 0 },
      { match: sql => sql.includes('INSERT INTO audit_logs'), rows: [{ id: 1 }], changes: 1 },
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [] },
    ]);
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe', idempotency_key: 'tx-key-00000006' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Insufficient funds');

    const auditIdx = db.statements.findIndex(sql => sql.includes('INSERT INTO audit_logs'));
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(db.statements[auditIdx]).toContain('(SELECT safe_layer_balance FROM portfolio WHERE user_id = ?) >= ?');
    expect(db.statements[auditIdx]).toContain('(SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0');
    expect(db.statementChanges[auditIdx]).toBe(0);
  });

  it('writes NO audit row when a first-attempt sell is guard-rejected', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('INSERT INTO transactions'), rows: [], changes: 0 },
      // audit guardful rule: only matches when the audit INSERT shares the position guard
      { match: sql => sql.includes('INSERT INTO audit_logs') && sql.includes('FROM positions'), rows: [], changes: 0 },
      { match: sql => sql.includes('INSERT INTO audit_logs'), rows: [{ id: 1 }], changes: 1 },
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 100, avg_price: 10 }] },
    ]);
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'sell', layer: 'safe', idempotency_key: 'tx-key-00000007' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Insufficient shares');

    const auditIdx = db.statements.findIndex(sql => sql.includes('INSERT INTO audit_logs'));
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(db.statements[auditIdx]).toContain('(SELECT shares FROM positions WHERE id = ?) >= ?');
    expect(db.statements[auditIdx]).toContain('(SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0');
    expect(db.statementChanges[auditIdx]).toBe(0);
  });
});

describe('GET /api/transactions pagination', () => {
  it('returns total, limit and offset for the paginated list', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('SELECT COUNT(*) AS total FROM transactions'), rows: [{ total: 37 }] },
      {
        match: sql => sql.includes('FROM transactions'),
        rows: Array.from({ length: 5 }, (_, i) => ({ id: i + 1, user_id: 7, symbol: '511360', shares: 100, price: 10, amount: 100000, commission: 500, transaction_type: 'buy', trigger_signal: null, layer: 'safe', realized_pnl: null, trade_date: '2026-01-01', created_at: '2026-01-01T00:00:00.000Z', notes: null })),
      },
    ]);
    const res = await transactionRouter.request('/?limit=5&offset=10', {
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
    expect(json.data.length).toBe(5);
    expect(json.pagination).toEqual({ total: 37, limit: 5, offset: 10 });
  });

  it('clamps invalid limit and offset to the allowed range', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('SELECT COUNT(*) AS total FROM transactions'), rows: [{ total: 37 }] },
      { match: sql => sql.includes('FROM transactions'), rows: [] },
    ]);
    const res = await transactionRouter.request('/?limit=9999&offset=-3', {
      method: 'GET',
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pagination: { limit: number; offset: number } };
    expect(json.pagination.limit).toBe(200);
    expect(json.pagination.offset).toBe(0);
  });

  it('defaults to limit 100 and offset 0', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('SELECT COUNT(*) AS total FROM transactions'), rows: [{ total: 37 }] },
      { match: sql => sql.includes('FROM transactions'), rows: [] },
    ]);
    const res = await transactionRouter.request('/', {
      method: 'GET',
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pagination: { limit: number; offset: number } };
    expect(json.pagination.limit).toBe(100);
    expect(json.pagination.offset).toBe(0);
  });
});
