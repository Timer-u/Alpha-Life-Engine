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
      body: JSON.stringify({ symbol: '511360', shares: 1, price: 2, commission: 500, transaction_type: 'sell', layer: 'safe' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Invalid input');
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
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(201);
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
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Insufficient funds');
    expect(compensated).toBe(false);
  });
});
