import type { Env, Variables } from './[[route]]';
import type { Context, Next } from 'hono';

import { Hono } from 'hono';
import { z } from 'zod';

import { emailShell, sendEmail } from './email';

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
  const tokenHash = await sha256Hex(match[1]);
  const session = await c.env.DB.prepare(
    'SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ? LIMIT 1'
  ).bind(tokenHash, now).all<{
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
    c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
    return c.json({ success: false, error: 'Unauthorized', message: '会话已过期' }, 401);
  }

  const row = session.results[0];
  c.set('userId', row.user_id);

  const updatePromise = c.env.DB.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').bind(now, row.id).run().catch((err) => { console.error('Failed to update last_active:', err); });
  c.executionCtx.waitUntil(updatePromise);

  await next();
}

const authRouter = new Hono<{ Bindings: Env }>();

const otpRequestSchema = z.object({ email: z.string().email() });
const otpVerifySchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6).regex(/^\d{6}$/),
});

const OTP_REQUEST_COOLDOWN_MS = 60_000; // 60s between sends to the same email
const OTP_REQUEST_HOURLY_CAP = 10; // max sends per email per rolling hour
const OTP_MAX_ATTEMPTS = 5; // failed verifies before an issued code is dead

interface OtpRow {
  id: number;
  email: string;
  code: string;
  used: number;
  attempts: number;
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

async function getUserFromSession(c: Context<{ Bindings: Env }>, now: string) {
  const cookie = c.req.header('cookie') ?? '';
  const match = cookie.match(/session_token=([^;\s]+)/);
  if (!match) return null;

  const tokenHash = await sha256Hex(match[1]);
  const session = await c.env.DB.prepare(
    'SELECT s.*, u.email, u.name, u.preferences FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ? LIMIT 1'
  ).bind(tokenHash, now).all<{
    id: number;
    token: string;
    user_id: number;
    created_at: string;
    expires_at: string;
    last_active: string;
    email: string;
    name: string | null;
    preferences: string | null;
  }>();

  if (session.results.length === 0) return null;

  const row = session.results[0];
  const updatePromise = c.env.DB.prepare('UPDATE sessions SET last_active = ? WHERE id = ?').bind(now, row.id).run().catch((err) => { console.error('Failed to update last_active:', err); });
  c.executionCtx.waitUntil(updatePromise);
  return row;
}

function generateOtp(): string {
  // The 6-digit code is the only credential in this passwordless system, so
  // Math.random() (not CSPRNG) is unacceptable. Draw a 32-bit value from
  // crypto.getRandomValues and rejection-sample above the largest multiple of
  // 900000 in [0, 2^32) so the modulo is unbiased.
  const arr = new Uint32Array(1);
  const limit = 0xffffffff - (0xffffffff % 900000);
  do {
    crypto.getRandomValues(arr);
  } while (arr[0] >= limit);
  return (100000 + (arr[0] % 900000)).toString();
}

function generateToken(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
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
  const sent = await sendEmail(apiKey, email, '您的 Alpha-Life 登录验证码', emailShell('您的登录验证码', `
    <div style="font-size:32px;font-weight:bold;text-align:center;padding:16px;background:#eff6ff;border-radius:6px;color:#1d4ed8;">${code}</div>
    <p style="color:#6b7280;font-size:14px;">10分钟内有效</p>
  `));
  if (!sent) {
    throw new Error('验证码邮件发送失败，请稍后重试');
  }
}

// POST /api/auth/otp/request
authRouter.post('/otp/request', async (c) => {
  try {
    const parsed = otpRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: '验证失败', message: '邮箱格式不正确' }, 400);
    }
    const { email } = parsed.data;
    const db = c.env.DB;

    const whitelist = await db.prepare(
      'SELECT * FROM email_whitelist WHERE email = ? LIMIT 1'
    ).bind(email).all();

    if (!whitelist.results.length) {
      return c.json({ success: false, error: 'Unauthorized', message: '邮箱未在白名单中' }, 403);
    }

    // Per-email 60s cooldown: the last sent code must be older than the window.
    const cooldownFrom = new Date(Date.now() - OTP_REQUEST_COOLDOWN_MS).toISOString();
    const lastSent = await db.prepare(
      'SELECT MAX(created_at) AS last_sent FROM otps WHERE email = ?'
    ).bind(email).first<{ last_sent: string }>();

    if (lastSent && lastSent.last_sent >= cooldownFrom) {
      return c.json({ success: false, error: 'Too Many Requests', message: '发送过于频繁，请稍后再试' }, 429);
    }

    // Rolling hourly cap per email, counted from otps.created_at.
    const hourFrom = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const hourCount = await db.prepare(
      'SELECT COUNT(*) AS sent_hour FROM otps WHERE email = ? AND created_at > ?'
    ).bind(email, hourFrom).first<{ sent_hour: number }>();

    if ((hourCount?.sent_hour ?? 0) >= OTP_REQUEST_HOURLY_CAP) {
      return c.json({ success: false, error: 'Too Many Requests', message: '发送次数已达上限，请稍后再试' }, 429);
    }

    const code = generateOtp();
    // 条件 INSERT（冷却 + 时上限都在 INSERT 的 WHERE 内原子求值）：
    // 上面两个 SELECT 只是友好报错的快路径；并发请求在此处串行裁决，
    // 后到者 changes=0 → 429，不会双双穿过 60s 冷却多发邮件
    const insert = await db.prepare(
      `INSERT INTO otps (email, code, used, attempts, created_at, expires_at)
       SELECT ?, ?, 0, 0, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM otps WHERE email = ? AND created_at > ?)
         AND (SELECT COUNT(*) FROM otps WHERE email = ? AND created_at > ?) < ?
       RETURNING id`
    ).bind(email, code, nowIso(), addMinutes(10), email, cooldownFrom, email, hourFrom, OTP_REQUEST_HOURLY_CAP).first<{ id: number }>();
    if (!insert) {
      return c.json({ success: false, error: 'Too Many Requests', message: '发送过于频繁，请稍后再试' }, 429);
    }

    await sendOtpEmail(email, code, c.env.RESEND_API_KEY);

    return c.json({ success: true, data: { message: '验证码已发送', expires_in: 600 } });
  } catch (error) {
    return c.json({ success: false, error: 'Failed', message: (error as Error).message }, 500);
  }
});

// POST /api/auth/otp/verify
authRouter.post('/otp/verify', async (c) => {
  try {
    const parsed = otpVerifySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: '验证失败', message: '邮箱或验证码格式不正确' }, 400);
    }
    const { email, otp } = parsed.data;
    const db = c.env.DB;
    const now = nowIso();

    // 已发出的验证码最多 10 分钟有效：白名单必须在 verify 入口复核，
    // 否则移出白名单的邮箱在码过期前仍可登录
    const whitelist = await db.prepare(
      'SELECT 1 AS ok FROM email_whitelist WHERE email = ? LIMIT 1'
    ).bind(email).first<{ ok: number }>();
    if (!whitelist) {
      return c.json({ success: false, error: 'Unauthorized', message: '邮箱未在白名单中' }, 403);
    }

    // Attribute every attempt to the newest live code so the attempt cap is
    // enforceable. No-code, dead-code and wrong-code all answer identically.
    const otpResult = await db.prepare(
      'SELECT * FROM otps WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1'
    ).bind(email, now).all<OtpRow>();

    if (!otpResult.results.length) {
      return c.json({ success: false, error: 'Invalid OTP', message: '验证码无效或已过期' }, 401);
    }

    const otpRow = otpResult.results[0];

    if (otpRow.attempts >= OTP_MAX_ATTEMPTS) {
      return c.json({ success: false, error: 'Invalid OTP', message: '验证码无效或已过期' }, 401);
    }

    if (otpRow.code !== otp) {
      await db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE id = ?').bind(otpRow.id).run();
      return c.json({ success: false, error: 'Invalid OTP', message: '验证码无效或已过期' }, 401);
    }

    // Atomic single-use: only one concurrent verify wins the used = 0 -> 1 flip.
    const consume = await db.prepare('UPDATE otps SET used = 1 WHERE id = ? AND used = 0').bind(otpRow.id).run();
    if (consume.meta.changes !== 1) {
      return c.json({ success: false, error: 'Invalid OTP', message: '验证码无效或已过期' }, 401);
    }

    const userResult = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).all<UserRow>();
    let user: UserRow;

    if (!userResult.results.length) {
      // 首登 user + portfolio 同一批次原子落库（此前两跳：user 已插入而
      // portfolio 瞬时失败会留下永久孤儿 user，此后每次登录都走 else 分支
      // 不再补建，POST /transactions 永远 400）。ON CONFLICT DO NOTHING 容忍
      // 并发首登；portfolio 侧由 NOT EXISTS + 唯一索引幂等。
      await db.batch([
        db.prepare(
          `INSERT INTO users (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(email) DO NOTHING`
        ).bind(email, email.split('@')[0], now, now),
        db.prepare(
          `INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance, created_at, updated_at)
           SELECT id, 0, 0, 0, ?, ? FROM users WHERE email = ?
           WHERE NOT EXISTS (SELECT 1 FROM portfolio WHERE user_id = (SELECT id FROM users WHERE email = ?))`
        ).bind(now, now, email, email),
      ]);
      user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>() as UserRow;
    } else {
      user = userResult.results[0];
      // 幂等补建历史孤儿 user 的 portfolio（唯一索引保证不重复）
      await db.prepare(
        `INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance, created_at, updated_at)
         SELECT id, 0, 0, 0, ?, ? FROM users WHERE email = ?
         WHERE NOT EXISTS (SELECT 1 FROM portfolio WHERE user_id = (SELECT id FROM users WHERE email = ?))`
      ).bind(now, now, email, email).run();
    }

    const sessionDays = parseInt(c.env.SESSION_DAYS || '7');
    const token = generateToken();
    const tokenHash = await sha256Hex(token);
    const expiresAt = addDays(sessionDays);

    await db.prepare(
      'INSERT INTO sessions (token, user_id, created_at, expires_at, last_active) VALUES (?, ?, ?, ?, ?)'
    ).bind(tokenHash, user.id, now, expiresAt, now).run();

    const isSecure = c.env.ENVIRONMENT === 'production';
    c.header('Set-Cookie', `session_token=${token}; HttpOnly; Path=/; Max-Age=${sessionDays * 86400}; ${isSecure ? 'Secure; ' : ''}SameSite=Strict`);

    return c.json({
      success: true,
      data: { user: { id: user.id, email: user.email, name: user.name }, expires_at: expiresAt },
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
    const tokenHash = await sha256Hex(match[1]);
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(tokenHash).run();
  }
  c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
  return c.json({ success: true, data: { message: '已退出登录' } });
});

// GET /api/auth/me
authRouter.get('/me', async (c) => {
  const now = nowIso();
  const row = await getUserFromSession(c, now);
  if (!row) {
    c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
    return c.json({ success: false, error: 'Session expired' }, 401);
  }

  return c.json({
    success: true,
    data: { user: { id: row.user_id, email: row.email, name: row.name } },
  });
});

function parsePreferences(preferences: string | null): Record<string, unknown> {
  if (!preferences) return {};
  try {
    const parsed = JSON.parse(preferences);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// GET /api/auth/profile
authRouter.get('/profile', async (c) => {
  try {
    const now = nowIso();
    const row = await getUserFromSession(c, now);
    if (!row) {
      c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
      return c.json({ success: false, error: 'Session expired' }, 401);
    }

    const prefs = parsePreferences(row.preferences);

    return c.json({ success: true, data: { id: row.user_id, email: row.email, name: row.name, preferences: prefs }, timestamp: now });
  } catch (error) {
    return c.json({ success: false, error: 'Failed', message: (error as Error).message }, 500);
  }
});

// PUT /api/auth/profile
authRouter.put('/profile', async (c) => {
  try {
    const now = nowIso();
    const row = await getUserFromSession(c, now);
    if (!row) {
      c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
      return c.json({ success: false, error: 'Unauthorized', message: '会话已过期' }, 401);
    }

    const currentYear = new Date().getFullYear();
    const body = await c.req.json();
    const parsed = z.object({
      birth_year: z.number().int().min(1900).max(currentYear),
      birth_month: z.number().int().min(1).max(12).optional(),
      birth_day: z.number().int().min(1).max(31).optional(),
    }).superRefine((data, ctx) => {
      if (data.birth_month !== undefined && data.birth_day !== undefined) {
        const d = new Date(data.birth_year, data.birth_month - 1, data.birth_day);
        if (d.getMonth() !== data.birth_month - 1) {
          ctx.addIssue({ code: 'custom', message: '无效的日期' });
        }
      }
    }).safeParse(body);

    if (!parsed.success) {
      return c.json({
        success: false, error: '验证失败',
        message: parsed.error.issues.map((e: { message: string }) => e.message).join(', '),
      }, 400);
    }

    const { birth_year, birth_month, birth_day } = parsed.data;
    const prefs = parsePreferences(row.preferences);
    prefs.birth_year = birth_year;
    if (birth_month !== undefined) prefs.birth_month = birth_month;
    if (birth_day !== undefined) prefs.birth_day = birth_day;

    await c.env.DB.prepare(
      'UPDATE users SET preferences = ?, updated_at = ? WHERE id = ?'
    ).bind(JSON.stringify(prefs), now, row.user_id).run();

    return c.json({ success: true, data: { birth_year, birth_month, birth_day }, timestamp: now });
  } catch (error) {
    return c.json({ success: false, error: 'Failed', message: (error as Error).message }, 500);
  }
});

export { authRouter };
