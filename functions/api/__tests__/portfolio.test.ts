import type { Env } from '../[[route]]';

import { describe, expect, it } from 'vitest';

import { splitDepositCents } from '../../../src/lib/money';
import { portfolioRouter } from '../portfolio';

import { asD1, FakeD1 } from './helpers/fake-d1';

const SESSION_COOKIE = { Cookie: 'session_token=test-token' };

const SESSION_ROW = { id: 1, token: 'test-token', user_id: 7, expires_at: '2099-01-01', created_at: '', last_active: '', email: 'a@b.c', name: null };

const PREFS_ROW = { preferences: '{"birth_year":1990,"birth_month":6,"birth_day":15}' };

function evolvedTriggerStrategyRow(triggerLine: number, opts: { pboScore?: number | null; staleDays?: number } = {}) {
  return {
    report_data: JSON.stringify({ recommended_params: { trigger_line: triggerLine } }),
    pbo_score: opts.pboScore ?? null,
    dsr_ranking: null,
    evolution_timestamp: new Date(Date.now() - (opts.staleDays ?? 0) * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function sessionRule() {
  return { match: (sql: string) => sql.includes('FROM sessions'), rows: [SESSION_ROW] };
}

function preferencesRule() {
  return { match: (sql: string) => sql.includes('SELECT preferences FROM users'), rows: [PREFS_ROW] };
}

function portfolioRule(totalBalance: number) {
  return {
    match: (sql: string) => sql.includes('FROM portfolio'),
    rows: [{ total_balance: totalBalance, safe_layer_balance: Math.round(totalBalance * 0.6), ambition_layer_balance: Math.round(totalBalance * 0.4) }],
  };
}

function strategyReportRule(rows: unknown[]) {
  return { match: (sql: string) => sql.includes('FROM strategy_reports'), rows };
}

function recentTransactionRow(id: number) {
  return {
    id,
    user_id: 7,
    symbol: '511360',
    shares: 100,
    price: 10,
    amount: 100000,
    commission: 500,
    transaction_type: 'buy',
    trigger_signal: null,
    layer: 'safe',
    created_at: '2026-01-01T00:00:00.000Z',
    notes: null,
  };
}

describe('GET /api/portfolio recent_transactions pagination', () => {
  function recentTransactionsRule(rows: unknown[]) {
  return {
    match: (sql: string) => sql.includes('FROM transactions'),
    rows: (_sql: string, args: unknown[]) => {
      const offset = typeof args[2] === 'number' ? args[2] : 0;
      const limit = typeof args[1] === 'number' ? args[1] : rows.length;
      return rows.slice(offset, offset + limit);
    },
  };
}

  async function getRecentTransactions(db: FakeD1, path: string): Promise<unknown[]> {
    const res = await portfolioRouter.request(path, { method: 'GET', headers: SESSION_COOKIE }, testEnv(db), executionCtx);
    const json = (await res.json()) as { data: { recent_transactions: unknown[] } };
    return json.data.recent_transactions;
  }

  it('honors recent_limit', async () => {
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(170000),
      recentTransactionsRule([recentTransactionRow(1), recentTransactionRow(2), recentTransactionRow(3)]),
    ]);
    const recent = await getRecentTransactions(db, '/?recent_limit=3');
    expect(recent.length).toBe(3);
  });

  it('defaults recent transactions to 10', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => recentTransactionRow(i + 1));
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(170000),
      recentTransactionsRule(rows),
    ]);
    const recent = await getRecentTransactions(db, '/');
    expect(recent.length).toBe(10);
  });

  it('honors recent_offset', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => recentTransactionRow(i + 1));
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(170000),
      recentTransactionsRule(rows),
    ]);
    const recent = await getRecentTransactions(db, '/?recent_limit=3&recent_offset=2');
    expect(recent.length).toBe(3);
  });
});

const executionCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

function testEnv(db: FakeD1): Env {
  return { DB: asD1(db), RESEND_API_KEY: '', ENVIRONMENT: 'test', SESSION_DAYS: '7' };
}

describe('splitDepositCents', () => {
  it('splits amount by safe ratio', () => {
    expect(splitDepositCents(100000, 0.6)).toEqual({ safeAddedCents: 60000, ambitionAddedCents: 40000 });
  });

  it('splits all to safe layer when ratio is 1', () => {
    expect(splitDepositCents(100000, 1)).toEqual({ safeAddedCents: 100000, ambitionAddedCents: 0 });
  });

  it('splits all to ambition layer when ratio is 0', () => {
    expect(splitDepositCents(100000, 0)).toEqual({ safeAddedCents: 0, ambitionAddedCents: 100000 });
  });

  it('keeps layer sum exactly equal to the deposit amount in cents', () => {
    const { safeAddedCents, ambitionAddedCents } = splitDepositCents(99999, 0.333);
    expect(safeAddedCents + ambitionAddedCents).toBe(99999);
  });
});

describe('POST /api/portfolio/deposit', () => {
  it('clamps an out-of-range evolved safe_ratio (2.0) before splitting', async () => {
    const db = new FakeD1([
      { match: sql => sql.includes('FROM sessions'), rows: [SESSION_ROW] },
      { match: sql => sql.includes('SELECT preferences FROM users'), rows: [PREFS_ROW] },
      {
        match: sql => sql.includes('FROM strategy_reports'),
        rows: [{
          report_data: JSON.stringify({ recommended_params: { trigger_line: 1667, safe_ratio: 2.0 } }),
          pbo_score: null,
          dsr_ranking: null,
          evolution_timestamp: new Date().toISOString(),
        }],
      },
      { match: sql => sql.includes('UPDATE portfolio'), rows: [{ total_balance: 600000, safe_layer_balance: 600000, ambition_layer_balance: 500000 }] },
      { match: sql => sql.includes('INSERT INTO deposits'), rows: [{ id: 1 }] },
    ]);

    const res = await portfolioRouter.request('/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: 'deposit-key-001' }),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { duplicate: boolean; safe_added_cents: number; ambition_added_cents: number };
    };
    expect(json.success).toBe(true);
    expect(json.data.duplicate).toBe(false);
    expect(json.data.safe_added_cents).toBe(100000);
    expect(json.data.ambition_added_cents).toBe(0);
  });

  it('dedupes a repeated deposit by idempotency key', async () => {
    const db = new FakeD1([
      { match: sql => sql.includes('FROM sessions'), rows: [SESSION_ROW] },
      { match: sql => sql.includes('SELECT preferences FROM users'), rows: [PREFS_ROW] },
      { match: sql => sql.includes('UPDATE portfolio'), rows: [] },
      { match: sql => sql.includes('INSERT INTO deposits'), rows: [], changes: 0 },
      { match: sql => sql.includes('FROM deposits'), rows: [{ amount_cents: 100000 }] },
    ]);
    const res = await portfolioRouter.request('/deposit', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: 'dup-key-0000001' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { duplicate: boolean } };
    expect(json.success).toBe(true);
    expect(json.data.duplicate).toBe(true);
  });

  it('writes an audit_logs row within the deposit batch', async () => {
    const db = new FakeD1([
      { match: sql => sql.includes('FROM sessions'), rows: [SESSION_ROW] },
      { match: sql => sql.includes('SELECT preferences FROM users'), rows: [PREFS_ROW] },
      { match: sql => sql.includes('UPDATE portfolio'), rows: [{ total_balance: 600000, safe_layer_balance: 600000, ambition_layer_balance: 500000 }] },
      { match: sql => sql.includes('INSERT INTO deposits'), rows: [{ id: 1 }] },
      { match: sql => sql.includes('INSERT INTO audit_logs'), rows: [{ id: 1 }] },
    ]);
    const res = await portfolioRouter.request('/deposit', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ amount_cents: 100000, idempotency_key: 'deposit-key-002' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { duplicate: boolean } };
    expect(json.success).toBe(true);
    expect(json.data.duplicate).toBe(false);

    expect(db.statements.length).toBe(3);
    const auditIdx = db.statements.findIndex(sql => sql.includes('INSERT INTO audit_logs'));
    const depositsIdx = db.statements.findIndex(sql => sql.includes('INSERT INTO deposits'));
    expect(auditIdx).toBeGreaterThanOrEqual(0);
    expect(auditIdx).toBeLessThan(depositsIdx);
    expect(db.statements[auditIdx]).toContain("'deposit'");
    expect(db.statements[auditIdx]).toContain('WHERE (SELECT COUNT(*) FROM deposits WHERE user_id = ? AND idempotency_key = ?) = 0');
  });
});

describe('GET /api/portfolio trigger line resolution', () => {
  type TriggerStatus = { current_balance: number; trigger_line: number; status: 'accumulating' | 'triggerable' };

  async function getTriggerStatus(db: FakeD1): Promise<TriggerStatus> {
    const res = await portfolioRouter.request('/', {
      method: 'GET',
      headers: SESSION_COOKIE,
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { trigger_status: TriggerStatus } };
    return json.data.trigger_status;
  }

  it('uses the evolved trigger_line (cents) and shows accumulating below it', async () => {
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(170000),
      strategyReportRule([evolvedTriggerStrategyRow(2000)]),
    ]);

    const status = await getTriggerStatus(db);
    expect(status.trigger_line).toBe(200000);
    expect(status.status).toBe('accumulating');
  });

  it('flips to triggerable at the evolved boundary', async () => {
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(220000),
      strategyReportRule([evolvedTriggerStrategyRow(2000)]),
    ]);

    const status = await getTriggerStatus(db);
    expect(status.trigger_line).toBe(200000);
    expect(status.status).toBe('triggerable');
  });

  it('falls back to 166700 cents when evolved params are stale', async () => {
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(170000),
      strategyReportRule([evolvedTriggerStrategyRow(2000, { staleDays: 46 })]),
    ]);

    const status = await getTriggerStatus(db);
    expect(status.trigger_line).toBe(166700);
    expect(status.status).toBe('triggerable');
  });

  it('falls back to 166700 cents when evolved params are PBO-rejected', async () => {
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(150000),
      strategyReportRule([evolvedTriggerStrategyRow(2000, { pboScore: 0.7 })]),
    ]);

    const status = await getTriggerStatus(db);
    expect(status.trigger_line).toBe(166700);
    expect(status.status).toBe('accumulating');
  });
});
