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

// 批内「本批次插入」判别子：批内语句顺序执行（后见先写），锚点 INSERT
// （transactions）最先执行后，随后的持仓/资金变更以此判定是否属于本批次。
// 仅当 user+idempotency_key 对应的行由本批次写入（request_nonce = 本次请求
// 生成的 UUID）时为 1；重试/并发重复时锚点被幂等守卫拦截，本判别子为 0 →
// 整批无操作。request_nonce 每请求唯一，即使重试发生在同一毫秒也不会误判
// （created_at 只到毫秒，无法区分同毫秒的并发重复请求）。
const BATCH_TXN_GUARD = `(SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ? AND request_nonce = ?) = 1`;

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
  idempotency_key: z.string().min(8).max(64),
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
    const rawLimit = parseInt(c.req.query('limit') ?? '100', 10);
    const rawOffset = parseInt(c.req.query('offset') ?? '0', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 100;
    const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

    const [totalResult, result] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) AS total FROM transactions WHERE user_id = ?').bind(userId).first<{ total: number }>(),
      c.env.DB.prepare(
        'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).bind(userId, limit, offset).all<TransactionRow>(),
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
    const requestNonce = crypto.randomUUID();
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

    const existing = await db.prepare(
      'SELECT * FROM transactions WHERE user_id = ? AND idempotency_key = ?'
    ).bind(userId, data.idempotency_key).first<TransactionRow>();
    if (existing) {
      return c.json({
        success: true,
        data: existing,
        duplicate: true,
        message: '该笔交易已记录（重复请求已忽略）',
        timestamp: now,
      });
    }

    const layerBalance = data.layer === 'safe' ? portfolio.safe_layer_balance : portfolio.ambition_layer_balance;
    const layerCol = data.layer === 'safe' ? 'safe_layer_balance' : 'ambition_layer_balance';
    const statements: D1PreparedStatement[] = [];

    let safeDelta = 0;
    let ambitionDelta = 0;
    let realizedPnlCents: number | null = null;
    let auditGuard: string;
    let auditGuardBinds: unknown[];
    let txnInsertIndex = 0;

    if (data.transaction_type === 'buy') {
      if (layerBalance + SHARE_EPSILON < totalCostCents) {
        return c.json({
          success: false,
          error: 'Insufficient funds',
          message: `${layerLabel}资金池余额不足：可用 ¥${(layerBalance / 100).toFixed(2)}，本次买入需 ¥${(totalCostCents / 100).toFixed(2)}（含佣金），请先充值资金池`,
        }, 400);
      }

      auditGuard = `(SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ?`;
      auditGuardBinds = [userId, totalCostCents];

      statements.push(db.prepare(
        `INSERT INTO audit_logs (user_id, action, entity, old_value, new_value, created_at)
         SELECT ?, 'transaction', 'transactions', NULL, ?, ?
         WHERE ${auditGuard}
           AND (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0`
      ).bind(userId, JSON.stringify({
        symbol: data.symbol, shares: data.shares, price: data.price, amount: amountCents,
        commission: commissionCents, transaction_type: data.transaction_type, layer: data.layer,
        realized_pnl: realizedPnlCents, trade_date: tradeDate, idempotency_key: data.idempotency_key,
      }), now, ...auditGuardBinds, userId, data.idempotency_key));

      // 锚点 INSERT：余额守卫在批时求值，幂等守卫在自身插入前求值（COUNT=0）。
      // 随后的持仓/资金变更用 BATCH_TXN_GUARD 判别子（request_nonce = 本次请求
      // 的 UUID），只有本批次刚写入的 txn 行才满足 —— 重试/并发重复时锚点被
      // 幂等守卫拦截，判别子为 0，整批无操作。
      txnInsertIndex = statements.length;
      statements.push(
        db.prepare(
          `INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes, idempotency_key, request_nonce)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?
           WHERE (SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ?
             AND (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0
           RETURNING *`
        ).bind(userId, data.symbol, data.shares, data.price, amountCents, commissionCents,
          data.transaction_type, data.trigger_signal ?? null, data.layer, tradeDate, now, data.notes ?? null,
          data.idempotency_key, requestNonce, userId, totalCostCents, userId, data.idempotency_key)
      );

      const notionalYuan = (amountCents + commissionCents) / 100;

      // 持仓用相对增量写法（SQLite UPDATE 的 SET 表达式全部读到旧行值），
      // 不同幂等键的并发交易串行提交时不会用批前快照覆写彼此的写入。
      // WHERE 匹配自然键（user+symbol+layer）而非快照 id。
      statements.push(
        db.prepare(
          `UPDATE positions SET
             shares = shares + ?,
             avg_price = (shares * avg_price + ?) / (shares + ?),
             current_price = ?,
             market_value = CAST(ROUND((shares + ?) * ? * 100) AS INTEGER),
             last_price_update = ?, updated_at = ?
           WHERE user_id = ? AND symbol = ? AND layer = ?
             AND (SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ?
             AND ${BATCH_TXN_GUARD}`
        ).bind(data.shares, notionalYuan, data.shares, data.price, data.shares, data.price,
          now, now, userId, data.symbol, data.layer, userId, totalCostCents, userId, data.idempotency_key, requestNonce)
      );
      // 批前无持仓、或并发全仓卖出已 DELETE 持仓行时上面的 UPDATE 匹配
      // 0 行（交易与扣款仍会落库），此处按自然键条件补建，避免持仓凭空
      // 消失/重复建行。行存在时 NOT EXISTS 为假，整条无操作。
      statements.push(
        db.prepare(
          `INSERT INTO positions (user_id, symbol, name, shares, avg_price, current_price, market_value, last_price_update, layer, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM positions WHERE user_id = ? AND symbol = ? AND layer = ?)
             AND (SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ?
             AND ${BATCH_TXN_GUARD}
           RETURNING id`
        ).bind(userId, data.symbol, symbolName(data.symbol), data.shares, notionalYuan / data.shares,
          data.price, amountCents, now, data.layer, now, now, userId, data.symbol, data.layer,
          userId, totalCostCents, userId, data.idempotency_key, requestNonce)
      );

      safeDelta = data.layer === 'safe' ? -totalCostCents : 0;
      ambitionDelta = data.layer === 'ambition' ? -totalCostCents : 0;

      // 相对增量：余额守卫保留在 WHERE（批时求值），并发下不会覆写他人扣款
      statements.push(
        db.prepare(
          `UPDATE portfolio SET total_balance = total_balance + ?, safe_layer_balance = safe_layer_balance + ?, ambition_layer_balance = ambition_layer_balance + ?, last_balance_update = ?, updated_at = ?
           WHERE user_id = ? AND ${layerCol} >= ?
             AND ${BATCH_TXN_GUARD}`
        ).bind(safeDelta + ambitionDelta, safeDelta, ambitionDelta,
          now, now, userId, totalCostCents, userId, data.idempotency_key, requestNonce)
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

      auditGuard = `(SELECT shares FROM positions WHERE id = ?) >= ?`;
      auditGuardBinds = [position.id, data.shares];

      realizedPnlCents = Math.round((amountCents - commissionCents) - position.avg_price * data.shares * 100);

      statements.push(db.prepare(
        `INSERT INTO audit_logs (user_id, action, entity, old_value, new_value, created_at)
         SELECT ?, 'transaction', 'transactions', NULL, ?, ?
         WHERE ${auditGuard}
           AND (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0`
      ).bind(userId, JSON.stringify({
        symbol: data.symbol, shares: data.shares, price: data.price, amount: amountCents,
        commission: commissionCents, transaction_type: data.transaction_type, layer: data.layer,
        realized_pnl: realizedPnlCents, trade_date: tradeDate, idempotency_key: data.idempotency_key,
      }), now, ...auditGuardBinds, userId, data.idempotency_key));

      // 锚点 INSERT 最先执行：持仓守卫在批前求值（看到减仓前的持仓量），
      // 幂等守卫在自身插入前求值（COUNT=0）。随后持仓/资金变更用
      // BATCH_TXN_GUARD 判别子（request_nonce），重试/并发重复时整批无操作。
      txnInsertIndex = statements.length;
      statements.push(
        db.prepare(
          `INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes, idempotency_key, request_nonce)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT shares FROM positions WHERE id = ?) >= ?
             AND (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0
           RETURNING *`
        ).bind(userId, data.symbol, data.shares, data.price, amountCents, commissionCents,
          data.transaction_type, data.trigger_signal ?? null, data.layer, realizedPnlCents, tradeDate, now, data.notes ?? null,
          data.idempotency_key, requestNonce, position.id, data.shares, userId, data.idempotency_key)
      );

      const newShares = position.shares - data.shares;
      if (newShares <= SHARE_EPSILON) {
        statements.push(
          db.prepare(
            `DELETE FROM positions WHERE id = ? AND (SELECT shares FROM positions WHERE id = ?) >= ?
               AND ${BATCH_TXN_GUARD}`
          ).bind(position.id, position.id, data.shares, userId, data.idempotency_key, requestNonce)
        );
      } else {
        // market_value 同样用旧行值相对计算，与 shares = shares - ? 保持一致
        statements.push(
          db.prepare(
            `UPDATE positions SET shares = shares - ?, current_price = ?, market_value = CAST(ROUND((shares - ?) * ? * 100) AS INTEGER), last_price_update = ?, updated_at = ?
             WHERE id = ? AND shares >= ?
               AND ${BATCH_TXN_GUARD}`
          ).bind(data.shares, data.price, data.shares, data.price, now, now, position.id, data.shares, userId, data.idempotency_key, requestNonce)
        );
      }

      const proceedsCents = amountCents - commissionCents;
      safeDelta = data.layer === 'safe' ? proceedsCents : 0;
      ambitionDelta = data.layer === 'ambition' ? proceedsCents : 0;

      // 全仓与部分卖出统一相对增量：股数充足性已由锚点 INSERT 的批前守卫
      // 保证（否则 BATCH_TXN_GUARD 为 0 整批无操作），此处无需再引用 positions。
      statements.push(
        db.prepare(
          `UPDATE portfolio SET total_balance = total_balance + ?, safe_layer_balance = safe_layer_balance + ?, ambition_layer_balance = ambition_layer_balance + ?, last_balance_update = ?, updated_at = ?
           WHERE user_id = ?
             AND ${BATCH_TXN_GUARD}`
        ).bind(safeDelta + ambitionDelta, safeDelta, ambitionDelta,
          now, now, userId, userId, data.idempotency_key, requestNonce)
      );
    }

    const results = await db.batch<TransactionRow>(statements);

    // 锚点 INSERT（txnInsertIndex）失败即本次交易未写入：重试/并发重复被幂等
    // 守卫拦截（无返回行），随后的持仓/资金变更因 BATCH_TXN_GUARD 判别子同样
    // 整体无操作；余额/持仓不足则在批前守卫即失败。此处回查是否存在已提交的同键
    // 交易以返回 duplicate 而非报错（无补偿回滚）。
    const inserted = results[txnInsertIndex]?.results[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!inserted) {
      const raced = await db.prepare(
        'SELECT * FROM transactions WHERE user_id = ? AND idempotency_key = ?'
      ).bind(userId, data.idempotency_key).first<TransactionRow>();
      if (raced) {
        return c.json({ success: true, data: raced, duplicate: true, message: '该笔交易已记录（重复请求已忽略）', timestamp: nowIso() });
      }
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
