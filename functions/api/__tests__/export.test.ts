import type { Env } from '../[[route]]';

import { describe, expect, it } from 'vitest';

import { auditRouter } from '../audit';
import { exportRouter } from '../export';

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

describe('GET /api/export', () => {
  it('returns all user data as a JSON attachment', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 100000 }] },
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, user_id: 7, symbol: '511360' }] },
      { match: sql => sql.includes('FROM transactions'), rows: [{ id: 1, user_id: 7, symbol: '511360' }] },
      { match: sql => sql.includes('FROM reconciliations'), rows: [{ id: 1, user_id: 7 }] },
      { match: sql => sql.includes('FROM dividend_events'), rows: [{ id: 1, user_id: 7 }] },
      { match: sql => sql.includes('FROM audit_logs'), rows: [{ id: 1, user_id: 7, action: 'transaction' }] },
    ]);
    const res = await exportRouter.request('/', { method: 'GET', headers: SESSION_COOKIE }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const disposition = res.headers.get('Content-Disposition');
    expect(disposition).toContain('attachment;');
    expect(disposition).toContain('filename=');
    const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    for (const key of ['portfolio', 'positions', 'transactions', 'reconciliations', 'dividend_events', 'audit_logs']) {
      expect(json.data).toHaveProperty(key);
    }
    expect(json.data.positions).toEqual([{ id: 1, user_id: 7, symbol: '511360' }]);
    expect(json.data.audit_logs).toEqual([{ id: 1, user_id: 7, action: 'transaction' }]);
  });
});

describe('GET /api/audit-logs', () => {
  it('returns the user audit rows with default limit 100', async () => {
    const db = new FakeD1([
      sessionRule(),
      {
        match: sql => sql.includes('FROM audit_logs'),
        rows: (_sql: string, args: unknown[]) => {
          if (args[1] !== 100) throw new Error(`expected default limit 100, got ${String(args[1])}`);
          return [{ id: 1, user_id: 7, action: 'transaction', entity: 'transactions', old_value: null, new_value: '{}', created_at: '2026-08-19T00:00:00.000Z' }];
        },
      },
    ]);
    const res = await auditRouter.request('/', { method: 'GET', headers: SESSION_COOKIE }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: Array<{ id: number; action: string }> };
    expect(json.success).toBe(true);
    expect(json.data.length).toBe(1);
    expect(json.data[0]).toMatchObject({ id: 1, action: 'transaction' });
  });

  it('clamps the limit query parameter to the allowed range', async () => {
    const db = new FakeD1([
      sessionRule(),
      {
        match: sql => sql.includes('FROM audit_logs'),
        rows: (_sql: string, args: unknown[]) => {
          if (args[1] !== 200) throw new Error(`expected clamped limit 200, got ${String(args[1])}`);
          return [];
        },
      },
    ]);
    const res = await auditRouter.request('/?limit=9999', { method: 'GET', headers: SESSION_COOKIE }, testEnv(db), executionCtx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
  });
});