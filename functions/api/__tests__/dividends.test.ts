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

function auditLogRule(rows: unknown[], changes = 1) {
  return { match: (sql: string) => sql.includes('INSERT INTO audit_logs'), rows, changes };
}

function findStatement(db: FakeD1, substring: string): number {
  return db.statements.findIndex(sql => sql.includes(substring));
}

describe('POST /api/dividends', () => {
  it('records a cash dividend and credits the layer balance', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 1000, layer: 'safe' }] },
      { match: sql => sql.includes('UPDATE portfolio'), rows: [{ id: 1 }], changes: 1 },
      auditLogRule([{ id: 1 }]),
      dividendEventRule([{ id: 1, user_id: 7, symbol: '511360' }]),
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

    // event INSERT is the LAST batch statement (duplicate anchor)
    expect(db.statements[db.statements.length - 1]).toContain('INSERT INTO dividend_events');

    const updateIdx = findStatement(db, 'UPDATE portfolio');
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    const updateSql = db.statements[updateIdx];
    expect(updateSql).toContain('safe_layer_balance = safe_layer_balance + ?');
    // guarded so a retry cannot re-credit
    expect(updateSql).toContain('(SELECT COUNT(*) FROM dividend_events WHERE user_id = ?');
    expect(updateSql).toContain('AND symbol = ? AND ex_date = ? AND type = ?) = 0');

    // bound args: delta = round(1000 x 0.05 x 100) = 5000, then now/now/userId + guard args
    const updateArgs = db.statementArgs[updateIdx];
    expect(updateArgs[0]).toBe(5000);
    expect(updateArgs[3]).toBe(7);
    expect(updateArgs.slice(4)).toEqual([7, '511360', '2026-08-10', 'cash']);

    const auditIdx = findStatement(db, 'INSERT INTO audit_logs');
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    // audit insert is guarded with the same duplicate predicate
    expect(db.statements[auditIdx]).toContain('(SELECT COUNT(*) FROM dividend_events WHERE user_id = ?');
  });

  it('records a split and adjusts shares/avg_price', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 1000, layer: 'safe' }] },
      { match: sql => sql.includes('UPDATE positions'), rows: [{ id: 1 }], changes: 1 },
      auditLogRule([{ id: 1 }]),
      dividendEventRule([{ id: 2, user_id: 7, symbol: '510300' }]),
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

    expect(db.statements[db.statements.length - 1]).toContain('INSERT INTO dividend_events');

    const splitIdx = findStatement(db, 'UPDATE positions');
    expect(splitIdx).toBeGreaterThanOrEqual(0);
    const splitSql = db.statements[splitIdx];
    expect(splitSql).toContain('shares = ROUND(shares * ?, 6)');
    expect(splitSql).toContain('avg_price = avg_price / ?');
    expect(splitSql).toContain('(SELECT COUNT(*) FROM dividend_events WHERE user_id = ?');

    const splitArgs = db.statementArgs[splitIdx];
    expect(splitArgs[0]).toBe(2);
    expect(splitArgs.slice(4)).toEqual([7, '510300', '2026-06-01', 'split']);
  });

  it('duplicate (user, symbol, ex_date, type) returns duplicate: true', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM positions'), rows: [] },
      dividendEventRule([], 0),
      auditLogRule([], 0),
      { match: sql => sql.includes('FROM dividend_events'), rows: [{ id: 1, ex_date: '2026-08-10' }] },
    ]);

    const res = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', ex_date: '2026-08-10', type: 'cash', amount_per_share: 0.05 }),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { duplicate: boolean } };
    expect(json.success).toBe(true);
    expect(json.data.duplicate).toBe(true);

    // event INSERT is the LAST batch statement; the guarded audit no-ops (changes 0)
    expect(db.statements[db.statements.length - 1]).toContain('INSERT INTO dividend_events');
    const auditIdx = findStatement(db, 'INSERT INTO audit_logs');
    expect(db.statementChanges[auditIdx]).toBe(0);
  });

  it('does not re-apply mutations or write a second audit row on a duplicate retry', async () => {
    const body = JSON.stringify({ symbol: '511360', ex_date: '2026-08-10', type: 'cash', amount_per_share: 0.05 });

    // First POST: event recorded + balance credited once
    const db1 = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 1000, layer: 'safe' }] },
      { match: sql => sql.includes('UPDATE portfolio'), rows: [{ id: 1 }], changes: 1 },
      auditLogRule([{ id: 1 }], 1),
      dividendEventRule([{ id: 1 }]),
    ]);
    const first = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE }, body,
    }, testEnv(db1), executionCtx);
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { data: { duplicate: boolean } };
    expect(firstJson.data.duplicate).toBe(false);
    expect(db1.statementChanges[findStatement(db1, 'UPDATE portfolio')]).toBe(1);
    expect(db1.statementChanges[findStatement(db1, 'INSERT INTO audit_logs')]).toBe(1);

    // Second identical POST: every mutation + audit insert is a guarded no-op
    const db2 = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 1000, layer: 'safe' }] },
      { match: sql => sql.includes('UPDATE portfolio'), rows: [], changes: 0 },
      auditLogRule([], 0),
      dividendEventRule([], 0),
      { match: sql => sql.includes('FROM dividend_events'), rows: [{ id: 1, ex_date: '2026-08-10' }] },
    ]);
    const second = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE }, body,
    }, testEnv(db2), executionCtx);
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { success: boolean; data: { duplicate: boolean } };
    expect(secondJson.success).toBe(true);
    expect(secondJson.data.duplicate).toBe(true);

    // event INSERT is the LAST statement; guarded UPDATE/audit match 0 rows (no re-credit, no audit row)
    expect(db2.statements[db2.statements.length - 1]).toContain('INSERT INTO dividend_events');
    expect(db2.statementChanges[findStatement(db2, 'UPDATE portfolio')]).toBe(0);
    expect(db2.statementChanges[findStatement(db2, 'INSERT INTO audit_logs')]).toBe(0);
    expect(db2.statementChanges[findStatement(db2, 'INSERT INTO dividend_events')]).toBe(0);

    // exactly ONE audit row written across both attempts
    const auditRows1 = db1.statementChanges[findStatement(db1, 'INSERT INTO audit_logs')];
    const auditRows2 = db2.statementChanges[findStatement(db2, 'INSERT INTO audit_logs')];
    expect(auditRows1 + auditRows2).toBe(1);
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

  it('rejects a symbol outside the tracked ETF list', async () => {
    const db = new FakeD1([sessionRule()]);

    const res = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '000001', ex_date: '2026-08-10', type: 'cash', amount_per_share: 0.05 }),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; message: string };
    expect(json.error).toBe('验证失败');
    expect(json.message).toContain('仅支持系统跟踪的 ETF 标的');
    expect(db.statements).toEqual([]);
  });

  it('no-positions branch: event recorded, no position/balance adjustment (201)', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM positions'), rows: [] },
      auditLogRule([{ id: 1 }], 1),
      dividendEventRule([{ id: 5, user_id: 7, symbol: '511360' }], 1),
    ]);

    const res = await dividendsRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', ex_date: '2026-08-10', type: 'cash', amount_per_share: 0.05 }),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(201);
    const json = (await res.json()) as { success: boolean; data: { duplicate: boolean; applied_positions: number } };
    expect(json.success).toBe(true);
    expect(json.data.duplicate).toBe(false);
    expect(json.data.applied_positions).toBe(0);

    // no position or portfolio mutation issued, just audit + event INSERT
    expect(findStatement(db, 'UPDATE portfolio')).toBe(-1);
    expect(findStatement(db, 'UPDATE positions')).toBe(-1);
    expect(db.statements[db.statements.length - 1]).toContain('INSERT INTO dividend_events');
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
