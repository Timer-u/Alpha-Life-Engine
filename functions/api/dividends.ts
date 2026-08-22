import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { sessionMiddleware } from './auth';
import { TRACKED_SYMBOLS } from './symbols';

const dividendsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

function nowIso(): string {
  return new Date().toISOString();
}

const EX_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dividendSchema = z.object({
  symbol: z.string().min(1).refine(s => TRACKED_SYMBOLS.includes(s), '仅支持系统跟踪的 ETF 标的'),
  ex_date: z.string().regex(EX_DATE_RE, 'ex_date 必须是 YYYY-MM-DD'),
  type: z.enum(['cash', 'split']),
  amount_per_share: z.number().positive().optional(),
  split_ratio: z.number().positive().optional(),
  notes: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.type === 'cash' && data.amount_per_share === undefined) {
    ctx.addIssue({ code: 'custom', message: '现金分红必须提供 amount_per_share' });
  }
  if (data.type === 'split' && data.split_ratio === undefined) {
    ctx.addIssue({ code: 'custom', message: '拆股/送股必须提供 split_ratio' });
  }
});

dividendsRouter.use('*', sessionMiddleware);

interface PositionRow { id: number; shares: number; layer: 'safe' | 'ambition' }

// POST /api/dividends — 记录分红/除权事件并原子应用到当前持仓
dividendsRouter.post('/', async (c) => {
  try {
    const userId = c.get('userId');
    const parsed = dividendSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: '验证失败', message: parsed.error.issues.map(e => e.message).join(', ') }, 400);
    }
    const data = parsed.data;
    const db = c.env.DB;
    const now = nowIso();

    const positionsResult = await db.prepare(
      'SELECT id, shares, layer FROM positions WHERE user_id = ? AND symbol = ?'
    ).bind(userId, data.symbol).all<PositionRow>();
    const positions = positionsResult.results;

    const duplicateGuard = `(SELECT COUNT(*) FROM dividend_events WHERE user_id = ? AND symbol = ? AND ex_date = ? AND type = ?) = 0`;
    const guardArgs: unknown[] = [userId, data.symbol, data.ex_date, data.type];

    const statements: D1PreparedStatement[] = [];

    if (data.type === 'cash' && positions.length > 0) {
      const layerBalances: Record<'safe' | 'ambition', number> = { safe: 0, ambition: 0 };
      for (const p of positions) {
        const cashCents = Math.round(p.shares * data.amount_per_share! * 100);
        layerBalances[p.layer] += cashCents;
      }
      for (const layer of ['safe', 'ambition'] as const) {
        const delta = layerBalances[layer];
        if (delta <= 0) continue;
        // 现金分红计入层级余额的同时必须计入 total_balance：
        // total = safe + ambition 的不变式在充值/买卖处均维持，
        // trigger 判定与 reconciliation 系统总额都读 total_balance
        statements.push(db.prepare(
          `UPDATE portfolio SET ${layer}_layer_balance = ${layer}_layer_balance + ?, total_balance = total_balance + ?, last_balance_update = ?, updated_at = ?
           WHERE user_id = ? AND ${duplicateGuard}`
        ).bind(delta, delta, now, now, userId, ...guardArgs));
      }
    } else if (data.type === 'split' && positions.length > 0) {
      statements.push(db.prepare(
        `UPDATE positions SET shares = ROUND(shares * ?, 6), avg_price = avg_price / ?
         WHERE user_id = ? AND symbol = ? AND ${duplicateGuard}`
      ).bind(data.split_ratio!, data.split_ratio!, userId, data.symbol, ...guardArgs));
    }

    statements.push(db.prepare(
      `INSERT INTO audit_logs (user_id, action, entity, old_value, new_value, created_at)
       SELECT ?, 'dividend', 'dividend_events', NULL, ?, ?
       WHERE ${duplicateGuard}`
    ).bind(userId, JSON.stringify({
      symbol: data.symbol, ex_date: data.ex_date, type: data.type,
      amount_per_share: data.amount_per_share ?? null, split_ratio: data.split_ratio ?? null,
    }), now, ...guardArgs));

    // index of the dividend_events INSERT in the batch, captured at build time
    // so a reorder can never silently break the duplicate-anchor read
    const dividendInsertIndex = statements.length;
    statements.push(db.prepare(
      `INSERT INTO dividend_events (user_id, symbol, ex_date, type, amount_per_share, split_ratio, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, symbol, ex_date, type) DO NOTHING RETURNING *`
    ).bind(userId, data.symbol, data.ex_date, data.type,
      data.amount_per_share ?? null, data.split_ratio ?? null, data.notes ?? null, now));

    const results = await db.batch(statements);
    const inserted = results[dividendInsertIndex]?.results[0];
    if (!inserted) {
      const existing = await db.prepare(
        'SELECT id, ex_date FROM dividend_events WHERE user_id = ? AND symbol = ? AND ex_date = ? AND type = ?'
      ).bind(userId, data.symbol, data.ex_date, data.type).first<{ id: number; ex_date: string }>();
      return c.json({
        success: true,
        data: { duplicate: true, ...data },
        message: `该分红/除权事件已记录（重复请求已忽略）${existing ? `：${existing.ex_date}` : ''}`,
        timestamp: now,
      });
    }

    const applied = positions.length > 0 ? `，已应用到 ${positions.length} 条持仓` : '（当前无该标的持仓，仅记录事件）';
    return c.json({
      success: true,
      data: { duplicate: false, ...data, applied_positions: positions.length },
      message: `已记录${data.type === 'cash' ? '现金分红' : '拆股/送股'}${applied}`,
      timestamp: now,
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// GET /api/dividends — 列表（近 100 条）
dividendsRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const result = await c.env.DB.prepare(
      'SELECT * FROM dividend_events WHERE user_id = ? ORDER BY ex_date DESC, id DESC LIMIT 100'
    ).bind(userId).all();
    return c.json({ success: true, data: result.results, timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { dividendsRouter };
