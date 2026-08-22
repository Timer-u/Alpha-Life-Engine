import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { centsToYuan } from '../../src/lib/money';

import { sessionMiddleware } from './auth';
import { clampRatio, resolveActiveParams } from './lch-utils';

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
  // 注意：beginning_balance 语义为“对账发起时系统总资产”（现金池 + 持仓市值），
  // 并非月初余额；与券商侧对比仅作参考基准
  beginning_balance: number;
  // deposits/withdrawals/gains/fees 为用户手工填写的月度出入金/盈亏/费用，仅作信息性存档，
  // 不参与差异计算：variance = 券商总资产 - 系统总资产
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

/** 系统侧总资产 = 资金池现金 + 持仓市值（按最新收盘价估值），单位分 */
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
  const holdings = positions.results;

  let holdingsValue = 0;
  if (holdings.length > 0) {
    const symbols = [...new Set(holdings.map(pos => pos.symbol))];
    const placeholders = symbols.map(() => '?').join(',');
    const priceRows = await db.prepare(
      `SELECT m.symbol, m.close FROM market_data m
       JOIN (SELECT symbol, MAX(date) AS max_date FROM market_data
             WHERE symbol IN (${placeholders}) AND close IS NOT NULL GROUP BY symbol) latest
       ON m.symbol = latest.symbol AND m.date = latest.max_date`
    ).bind(...symbols).all<{ symbol: string; close: number }>();
    const priceMap = new Map(priceRows.results.map(row => [row.symbol, row.close]));

    for (const pos of holdings) {
      const price = priceMap.get(pos.symbol) ?? pos.current_price;
      holdingsValue += pos.shares * price;
    }
    holdingsValue = Math.round(holdingsValue * 100);
  }

  const systemTotal = cash.total_balance + holdingsValue;
  return { cash, holdingsValue, systemTotal };
}

export function variancePct(variance: number, base: number): number {
  if (base <= 0) return variance === 0 ? 0 : 1;
  return Math.abs(variance) / base;
}

reconciliationRouter.use('*', sessionMiddleware);

// GET /api/reconciliation
reconciliationRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const rawLimit = parseInt(c.req.query('limit') ?? '24', 10);
    const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 24;
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

    const [totalResult, result] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) AS total FROM reconciliations WHERE user_id = ?').bind(userId).first<{ total: number }>(),
      c.env.DB.prepare(
        'SELECT * FROM reconciliations WHERE user_id = ? ORDER BY reconciliation_date DESC LIMIT ? OFFSET ?'
      ).bind(userId, limit, offset).all<ReconciliationRow>(),
    ]);

    return c.json({
      success: true,
      data: result.results,
      pagination: { total: totalResult?.total ?? 0, limit, offset },
      timestamp: nowIso(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

const reconciliationSchema = z.object({
  reconciliation_date: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM'),
  broker_balance: z.number().int().min(0),
  deposits: z.number().int().min(0).optional(),
  withdrawals: z.number().int().min(0).optional(),
  gains: z.number().int().optional(),
  fees: z.number().int().min(0).optional(),
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
    const variance = data.broker_balance - systemTotal;
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

    // 仅最新一条 PENDING 可校准：旧记录的 ending_balance（券商总资产）属于
    // 它自己的月份，用它改写"当前"资金池（= 旧券商总资产 − 当前持仓市值）
    // 会静默引入过期基准
    const latestPending = await db.prepare(
      `SELECT id FROM reconciliations WHERE user_id = ? AND status = 'PENDING'
       ORDER BY reconciliation_date DESC, id DESC LIMIT 1`
    ).bind(userId).first<{ id: number }>();
    if (latestPending?.id !== rec.id) {
      return c.json({
        success: false,
        error: 'Stale record',
        message: '仅最新一条待校准记录可执行一键校准；旧月份记录的券商余额不适用于当前资金池，请对当月重新发起对账',
      }, 409);
    }

    const { cash, holdingsValue } = await computeSystemState(db, userId);
    const targetCash = Math.max(rec.ending_balance - holdingsValue, 0);

    // 现金按层级现有占比分摊；占比钳位到 [0,1]，防止不一致余额产生负层现金。
    // 现金池为空时退回 LCH/演化比例
    let safeRatio: number;
    if (cash.total_balance > 0) {
      safeRatio = clampRatio(cash.safe_layer_balance / cash.total_balance);
    } else {
      const { allocation } = await resolveActiveParams(db, userId);
      safeRatio = clampRatio(allocation?.safe_ratio ?? 0.6);
    }
    const newSafe = Math.floor(targetCash * safeRatio);
    const newAmbition = targetCash - newSafe;

    await db.batch([
      db.prepare(
        'UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, last_balance_update = ?, updated_at = ? WHERE user_id = ?'
      ).bind(targetCash, newSafe, newAmbition, now, now, userId),
      db.prepare(
        'UPDATE reconciliations SET status = ?, updated_at = ? WHERE id = ?'
      ).bind('CONFIRMED', now, id),
      db.prepare(
        `INSERT INTO audit_logs (user_id, action, entity, old_value, new_value, created_at) VALUES (?, 'calibrate', 'portfolio', ?, ?, ?)`
      ).bind(
        userId,
        JSON.stringify({ total_balance: cash.total_balance, safe_layer_balance: cash.safe_layer_balance, ambition_layer_balance: cash.ambition_layer_balance }),
        JSON.stringify({ total_balance: targetCash, safe_layer_balance: newSafe, ambition_layer_balance: newAmbition }),
        now
      ),
    ]);

    // 校准按定义把差异全部吸收进资金池现金，持仓构成可能仍与实际不符，需向用户明示
    const diffAbs = Math.abs(rec.variance);
    const warnings: string[] = [
      rec.variance >= 0
        ? `券商总资产高于系统 ${centsToYuan(diffAbs).toFixed(2)} 元，差额已并入资金池现金`
        : `系统总资产高于券商 ${centsToYuan(diffAbs).toFixed(2)} 元，差额已从资金池现金扣除`,
      '若差异实际源于券商侧买卖未被系统记录，请先核对持仓明细，否则校准后资产构成可能与实际不符',
    ];

    return c.json({
      success: true,
      data: {
        portfolio: {
          total_balance: targetCash,
          safe_layer_balance: newSafe,
          ambition_layer_balance: newAmbition,
        },
        holdings_value: holdingsValue,
        system_total: targetCash + holdingsValue,
        warnings,
      },
      message: `已校准：资金池现金调整为 ¥${centsToYuan(targetCash).toFixed(2)}（安全层 ¥${centsToYuan(newSafe).toFixed(2)} / 进取层 ¥${centsToYuan(newAmbition).toFixed(2)}）`,
      timestamp: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { reconciliationRouter };
