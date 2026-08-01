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

const BUY_BODY = {
  symbol: '511360',
  shares: 100,
  price: 10,
  commission: 5,
  transaction_type: 'buy',
  layer: 'safe',
};

const SELL_BODY = {
  symbol: '511360',
  shares: 1,
  price: 2,
  commission: 5,
  transaction_type: 'sell',
  layer: 'safe',
};

describe('POST /api/transactions', () => {
  it('rejects a sell whose proceeds cannot cover the commission', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 5000, safe_layer_balance: 5000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 100, avg_price: 10 }] },
    ]);

    const res = await transactionRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify(SELL_BODY),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Invalid input');
  });

  it('records a buy with sufficient funds', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 5000, safe_layer_balance: 5000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => sql.includes('INSERT INTO transactions'), rows: [{ id: 99, user_id: 7 }] },
    ]);

    const res = await transactionRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify(BUY_BODY),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(201);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });

  it('rejects the buy and compensates when the concurrent balance guard fails', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 5000, safe_layer_balance: 5000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => sql.includes('INSERT INTO transactions'), rows: [{ id: 99, user_id: 7 }] },
      { match: sql => sql.includes('INSERT INTO positions'), rows: [{ id: 55, user_id: 7 }] },
      { match: sql => sql.includes('UPDATE portfolio'), rows: [], changes: 0 },
      { match: sql => sql.includes('DELETE FROM'), rows: [], changes: 1 },
    ]);

    const res = await transactionRouter.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify(BUY_BODY),
    }, testEnv(db), executionCtx);

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Insufficient funds');
  });
});
