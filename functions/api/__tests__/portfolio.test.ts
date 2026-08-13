import type { Env } from '../[[route]]';

import { describe, expect, it } from 'vitest';

import { portfolioRouter, splitDeposit } from '../portfolio';

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
  return { match: (sql: string) => sql.includes('FROM portfolio'), rows: [{ total_balance: totalBalance }] };
}

function strategyReportRule(rows: unknown[]) {
  return { match: (sql: string) => sql.includes('FROM strategy_reports'), rows };
}

const executionCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

function testEnv(db: FakeD1): Env {
  return { DB: asD1(db), RESEND_API_KEY: '', ENVIRONMENT: 'test', SESSION_DAYS: '7' };
}

describe('splitDeposit', () => {
  it('splits amount by safe ratio', () => {
    expect(splitDeposit(1000, 0.6)).toEqual({ safeAdded: 600, ambitionAdded: 400 });
  });

  it('splits all to safe layer when ratio is 1', () => {
    expect(splitDeposit(1000, 1)).toEqual({ safeAdded: 1000, ambitionAdded: 0 });
  });

  it('splits all to ambition layer when ratio is 0', () => {
    expect(splitDeposit(1000, 0)).toEqual({ safeAdded: 0, ambitionAdded: 1000 });
  });

  it('keeps layer sum exactly equal to the deposit amount', () => {
    const { safeAdded, ambitionAdded } = splitDeposit(999.99, 0.333);
    expect(safeAdded + ambitionAdded).toBe(999.99);
  });
});

describe('POST /api/portfolio/deposit', () => {
  it('clamps an out-of-range evolved safe_ratio (2.0) before splitting', async () => {
    const db = new FakeD1([
      { match: sql => sql.includes('FROM sessions'), rows: [{ id: 1, token: 'test-token', user_id: 7, expires_at: '2099-01-01', created_at: '', last_active: '', email: 'a@b.c', name: null }] },
      { match: sql => sql.includes('SELECT preferences FROM users'), rows: [{ preferences: '{"birth_year":1990,"birth_month":6,"birth_day":15}' }] },
      { match: sql => sql.includes('FROM portfolio'), rows: [{ total_balance: 5000, safe_layer_balance: 3000, ambition_layer_balance: 2000 }] },
      {
        match: sql => sql.includes('FROM strategy_reports'),
        rows: [{
          report_data: JSON.stringify({ recommended_params: { trigger_line: 1667, safe_ratio: 2.0 } }),
          pbo_score: null,
          dsr_ranking: null,
          evolution_timestamp: new Date().toISOString(),
        }],
      },
    ]);

    const res = await portfolioRouter.request('/deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ amount: 1000 }),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { safe_added: number; ambition_added: number };
    };
    expect(json.success).toBe(true);
    expect(json.data.safe_added).toBe(1000);
    expect(json.data.ambition_added).toBe(0);
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

  it('uses the evolved trigger_line and shows accumulating below it (1700 between 1667 and 2000)', async () => {
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(1700),
      strategyReportRule([evolvedTriggerStrategyRow(2000)]),
    ]);

    const status = await getTriggerStatus(db);
    expect(status.trigger_line).toBe(2000);
    expect(status.status).toBe('accumulating');
  });

  it('flips to triggerable at the evolved boundary', async () => {
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(2200),
      strategyReportRule([evolvedTriggerStrategyRow(2000)]),
    ]);

    const status = await getTriggerStatus(db);
    expect(status.trigger_line).toBe(2000);
    expect(status.status).toBe('triggerable');
  });

  it('falls back to 1667 and turns triggerable when evolved params are stale', async () => {
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(1700),
      strategyReportRule([evolvedTriggerStrategyRow(2000, { staleDays: 46 })]),
    ]);

    const status = await getTriggerStatus(db);
    expect(status.trigger_line).toBe(1667);
    expect(status.status).toBe('triggerable');
  });

  it('falls back to 1667 when evolved params are PBO-rejected', async () => {
    const db = new FakeD1([
      sessionRule(),
      preferencesRule(),
      portfolioRule(1500),
      strategyReportRule([evolvedTriggerStrategyRow(2000, { pboScore: 0.7 })]),
    ]);

    const status = await getTriggerStatus(db);
    expect(status.trigger_line).toBe(1667);
    expect(status.status).toBe('accumulating');
  });
});
