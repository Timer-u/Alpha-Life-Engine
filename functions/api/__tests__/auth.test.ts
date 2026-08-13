import type { Env, Variables } from '../[[route]]';

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { authRouter, sessionMiddleware } from '../auth';

import { asD1, FakeD1 } from './helpers/fake-d1';

const executionCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

const OTPS_TABLE = 'ORDER BY id DESC';
const CONSUME_OTP = 'UPDATE otps SET used = 1 WHERE id = ? AND used = 0';
const SESSION_LOOKUP = 'FROM sessions';

const RAW_TOKEN = 'my-raw-session-token';
// sha256('my-raw-session-token') — precomputed so the test never mirrors prod code.
const STORED_HASH = '7af17310dd5732b77403052824482bd5a90eb5a4469c3080209f8cbb714f4ed9';

const EMAIL = 'user@example.com';

function testEnv(db: FakeD1): Env {
  return { DB: asD1(db), RESEND_API_KEY: '', ENVIRONMENT: 'test', SESSION_DAYS: '7' };
}

function futuristicRow(id = 1, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id,
    email: EMAIL,
    code: '123456',
    used: 0,
    attempts: 0,
    created_at: new Date().toISOString(),
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function requestOtp(db: FakeD1): Promise<Response> {
  return authRouter.request('/otp/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL }),
  }, testEnv(db), executionCtx) as Promise<Response>;
}

function verifyOtp(db: FakeD1, code: string): Promise<Response> {
  return authRouter.request('/otp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, otp: code }),
  }, testEnv(db), executionCtx) as Promise<Response>;
}

describe('POST /api/auth/otp/request', () => {
  it('draws the OTP from the CSPRNG and yields a 6-digit code', async () => {
    const rng = vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      (arr as unknown as Uint32Array)[0] = 12345678;
      return arr;
    });
    try {
      let insertedCode: string | null = null;
      const db = new FakeD1([
        { match: sql => sql.includes('FROM email_whitelist'), rows: [{ id: 1 }] },
        { match: sql => sql.includes('MAX(created_at)'), rows: [] },
        { match: sql => sql.includes('COUNT(*)'), rows: [{ sent_hour: 0 }] },
        {
          match: (sql, args) => {
            if (sql.includes('INSERT INTO otps')) {
              insertedCode = args[1] as string;
              return true;
            }
            return false;
          },
          rows: [],
        },
      ]);

      const res = await requestOtp(db);
      const json = (await res.json()) as { success: boolean };

      expect(json.success).toBe(true);
      // 12345678 % 900000 === 645678 → code "745678"
      expect(insertedCode).toBe('745678');
      expect(insertedCode).toMatch(/^\d{6}$/);
      expect(rng).toHaveBeenCalled();
    } finally {
      rng.mockRestore();
    }
  });

  it('returns 429 on an immediate second send and allows a send after the cooldown', async () => {
    const rng = vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      (arr as unknown as Uint32Array)[0] = 1;
      return arr;
    });
    try {
      let lastSent: string | undefined;
      const db = new FakeD1([
        { match: sql => sql.includes('FROM email_whitelist'), rows: [{ id: 1 }] },
        { match: sql => sql.includes('MAX(created_at)'), rows: () => (lastSent ? [{ last_sent: lastSent }] : []) },
        { match: sql => sql.includes('COUNT(*)'), rows: [{ sent_hour: 0 }] },
        {
          match: (sql, args) => {
            if (sql.includes('INSERT INTO otps')) {
              lastSent = args[2] as string;
              return true;
            }
            return false;
          },
          rows: [],
        },
      ]);

      expect((await requestOtp(db)).status).toBe(200);

      const second = await requestOtp(db);
      expect(second.status).toBe(429);
      const secondJson = (await second.json()) as { message?: string };
      expect(secondJson.message).toBe('发送过于频繁，请稍后再试');

      lastSent = new Date(Date.now() - 120_000).toISOString();
      expect((await requestOtp(db)).status).toBe(200);
    } finally {
      rng.mockRestore();
    }
  });

  it('returns 429 once the hourly send cap is reached', async () => {
    const db = new FakeD1([
      { match: sql => sql.includes('FROM email_whitelist'), rows: [{ id: 1 }] },
      { match: sql => sql.includes('MAX(created_at)'), rows: [{ last_sent: new Date(Date.now() - 120_000).toISOString() }] },
      { match: sql => sql.includes('COUNT(*)'), rows: [{ sent_hour: 10 }] },
    ]);

    const res = await requestOtp(db);
    expect(res.status).toBe(429);
    const json = (await res.json()) as { message?: string };
    expect(json.message).toBe('发送次数已达上限，请稍后再试');
  });
});

describe('POST /api/auth/otp/verify', () => {
  it('increments attempts on a wrong code and rejects the correct code after the cap', async () => {
    let attempts = 0;
    const db = new FakeD1([
      { match: sql => sql.includes(OTPS_TABLE), rows: () => [futuristicRow(1, { attempts })] },
      {
        match: sql => {
          if (sql.includes('UPDATE otps SET attempts = attempts + 1')) {
            attempts += 1;
            return true;
          }
          return false;
        },
        rows: [],
        changes: 1,
      },
    ]);

    for (let i = 0; i < 5; i++) {
      const res = await verifyOtp(db, '111111');
      expect(res.status).toBe(401);
    }
    expect(attempts).toBe(5);

    const rejected = await verifyOtp(db, '123456');
    expect(rejected.status).toBe(401);
    expect(attempts).toBe(5);
    const json = (await rejected.json()) as { message?: string };
    expect(json.message).toBe('验证码无效或已过期');
  });

  it('rejects a verification when another request already consumed the code', async () => {
    const db = new FakeD1([
      { match: sql => sql.includes(OTPS_TABLE), rows: [futuristicRow(1)] },
      { match: sql => sql.includes(CONSUME_OTP), rows: [], changes: 0 },
    ]);

    const res = await verifyOtp(db, '123456');
    expect(res.status).toBe(401);
    const json = (await res.json()) as { message?: string };
    expect(json.message).toBe('验证码无效或已过期');
  });

  it('stores a SHA-256 hash of the session token and omits the token from the body', async () => {
    const rng = vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      const bytes = arr as unknown as Uint8Array;
      for (let i = 0; i < bytes.length; i++) bytes[i] = i;
      return arr;
    });
    try {
      let sessionArgs: unknown[] | null = null;
      const db = new FakeD1([
        { match: sql => sql.includes(OTPS_TABLE), rows: [futuristicRow(1)] },
        { match: sql => sql.includes(CONSUME_OTP), rows: [], changes: 1 },
        { match: sql => sql.includes('FROM users WHERE email'), rows: [] },
        { match: sql => sql.includes('INSERT INTO users'), rows: [{ id: 1, email: EMAIL, name: 'user', created_at: '', updated_at: '' }] },
        { match: sql => sql.includes('INSERT INTO portfolio'), rows: [] },
        {
          match: (sql, args) => {
            if (sql.includes('INSERT INTO sessions')) {
              sessionArgs = args;
              return true;
            }
            return false;
          },
          rows: [],
        },
      ]);

      const res = await verifyOtp(db, '123456');
      expect(res.status).toBe(200);

      const json = (await res.json()) as { success: boolean; data?: Record<string, unknown> };
      expect(json.data).not.toHaveProperty('token');

      const setCookie = res.headers.get('set-cookie') ?? '';
      const rawToken = setCookie.match(/session_token=([^;]+)/)?.[1] ?? '';
      expect(rawToken).toMatch(/^[0-9a-f]{64}$/);

      expect(sessionArgs).not.toBeNull();
      const stored = sessionArgs?.[0] as string | undefined;
      expect(stored).toMatch(/^[0-9a-f]{64}$/);
      expect(stored).not.toBe(rawToken);
      expect(stored).toBe(await sha256Hex(rawToken));
    } finally {
      rng.mockRestore();
    }
  });
});

describe('sessionMiddleware', () => {
  it('hashes the cookie before lookup and rejects a raw-token lookup', async () => {
    const db = new FakeD1([
      {
        match: sql => sql.includes(SESSION_LOOKUP),
        rows: (sql, args) => args[0] === STORED_HASH
          ? [{ id: 1, token: STORED_HASH, user_id: 7, expires_at: '2099-01-01T00:00:00.000Z', created_at: '', last_active: '', email: EMAIL, name: null }]
          : [],
      },
      { match: sql => sql.includes('UPDATE sessions SET last_active'), rows: [] },
    ]);

    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('/me', sessionMiddleware);
    app.get('/me', c => c.json({ success: true, data: {} }));

    const accepted = await app.request('/me', {
      headers: { Cookie: `session_token=${RAW_TOKEN}` },
    }, testEnv(db), executionCtx);
    expect(accepted.status).toBe(200);

    const rejected = await app.request('/me', {
      headers: { Cookie: `session_token=${STORED_HASH}` },
    }, testEnv(db), executionCtx);
    expect(rejected.status).toBe(401);
  });
});

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}