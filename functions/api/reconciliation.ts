import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { sessionMiddleware } from './auth';
import { resolveActiveParams } from './lch-utils';

const reconciliationRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// 差异超过该比例（1%）时需要校准
const CALIBRATION_THRESHOLD = 0.01;

function nowIso(): string {
  return new Date().toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface ReconciliationRow {
  id: number;
  user_id: number;
  reconciliation_date: string;
  beginning_balance: number;
  deposits: number;
  withdrawals: number;
  gains: number;
  fees: number;
  ending_balance: number;
  variance: number;
  notes: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'ARCHIVED';
  created_at: string;
  updated_at: string;
}

interface PortfolioRow {
  total_balance: number;
  safe_layer_balance: number;
  ambition_layer_balance: number;
}

/** 系统侧总资产 = 资金池现金 + 持仓市值（按最新收盘价估值） */
async function computeSystemState(db: D1Database, userId: number): Promise<{
  cash: PortfolioRow;
  holdingsValue: number;
  systemTotal: number;
}> {
  const portfolio = await db.prepare(
    'SELECT total_balance, safe_layer_balance, ambition_layer_balance FROM portfolio WHERE user_id = ?'
  ).bind(userId).first<PortfolioRow>();
  const cash = portfolio ?? { total_balance: 0, safe_layer_balance: 0, ambition_layer_balance: 0 };

  const positions = await db.prepare(
    'SELECT symbol, shares, current_price FROM positions WHERE user_id = ?'
  ).bind(userId).all<{ symbol: string; shares: number; current_price: number }>();

  let holdingsValue = 0;
  for (const pos of positions.results) {
    const latest = await db.prepare(
      'SELECT close FROM market_data WHERE symbol = ? AND close IS NOT NULL ORDER BY date DESC LIMIT 1'
    ).bind(pos.symbol).first<{ close: number }>();
    const price = latest?.close ?? pos.current_price;
    holdingsValue += pos.shares * price;
  }

  return { cash, holdingsValue: round2(holdingsValue), systemTotal: round2(cash.total_balance + holdingsValue) };
}

function variancePct(variance: number, base: number): number {
  if (base <= 0) return variance === 0 ? 0 : 1;
  return Math.abs(variance) / base;
}

reconciliationRouter.use('*', sessionMiddleware);

// GET /api/reconciliation
reconciliationRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const result = await c.env.DB.prepare(
      'SELECT * FROM reconciliations WHERE user_id = ? ORDER BY reconciliation_date DESC LIMIT 24'
    ).bind(userId).all<ReconciliationRow>();

    return c.json({ success: true, data: result.results, timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

const reconciliationSchema = z.object({
  reconciliation_date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM'),
  broker_balance: z.number().min(0),
  deposits: z.number().min(0).optional(),
  withdrawals: z.number().min(0).optional(),
  gains: z.number().optional(),
  fees: z.number().min(0).optional(),
  notes: z.string().max(500).optional(),
});

// POST /api/reconciliation
// 月度对账：券商总资产 vs 系统总资产（现金池 + 持仓市值）
// 差异 <= 1% 自动 CONFIRMED，> 1% 标记 PENDING 等待一键校准
reconciliationRouter.post('/', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;
    const parsed = reconciliationSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        success: false,
        error: '验证失败',
        message: parsed.error.issues.map((e: { message: string }) => e.message).join(', '),
      }, 400);
    }
    const data = parsed.data;
    const now = nowIso();

    const { cash, holdingsValue, systemTotal } = await computeSystemState(db, userId);
    const variance = round2(data.broker_balance - systemTotal);
    const pct = variancePct(variance, systemTotal);
    const needsCalibration = pct > CALIBRATION_THRESHOLD;
    const status: ReconciliationRow['status'] = needsCalibration ? 'PENDING' : 'CONFIRMED';

    const result = await db.prepare(
      `INSERT INTO reconciliations
         (user_id, reconciliation_date, beginning_balance, deposits, withdrawals, gains, fees, ending_balance, variance, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, reconciliation_date) DO UPDATE SET
         beginning_balance = excluded.beginning_balance,
         deposits = excluded.deposits,
         withdrawals = excluded.withdrawals,
         gains = excluded.gains,
         fees = excluded.fees,
         ending_balance = excluded.ending_balance,
         variance = excluded.variance,
         notes = excluded.notes,
         status = excluded.status,
         updated_at = excluded.updated_at
       RETURNING *`
    ).bind(
      userId, data.reconciliation_date, systemTotal,
      data.deposits ?? 0, data.withdrawals ?? 0, data.gains ?? 0, data.fees ?? 0,
      data.broker_balance, variance, data.notes ?? null, status, now, now
    ).first<ReconciliationRow>();

    return c.json({
      success: true,
      data: {
        reconciliation: result,
        comparison: {
          system_cash: cash.total_balance,
          system_holdings_value: holdingsValue,
          system_total: systemTotal,
          broker_balance: data.broker_balance,
          variance,
          variance_pct: round2(pct * 100),
          needs_calibration: needsCalibration,
        },
      },
      message: needsCalibration
        ? `差异 ${(pct * 100).toFixed(2)}% 超过 1%，建议执行一键校准`
        : `差异 ${(pct * 100).toFixed(2)}% 在允许范围内，对账通过`,
      timestamp: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// POST /api/reconciliation/:id/calibrate
// 一键校准：将系统资金池现金调整为（券商总资产 - 持仓市值），
// 各层现金按现有比例（或 LCH 比例）重新分摊
reconciliationRouter.post('/:id/calibrate', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) {
      return c.json({ success: false, error: 'Invalid input', message: '无效的对账记录ID' }, 400);
    }
    const now = nowIso();

    const rec = await db.prepare(
      'SELECT * FROM reconciliations WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first<ReconciliationRow>();
    if (!rec) {
      return c.json({ success: false, error: 'Not Found', message: '对账记录不存在' }, 404);
    }
    if (rec.status !== 'PENDING') {
      return c.json({ success: false, error: 'Invalid state', message: '该对账记录已确认，无需校准' }, 400);
    }

    const { cash, holdingsValue } = await computeSystemState(db, userId);
    const targetCash = Math.max(round2(rec.ending_balance - holdingsValue), 0);

    // 现金按层级现有占比分摊；现金池为空时退回 LCH/演化比例
    let safeRatio: number;
    if (cash.total_balance > 0) {
      safeRatio = cash.safe_layer_balance / cash.total_balance;
    } else {
      const { allocation } = await resolveActiveParams(db, userId);
      safeRatio = allocation?.safe_ratio ?? 0.6;
    }
    const newSafe = round2(targetCash * safeRatio);
    const newAmbition = round2(targetCash - newSafe);

    await db.batch([
      db.prepare(
        'UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, last_balance_update = ?, updated_at = ? WHERE user_id = ?'
      ).bind(targetCash, newSafe, newAmbition, now, now, userId),
      db.prepare(
        'UPDATE reconciliations SET status = ?, updated_at = ? WHERE id = ?'
      ).bind('CONFIRMED', now, id),
    ]);

    return c.json({
      success: true,
      data: {
        portfolio: {
          total_balance: targetCash,
          safe_layer_balance: newSafe,
          ambition_layer_balance: newAmbition,
        },
        holdings_value: holdingsValue,
        system_total: round2(targetCash + holdingsValue),
      },
      message: `已校准：资金池现金调整为 ¥${targetCash.toFixed(2)}（安全层 ¥${newSafe.toFixed(2)} / 进取层 ¥${newAmbition.toFixed(2)}）`,
      timestamp: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { reconciliationRouter };
