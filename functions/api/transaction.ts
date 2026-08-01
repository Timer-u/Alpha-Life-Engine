import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { sessionMiddleware } from './auth';
import { symbolName } from './symbols';

const transactionRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

function nowIso(): string {
  return new Date().toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const SHARE_EPSILON = 1e-6;

transactionRouter.use('*', sessionMiddleware);

const transactionSchema = z.object({
  symbol: z.string().min(1),
  shares: z.number().positive(),
  price: z.number().positive(),
  commission: z.number().min(0).optional(),
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
// - 买入：校验层级资金池余额充足，扣减现金，加权平均法更新持仓成本
// - 卖出：校验持仓股数充足，净回款（金额 - 佣金）回流层级资金池
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

    const amount = round2(data.shares * data.price);
    const commission = round2(data.commission ?? Math.max(amount * 0.0003, 5));
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
    const statements: D1PreparedStatement[] = [];

    statements.push(
      db.prepare(
        `INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, created_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      ).bind(userId, data.symbol, data.shares, data.price, amount, commission,
        data.transaction_type, data.trigger_signal ?? null, data.layer, now, data.notes ?? null)
    );

    let safeDelta = 0;
    let ambitionDelta = 0;

    if (data.transaction_type === 'buy') {
      const totalCost = round2(amount + commission);
      if (layerBalance + SHARE_EPSILON < totalCost) {
        return c.json({
          success: false,
          error: 'Insufficient funds',
          message: `${layerLabel}资金池余额不足：可用 ¥${layerBalance.toFixed(2)}，本次买入需 ¥${totalCost.toFixed(2)}（含佣金），请先充值资金池`,
        }, 400);
      }

      const newShares = (position?.shares ?? 0) + data.shares;
      const newAvgPrice = position
        ? (position.shares * position.avg_price + amount) / newShares
        : data.price;

      if (position) {
        statements.push(
          db.prepare(
            'UPDATE positions SET shares = ?, avg_price = ?, current_price = ?, market_value = ?, last_price_update = ?, updated_at = ? WHERE id = ?'
          ).bind(newShares, round2(newAvgPrice), data.price, round2(newShares * data.price), now, now, position.id)
        );
      } else {
        statements.push(
          db.prepare(
            `INSERT INTO positions (user_id, symbol, name, shares, avg_price, current_price, market_value, last_price_update, layer, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
          ).bind(userId, data.symbol, symbolName(data.symbol), newShares, round2(newAvgPrice),
            data.price, round2(newShares * data.price), now, data.layer, now, now)
        );
      }

      const delta = -totalCost;
      safeDelta = data.layer === 'safe' ? delta : 0;
      ambitionDelta = data.layer === 'ambition' ? delta : 0;
    } else {
      // 卖出金额需覆盖佣金，否则净回款为负会侵蚀层级资金池
      if (amount + SHARE_EPSILON < commission) {
        return c.json({
          success: false,
          error: 'Invalid input',
          message: `卖出金额 ¥${amount.toFixed(2)} 不足以覆盖佣金 ¥${commission.toFixed(2)}，无法成交`,
        }, 400);
      }

      if (!position || position.shares + SHARE_EPSILON < data.shares) {
        return c.json({
          success: false,
          error: 'Insufficient shares',
          message: `${layerLabel}持仓不足：当前持有 ${data.symbol} ${(position?.shares ?? 0).toFixed(3)} 股，无法卖出 ${data.shares.toFixed(3)} 股`,
        }, 400);
      }

      const newShares = position.shares - data.shares;
      if (newShares <= SHARE_EPSILON) {
        statements.push(db.prepare('DELETE FROM positions WHERE id = ?').bind(position.id));
      } else {
        statements.push(
          db.prepare(
            'UPDATE positions SET shares = ?, current_price = ?, market_value = ?, last_price_update = ?, updated_at = ? WHERE id = ?'
          ).bind(newShares, data.price, round2(newShares * data.price), now, now, position.id)
        );
      }

      const proceeds = round2(amount - commission);
      safeDelta = data.layer === 'safe' ? proceeds : 0;
      ambitionDelta = data.layer === 'ambition' ? proceeds : 0;
    }

    // 买入：资金扣减加条件守卫（AND layer_balance >= cost），并发下余额被抢先消耗时
    // UPDATE 影响行数为 0，batch 后据此补偿回滚并拒绝本次买入
    const layerCol = data.layer === 'safe' ? 'safe_layer_balance' : 'ambition_layer_balance';
    const newTotal = round2(portfolio.total_balance + safeDelta + ambitionDelta);
    const newSafe = round2(portfolio.safe_layer_balance + safeDelta);
    const newAmbition = round2(portfolio.ambition_layer_balance + ambitionDelta);

    if (data.transaction_type === 'buy') {
      statements.push(
        db.prepare(
          `UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, last_balance_update = ?, updated_at = ? WHERE user_id = ? AND ${layerCol} >= ?`
        ).bind(newTotal, newSafe, newAmbition, now, now, userId, round2(amount + commission))
      );
    } else {
      statements.push(
        db.prepare(
          'UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, last_balance_update = ?, updated_at = ? WHERE user_id = ?'
        ).bind(newTotal, newSafe, newAmbition, now, now, userId)
      );
    }

    const results = await db.batch<TransactionRow>(statements);

    // 并发守卫失败：撤销已写入的交易与持仓（资金层未被扣减），拒绝本次买入
    if (data.transaction_type === 'buy' && (results[statements.length - 1]?.meta.changes ?? 0) === 0) {
      const compensation: D1PreparedStatement[] = [];
      const inserted = results[0]?.results[0] as TransactionRow | undefined;
      if (inserted) {
        compensation.push(db.prepare('DELETE FROM transactions WHERE id = ?').bind(inserted.id));
      }
      if (position) {
        compensation.push(
          db.prepare(
            'UPDATE positions SET shares = ?, avg_price = ?, current_price = ?, market_value = ?, last_price_update = ?, updated_at = ? WHERE id = ?'
          ).bind(position.shares, position.avg_price, data.price, round2(position.shares * data.price), now, now, position.id)
        );
      } else {
        const insertedPos = results[1]?.results[0] as { id?: number } | undefined;
        if (insertedPos?.id !== undefined) {
          compensation.push(db.prepare('DELETE FROM positions WHERE id = ?').bind(insertedPos.id));
        }
      }
      if (compensation.length > 0) await db.batch(compensation);

      return c.json({
        success: false,
        error: 'Insufficient funds',
        message: `${layerLabel}资金池余额不足：可用 ¥${layerBalance.toFixed(2)}，本次买入需 ¥${round2(amount + commission).toFixed(2)}（含佣金），请先充值资金池`,
      }, 400);
    }

    const inserted = results[0]?.results[0] ?? null;

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
    const bodyRecord = body as Record<string, unknown>; const amount = typeof body === 'object' && body !== null ? parseFloat(String(bodyRecord.amount ?? '')) : NaN;
    if (isNaN(amount) || amount <= 0) {
      return c.json({ success: false, error: 'Invalid input', message: '金额必须是正数' }, 400);
    }
    const commission = Math.max(amount * 0.0003, 5);
    return c.json({
      success: true,
      data: { amount, commission: Number(commission.toFixed(2)), commission_rate: 0.0003, commission_min: 5 },
      timestamp: nowIso(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { transactionRouter };
