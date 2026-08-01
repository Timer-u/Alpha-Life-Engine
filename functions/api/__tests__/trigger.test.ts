import type { Env } from '../[[route]]';

import { describe, expect, it, vi } from 'vitest';

import { triggerRouter } from '../trigger';

import { asD1, FakeD1 } from './helpers/fake-d1';

const SESSION_COOKIE = { Cookie: 'session_token=test-token' };

function pendingCtx(): { ctx: ExecutionContext; pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as ExecutionContext;
  return { ctx, pending };
}

function testEnv(db: FakeD1): Env {
  return { DB: asD1(db), RESEND_API_KEY: '', ENVIRONMENT: 'test', SESSION_DAYS: '7' };
}

function triggerDb(notificationRows: unknown[]): FakeD1 {
  return new FakeD1([
    { match: sql => sql.includes('FROM sessions'), rows: [{ id: 1, token: 'test-token', user_id: 7, expires_at: '2099-01-01', created_at: '', last_active: '', email: 'a@b.c', name: null }] },
    { match: sql => sql.includes('SELECT email FROM users'), rows: [{ email: 'a@b.c' }] },
    { match: sql => sql.includes('FROM strategy_reports'), rows: [] },
    { match: sql => sql.includes('FROM market_data'), rows: [{ close: 100 }] },
    { match: sql => sql.includes('INSERT INTO trigger_log'), rows: [] },
    { match: sql => sql.includes('FROM notification_log'), rows: notificationRows },
  ]);
}

const EXECUTE_BODY = {
  current_balance: 5000,
  signal_value: 2.0,
  signal_type: 'BSM',
};

describe('POST /api/trigger', () => {
  it('skips the execution-suggestion email when one was already sent recently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { ctx, pending } = pendingCtx();
      const res = await triggerRouter.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
        body: JSON.stringify(EXECUTE_BODY),
      }, testEnv(triggerDb([{ id: 5 }])), ctx);
      await Promise.all(pending);

      expect(res.status).toBe(200);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('sends the execution-suggestion email when none was sent recently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { ctx, pending } = pendingCtx();
      const res = await triggerRouter.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
        body: JSON.stringify(EXECUTE_BODY),
      }, testEnv(triggerDb([])), ctx);
      await Promise.all(pending);

      expect(res.status).toBe(200);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
