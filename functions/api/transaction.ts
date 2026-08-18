import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { tradeDateShanghai, yuanToCents } from '../../src/lib/money';
import { TRIGGER_CONSTANTS } from '../../src/types/api';

import { sessionMiddleware } from './auth';
import { symbolName } from './symbols';

const transactionRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

function nowIso(): string {
  return new Date().toISOString();
}

const SHARE_EPSILON = 1e-6;

transactionRouter.use('*', sessionMiddleware);

const transactionSchema = z.object({
  symbol: z.string().min(1),
  shares: z.number().positive(),
  price: z.number().positive(),
  commission: z.number().int().min(0).optional(),
  transaction_type: z.enum(['buy', 'sell']),
  layer: z.enum(['safe', 'ambition']),
  trigger_signal: z.string().optional(),
  notes: z.string().optional(),
});

interface PortfolioRow {
  id: number;
  user_id: number;
  total_balance: number;
  safe_layer_balance: number;
  ambition_layer_balance: number;
}

interface PositionRow {
  id: number;
  shares: number;
  avg_price: number;
}

interface TransactionRow {
  id: number;
  user_id: number;
  symbol: string;
  shares: number;
  price: number;
  amount: number;
  commission: number;
  transaction_type: 'buy' | 'sell';
  trigger_signal: string | null;
  layer: 'safe' | 'ambition';
  realized_pnl: number | null;
  trade_date: string;
  created_at: string;
  notes: string | null;
}

// GET /api/transactions
transactionRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const limit = parseInt(c.req.query('limit') ?? '100', 10);
    const result = await c.env.DB.prepare(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(userId, limit).all<TransactionRow>();

    return c.json({ success: true, data: result.results, timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// POST /api/transactions
// 记录一笔交易并原子化更新持仓与资金池：
// - 买入：校验层级资金池余额充足，扣减现金，加权平均法更新持仓成本（含佣金）
// - 卖出：校验持仓股数充足，净回款（金额 - 佣金）回流层级资金池，记录 realized_pnl
// 所有写入在同一个 batch 内，且每条语句共用同一守卫子查询（并发安全，无需补偿回滚）。
transactionRouter.post('/', async (c) => {
  try {
    const userId = c.get('userId');
    const parsed = transactionSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({
        success: false,
        error: '验证失败',
        message: parsed.error.issues.map((e: { message: string }) => e.message).join(', '),
      }, 400);
    }
    const data = parsed.data;
    const db = c.env.DB;
    const now = nowIso();
    const tradeDate = tradeDateShanghai();

    const amountCents = yuanToCents(data.shares * data.price);
    const commissionCents = data.commission ?? Math.max(Math.round(amountCents * TRIGGER_CONSTANTS.COMMISSION_RATE), TRIGGER_CONSTANTS.COMMISSION_MIN_CENTS);
    const totalCostCents = amountCents + commissionCents;
    const layerLabel = data.layer === 'safe' ? '安全层' : '进取层';

    const portfolio = await db.prepare(
      'SELECT id, user_id, total_balance, safe_layer_balance, ambition_layer_balance FROM portfolio WHERE user_id = ?'
    ).bind(userId).first<PortfolioRow>();
    if (!portfolio) {
      return c.json({ success: false, error: 'Not Found', message: '未找到投资组合，请重新登录后重试' }, 400);
    }

    const position = await db.prepare(
      'SELECT id, shares, avg_price FROM positions WHERE user_id = ? AND symbol = ? AND layer = ?'
    ).bind(userId, data.symbol, data.layer).first<PositionRow>();

    const layerBalance = data.layer === 'safe' ? portfolio.safe_layer_balance : portfolio.ambition_layer_balance;
    const layerCol = data.layer === 'safe' ? 'safe_layer_balance' : 'ambition_layer_balance';
    const statements: D1PreparedStatement[] = [];

    let safeDelta = 0;
    let ambitionDelta = 0;
    let realizedPnlCents: number | null = null;

    if (data.transaction_type === 'buy') {
      if (layerBalance + SHARE_EPSILON < totalCostCents) {
        return c.json({
          success: false,
          error: 'Insufficient funds',
          message: `${layerLabel}资金池余额不足：可用 ¥${(layerBalance / 100).toFixed(2)}，本次买入需 ¥${(totalCostCents / 100).toFixed(2)}（含佣金），请先充值资金池`,
        }, 400);
      }

      const newShares = (position?.shares ?? 0) + data.shares;
      const newAvgPrice = position
        ? (position.shares * position.avg_price + (amountCents + commissionCents) / 100) / newShares
        : ((amountCents + commissionCents) / 100) / data.shares;

      statements.push(
        db.prepare(
          `INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
           WHERE (SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ?
           RETURNING *`
        ).bind(userId, data.symbol, data.shares, data.price, amountCents, commissionCents,
          data.transaction_type, data.trigger_signal ?? null, data.layer, tradeDate, now, data.notes ?? null,
          userId, totalCostCents)
      );

      if (position) {
        statements.push(
          db.prepare(
            `UPDATE positions SET shares = ?, avg_price = ?, current_price = ?, market_value = ?, last_price_update = ?, updated_at = ?
             WHERE id = ? AND (SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ?`
          ).bind(newShares, newAvgPrice, data.price, yuanToCents(newShares * data.price), now, now, position.id, userId, totalCostCents)
        );
      } else {
        statements.push(
          db.prepare(
            `INSERT INTO positions (user_id, symbol, name, shares, avg_price, current_price, market_value, last_price_update, layer, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE (SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ?
             RETURNING id`
          ).bind(userId, data.symbol, symbolName(data.symbol), newShares, newAvgPrice, data.price,
            yuanToCents(newShares * data.price), now, data.layer, now, now, userId, totalCostCents)
        );
      }

      safeDelta = data.layer === 'safe' ? -totalCostCents : 0;
      ambitionDelta = data.layer === 'ambition' ? -totalCostCents : 0;

      statements.push(
        db.prepare(
          `UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, last_balance_update = ?, updated_at = ?
           WHERE user_id = ? AND ${layerCol} >= ?`
        ).bind(portfolio.total_balance + safeDelta + ambitionDelta,
          portfolio.safe_layer_balance + safeDelta,
          portfolio.ambition_layer_balance + ambitionDelta, now, now, userId, totalCostCents)
      );
    } else {
      // 卖出金额需覆盖佣金，否则净回款为负会侵蚀层级资金池
      if (amountCents + SHARE_EPSILON < commissionCents) {
        return c.json({
          success: false,
          error: 'Invalid input',
          message: `卖出金额 ¥${(amountCents / 100).toFixed(2)} 不足以覆盖佣金 ¥${(commissionCents / 100).toFixed(2)}，无法成交`,
        }, 400);
      }

      if (!position || position.shares + SHARE_EPSILON < data.shares) {
        return c.json({
          success: false,
          error: 'Insufficient shares',
          message: `${layerLabel}持仓不足：当前持有 ${data.symbol} ${(position?.shares ?? 0).toFixed(3)} 股，无法卖出 ${data.shares.toFixed(3)} 股`,
        }, 400);
      }

      realizedPnlCents = Math.round((amountCents - commissionCents) - position.avg_price * data.shares * 100);

      statements.push(
        db.prepare(
          `INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT shares FROM positions WHERE id = ?) >= ?
           RETURNING *`
        ).bind(userId, data.symbol, data.shares, data.price, amountCents, commissionCents,
          data.transaction_type, data.trigger_signal ?? null, data.layer, realizedPnlCents, tradeDate, now, data.notes ?? null,
          position.id, data.shares)
      );

      const newShares = position.shares - data.shares;
      if (newShares <= SHARE_EPSILON) {
        statements.push(
          db.prepare(
            'DELETE FROM positions WHERE id = ? AND (SELECT shares FROM positions WHERE id = ?) >= ?'
          ).bind(position.id, position.id, data.shares)
        );
      } else {
        statements.push(
          db.prepare(
            `UPDATE positions SET shares = shares - ?, current_price = ?, market_value = ?, last_price_update = ?, updated_at = ?
             WHERE id = ? AND shares >= ?`
          ).bind(data.shares, data.price, yuanToCents(newShares * data.price), now, now, position.id, data.shares)
        );
      }

      const proceedsCents = amountCents - commissionCents;
      safeDelta = data.layer === 'safe' ? proceedsCents : 0;
      ambitionDelta = data.layer === 'ambition' ? proceedsCents : 0;

      statements.push(
        db.prepare(
          `UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, last_balance_update = ?, updated_at = ?
           WHERE user_id = ? AND (SELECT shares FROM positions WHERE id = ?) >= ?`
        ).bind(portfolio.total_balance + safeDelta + ambitionDelta,
          portfolio.safe_layer_balance + safeDelta,
          portfolio.ambition_layer_balance + ambitionDelta, now, now, userId, position.id, data.shares)
      );
    }

    const results = await db.batch<TransactionRow>(statements);

    // 并发守卫失败：batch 内每条语句共用同一守卫子查询（读取同一快照），
    // 任一守卫不满足则首条 INSERT 无返回行，整体拒绝本次交易（无补偿回滚）。
    const inserted = results[0]?.results[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!inserted) {
      const insufficient = data.transaction_type === 'buy' ? 'Insufficient funds' : 'Insufficient shares';
      const message = data.transaction_type === 'buy'
        ? `${layerLabel}资金池余额不足：可用 ¥${(layerBalance / 100).toFixed(2)}，本次买入需 ¥${(totalCostCents / 100).toFixed(2)}（含佣金），请先充值资金池`
        : `${layerLabel}持仓不足：无法卖出 ${data.shares.toFixed(3)} 股`;
      return c.json({ success: false, error: insufficient, message }, 400);
    }

    return c.json({ success: true, data: inserted, message: '交易记录已创建', timestamp: nowIso() }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// POST /api/transactions/calculate-commission
transactionRouter.post('/calculate-commission', async (c) => {
  try {
    const body = await c.req.json();
    const bodyRecord = body as Record<string, unknown>;
    const amount = typeof body === 'object' && body !== null ? parseFloat(String(bodyRecord.amount ?? '')) : NaN;
    if (isNaN(amount) || amount <= 0) {
      return c.json({ success: false, error: 'Invalid input', message: '金额必须是正数' }, 400);
    }
    const amountCents = yuanToCents(amount);
    const commissionCents = Math.max(Math.round(amountCents * TRIGGER_CONSTANTS.COMMISSION_RATE), TRIGGER_CONSTANTS.COMMISSION_MIN_CENTS);
    return c.json({
      success: true,
      data: {
        amount_cents: amountCents,
        commission_cents: commissionCents,
        commission_rate: TRIGGER_CONSTANTS.COMMISSION_RATE,
        commission_min_cents: TRIGGER_CONSTANTS.COMMISSION_MIN_CENTS,
      },
      timestamp: nowIso(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { transactionRouter };
