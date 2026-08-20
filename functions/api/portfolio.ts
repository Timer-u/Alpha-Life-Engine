import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { centsToYuan, splitDepositCents, yuanToCents } from '../../src/lib/money';
import { isEvolvedParams, TRIGGER_CONSTANTS } from '../../src/types/api';

import { sessionMiddleware } from './auth';
import { resolveActiveParams, STALE_DAYS } from './lch-utils';
import { computeLayerPerformance } from './performance';

const portfolioRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 查询 MarketData 表获取最新价格，覆盖 positions 中的 current_price
 */
async function enrichPositionsWithMarketPrices(
  db: D1Database,
  positions: Array<{
    id: number;
    symbol: string;
    shares: number;
    avg_price: number;
    current_price: number;
    market_value: number;
    last_price_update: string;
    [key: string]: unknown;
  }>
): Promise<Array<{
  id: number;
  symbol: string;
  shares: number;
  avg_price: number;
  current_price: number;
  market_value: number;
  last_price_update: string;
  [key: string]: unknown;
}>> {
  if (positions.length === 0) return [];

  const symbols = [...new Set(positions.map(p => p.symbol))];
  const placeholders = symbols.map(() => '?').join(',');

  const priceRows = await db.prepare(
    `SELECT m.symbol, m.close FROM market_data m
     JOIN (SELECT symbol, MAX(date) AS max_date FROM market_data
           WHERE symbol IN (${placeholders}) AND close IS NOT NULL GROUP BY symbol) latest
     ON m.symbol = latest.symbol AND m.date = latest.max_date`
  ).bind(...symbols).all<{ symbol: string; close: number }>();
  const priceMap = new Map(priceRows.results.map(row => [row.symbol, row.close]));

  const now = nowIso();
  return positions.map(pos => {
    const latestPrice = priceMap.get(pos.symbol);
    if (latestPrice && latestPrice > 0) {
      return {
        ...pos,
        current_price: latestPrice,
        market_value: Math.round(pos.shares * latestPrice * 100),
        last_price_update: now,
      };
    }
    return pos;
  });
}

// Reusable session middleware
portfolioRouter.use('*', sessionMiddleware);

// GET /api/portfolio
portfolioRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;

    const portfolio = await db.prepare('SELECT * FROM portfolio WHERE user_id = ?').bind(userId).first<{
      id: number;
      user_id: number;
      total_balance: number;
      safe_layer_balance: number;
      ambition_layer_balance: number;
      last_balance_update: string;
      created_at: string;
      updated_at: string;
    }>();

    const positionsResult = await db.prepare('SELECT * FROM positions WHERE user_id = ? ORDER BY created_at DESC').bind(userId).all<{
      id: number;
      user_id: number;
      symbol: string;
      name: string;
      shares: number;
      avg_price: number;
      current_price: number;
      market_value: number;
      last_price_update: string;
      layer: 'safe' | 'ambition';
      created_at: string;
      updated_at: string;
    }>();
    const rawPositions = positionsResult.results;

    const positions = await enrichPositionsWithMarketPrices(db, rawPositions);

    const recentLimitRaw = parseInt(c.req.query('recent_limit') ?? '10', 10);
    const recentOffsetRaw = parseInt(c.req.query('recent_offset') ?? '0', 10);
    const recentLimit = Number.isFinite(recentLimitRaw) ? Math.min(Math.max(recentLimitRaw, 1), 50) : 10;
    const recentOffset = Number.isFinite(recentOffsetRaw) ? Math.max(recentOffsetRaw, 0) : 0;

    const txResult = await db.prepare(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(userId, recentLimit, recentOffset).all<{
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
    }>();
    const recentTransactions = txResult.results;

    const lastTrigger = await db.prepare(
      'SELECT * FROM trigger_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(userId).first<{
      id: number;
      user_id: number;
      balance: number;
      trigger_decision: string;
      signal_value: number;
      executed_amount: number;
      commission: number;
      created_at: string;
    }>();

    const lastStrategy = await db.prepare(
      'SELECT * FROM strategy_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(userId).first<{
      id: number;
      user_id: number;
      report_data: string;
      pbo_score: number | null;
      dsr_ranking: number | null;
      parameter_count: number;
      evolution_timestamp: string;
      next_scheduled_evolution: string | null;
      created_at: string;
    }>();

    let daysSinceEvolution = 999;
    let pboScore: number | null = null;
    let statusColor: 'green' | 'yellow' | 'red' = 'red';

    if (lastStrategy) {
      const lastEvolution = new Date(lastStrategy.evolution_timestamp);
      daysSinceEvolution = Math.floor((Date.now() - lastEvolution.getTime()) / (1000 * 60 * 60 * 24));
      pboScore = lastStrategy.pbo_score;

      if (daysSinceEvolution <= 7) statusColor = 'green';
      else if (daysSinceEvolution <= STALE_DAYS) statusColor = 'yellow';
      else statusColor = 'red';

      if (pboScore !== null && pboScore > 0.5) statusColor = 'red';
    }

    const balance = portfolio?.total_balance ?? 0;

    // 触发线跟随演化参数（与 trigger-engine 决策路径一致），无有效演化参数时回退默认 1667
    // 演化参数为元，转为分；回退值 TRIGGER_CONSTANTS.LINE 本身即分
    const { allocation } = await resolveActiveParams(db, userId);
    const triggerLineCents = allocation && isEvolvedParams(allocation)
      ? yuanToCents(allocation.trigger_line ?? TRIGGER_CONSTANTS.TRIGGER_LINE_DEFAULT_YUAN)
      : TRIGGER_CONSTANTS.LINE;

    return c.json({
      success: true,
      data: {
        portfolio,
        positions,
        recent_transactions: recentTransactions,
        trigger_status: {
          current_balance: balance,
          trigger_line: triggerLineCents,
          status: balance < triggerLineCents ? 'accumulating' : 'triggerable',
          last_decision: lastTrigger?.trigger_decision,
          last_decision_time: lastTrigger?.created_at,
        },
        strategy_evolution: {
          last_evolution: lastStrategy?.evolution_timestamp ?? null,
          days_since_evolution: daysSinceEvolution,
          pbo_score: pboScore,
          status_color: statusColor,
        },
      },
      timestamp: nowIso(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// GET /api/portfolio/layer-performance
// 双层账户累计收益序列（按日重放交易流水 + 收盘价估值）
portfolioRouter.get('/layer-performance', async (c) => {
  try {
    const userId = c.get('userId');
    const data = await computeLayerPerformance(c.env.DB, userId);
    return c.json({ success: true, data, timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

const depositSchema = z.object({
  amount_cents: z.number().int().positive().max(10_000_000_000),
  idempotency_key: z.string().min(8).max(64),
});

// POST /api/portfolio/deposit
// 资金池充值 + LCH 自动切分：按当前生效分配比例（演化参数或 LCH 兜底）拆入双层
// 原子幂等：batch 内 UPDATE 以 deposits 账本为守卫，重复 idempotency_key 不重复入账
portfolioRouter.post('/deposit', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;
    const parsed = depositSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: '验证失败', message: '充值金额必须为正整数（分）且需提供幂等键' }, 400);
    }
    const amount_cents = parsed.data.amount_cents;
    const idempotency_key = parsed.data.idempotency_key;
    const now = nowIso();

    const { allocation } = await resolveActiveParams(db, userId);
    const safeRatio = allocation?.safe_ratio ?? 0.6;
    const { safeAddedCents, ambitionAddedCents } = splitDepositCents(amount_cents, safeRatio);

    const statements: D1PreparedStatement[] = [];
    statements.push(db.prepare(
      `INSERT INTO audit_logs (user_id, action, entity, old_value, new_value, created_at)
       SELECT ?, 'deposit', 'portfolio', NULL, ?, ?
       WHERE (SELECT COUNT(*) FROM deposits WHERE user_id = ? AND idempotency_key = ?) = 0`
    ).bind(userId, JSON.stringify({ amount_cents, idempotency_key, safe_added_cents: safeAddedCents, ambition_added_cents: ambitionAddedCents }), now, userId, idempotency_key));
    // index of the portfolio UPDATE in the batch, captured at build time so
    // reordering the statements can never silently break the success read
    const updatePortfolioIndex = statements.length;
    statements.push(db.prepare(
      `UPDATE portfolio
       SET total_balance = total_balance + ?, safe_layer_balance = safe_layer_balance + ?,
           ambition_layer_balance = ambition_layer_balance + ?, last_balance_update = ?, updated_at = ?
       WHERE user_id = ?
         AND (SELECT COUNT(*) FROM deposits WHERE user_id = ? AND idempotency_key = ?) = 0
       RETURNING total_balance, safe_layer_balance, ambition_layer_balance`
    ).bind(amount_cents, safeAddedCents, ambitionAddedCents, now, now, userId, userId, idempotency_key));
    statements.push(db.prepare(
      `INSERT INTO deposits (user_id, amount_cents, idempotency_key, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, idempotency_key) DO NOTHING RETURNING *`
    ).bind(userId, amount_cents, idempotency_key, now));

    const results = await db.batch(statements);

    const updated = results[updatePortfolioIndex]?.results[0] as { total_balance: number; safe_layer_balance: number; ambition_layer_balance: number } | undefined;
    if (!updated) {
      const existing = await db.prepare('SELECT amount_cents FROM deposits WHERE user_id = ? AND idempotency_key = ?')
        .bind(userId, idempotency_key).first<{ amount_cents: number }>();
      return c.json({
        success: true,
        data: { duplicate: true, amount_cents, safe_added_cents: 0, ambition_added_cents: 0, safe_ratio: safeRatio, ambition_ratio: 1 - safeRatio, allocation_source: allocation?.source ?? 'lch', portfolio: {} },
        message: `该笔充值已入账（重复请求已忽略）${existing ? `：¥${centsToYuan(existing.amount_cents).toFixed(2)}` : ''}`,
        timestamp: now,
      });
    }

    return c.json({
      success: true,
      data: {
        duplicate: false,
        amount_cents,
        safe_added_cents: safeAddedCents,
        ambition_added_cents: ambitionAddedCents,
        safe_ratio: safeRatio,
        ambition_ratio: 1 - safeRatio,
        allocation_source: allocation?.source ?? 'lch',
        portfolio: {
          total_balance: updated.total_balance,
          safe_layer_balance: updated.safe_layer_balance,
          ambition_layer_balance: updated.ambition_layer_balance,
        },
      },
      message: `已充值 ¥${centsToYuan(amount_cents).toFixed(2)}：安全层 +¥${centsToYuan(safeAddedCents).toFixed(2)} / 进取层 +¥${centsToYuan(ambitionAddedCents).toFixed(2)}`,
      timestamp: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { portfolioRouter };
