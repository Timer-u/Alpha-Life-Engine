import type { Env, Variables } from './[[route]]';
import type { Context, Next } from 'hono';

import { Hono } from 'hono';
import { z } from 'zod';

function nowIso(): string {
  return new Date().toISOString();
}

export async function sessionMiddleware(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const cookie = c.req.header('cookie') ?? '';
  const match = cookie.match(/session_token=([^;\s]+)/);
  if (!match) {
    return c.json({ success: false, error: 'Unauthorized', message: '未登录' }, 401);
  }

  const now = nowIso();
  const session = await c.env.DB.prepare(
    'SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ? LIMIT 1'
  ).bind(match[1], now).all<{
    id: number;
    token: string;
    user_id: number;
    created_at: string;
    expires_at: string;
    last_active: string;
    email: string;
    name: string;
  }>();

  if (session.results.length === 0) {
    c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return c.json({ success: false, error: 'Unauthorized', message: '会话已过期' }, 401);
  }

  const row = session.results[0];
  c.set('userId', row.user_id);

  c.env.DB.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').bind(now, row.id).run().catch(() => {});

  await next();
}

const authRouter = new Hono<{ Bindings: Env }>();

const otpRequestSchema = z.object({ email: z.string().email() });
const otpVerifySchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6).regex(/^\d{6}$/),
});

interface OtpRow {
  id: number;
  email: string;
  code: string;
  used: number;
  created_at: string;
  expires_at: string;
}

interface UserRow {
  id: number;
  email: string;
  name: string | null;
  avatar_url: string | null;
  phone: string | null;
  preferences: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: number;
  token: string;
  user_id: number;
  created_at: string;
  expires_at: string;
  last_active: string;
  email: string;
  name: string | null;
}

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function addDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function addMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function sendOtpEmail(email: string, code: string, apiKey: string): Promise<void> {
  if (!apiKey) {
    console.warn('[DEV] OTP:', code);
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: 'no-reply@alpha-life.yourdomain.com',
      to: email,
      subject: '您的 Alpha-Life 登录验证码',
      html: `<div style="font-family:system-ui;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#1d4ed8;">Alpha-Life Engine</h2>
        <p>您的验证码：</p>
        <div style="font-size:32px;font-weight:bold;text-align:center;padding:16px;background:#eff6ff;border-radius:6px;color:#1d4ed8;">${code}</div>
        <p style="color:#6b7280;font-size:14px;">10分钟内有效</p>
      </div>`,
    }),
  });
}

// POST /api/auth/otp/request
authRouter.post('/otp/request', async (c) => {
  try {
    const { email } = otpRequestSchema.parse(await c.req.json());
    const db = c.env.DB;

    const whitelist = await db.prepare(
      'SELECT * FROM email_whitelist WHERE email = ? LIMIT 1'
    ).bind(email).all();

    if (!whitelist.results.length) {
      return c.json({ success: false, error: 'Unauthorized', message: '邮箱未在白名单中' }, 403);
    }

    const code = generateOtp();
    await db.prepare(
      'INSERT INTO otps (email, code, used, created_at, expires_at) VALUES (?, ?, 0, ?, ?)'
    ).bind(email, code, nowIso(), addMinutes(10)).run();

    await sendOtpEmail(email, code, c.env.RESEND_API_KEY);

    return c.json({ success: true, data: { message: '验证码已发送', expires_in: 600 } });
  } catch (error) {
    return c.json({ success: false, error: 'Failed', message: (error as Error).message }, 500);
  }
});

// POST /api/auth/otp/verify
authRouter.post('/otp/verify', async (c) => {
  try {
    const { email, otp } = otpVerifySchema.parse(await c.req.json());
    const db = c.env.DB;
    const now = nowIso();

    const otpResult = await db.prepare(
      'SELECT * FROM otps WHERE email = ? AND code = ? AND used = 0 AND expires_at > ? LIMIT 1'
    ).bind(email, otp, now).all<OtpRow>();

    if (!otpResult.results.length) {
      return c.json({ success: false, error: 'Invalid OTP', message: '验证码无效或已过期' }, 401);
    }

    const otpRow = otpResult.results[0];
    await db.prepare('UPDATE otps SET used = 1 WHERE id = ?').bind(otpRow.id).run();

    const userResult = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).all<UserRow>();
    let user: UserRow;

    if (!userResult.results.length) {
      const insert = await db.prepare(
        'INSERT INTO users (email, name, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *'
      ).bind(email, email.split('@')[0], now, now).all<UserRow>();
      user = insert.results![0];

      await db.prepare(
        'INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance, created_at, updated_at) VALUES (?, 0, 0, 0, ?, ?)'
      ).bind(user.id, now, now).run();
    } else {
      user = userResult.results[0];
    }

    const sessionDays = parseInt(c.env.SESSION_DAYS || '7');
    const token = generateToken();
    const expiresAt = addDays(sessionDays);

    await db.prepare(
      'INSERT INTO sessions (token, user_id, created_at, expires_at, last_active) VALUES (?, ?, ?, ?, ?)'
    ).bind(token, user.id, now, expiresAt, now).run();

    const isSecure = c.env.ENVIRONMENT === 'production';
    c.header('Set-Cookie', `session_token=${token}; HttpOnly; Path=/; Max-Age=${sessionDays * 86400}; ${isSecure ? 'Secure; ' : ''}SameSite=Lax`);

    return c.json({
      success: true,
      data: { token, user: { id: user.id, email: user.email, name: user.name }, expires_at: expiresAt },
    });
  } catch (error) {
    return c.json({ success: false, error: 'Failed', message: (error as Error).message }, 500);
  }
});

// POST /api/auth/logout
authRouter.post('/logout', async (c) => {
  const cookie = c.req.header('cookie') ?? '';
  const match = cookie.match(/session_token=([^;\s]+)/);
  if (match) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(match[1]).run();
  }
  c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  return c.json({ success: true, data: { message: '已退出登录' } });
});

// GET /api/auth/me
authRouter.get('/me', async (c) => {
  const cookie = c.req.header('cookie') ?? '';
  const match = cookie.match(/session_token=([^;\s]+)/);
  if (!match) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const now = nowIso();
  const session = await c.env.DB.prepare(
    'SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ? LIMIT 1'
  ).bind(match[1], now).all<SessionRow>();

  if (!session.results.length) {
    c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return c.json({ success: false, error: 'Session expired' }, 401);
  }

  const row = session.results[0];
  await c.env.DB.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').bind(now, row.id).run();

  return c.json({
    success: true,
    data: { user: { id: row.user_id, email: row.email, name: row.name } },
  });
});

export { authRouter };
