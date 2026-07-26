import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { sessionMiddleware } from './auth';
import { resolveActiveParams } from './lch-utils';
import { computeLayerPerformance } from './performance';

const portfolioRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

function nowIso(): string {
  return new Date().toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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

  const priceMap: Record<string, number> = {};
  for (const symbol of symbols) {
    const result = await db.prepare(
      `SELECT close FROM market_data WHERE symbol = ? AND close IS NOT NULL ORDER BY date DESC LIMIT 1`
    ).bind(symbol).all<{ close: number }>();

    if (result.results.length > 0) {
      priceMap[symbol] = result.results[0].close;
    }
  }

  const now = nowIso();
  return positions.map(pos => {
    const latestPrice = priceMap[pos.symbol];
    if (latestPrice && latestPrice > 0) {
      return {
        ...pos,
        current_price: latestPrice,
        market_value: pos.shares * latestPrice,
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

    const txResult = await db.prepare(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
    ).bind(userId).all<{
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
      else if (daysSinceEvolution <= 45) statusColor = 'yellow';
      else statusColor = 'red';

      if (pboScore !== null && pboScore > 0.5) statusColor = 'red';
    }

    const balance = portfolio?.total_balance ?? 0;

    return c.json({
      success: true,
      data: {
        portfolio,
        positions,
        recent_transactions: recentTransactions,
        trigger_status: {
          current_balance: balance,
          trigger_line: 1667,
          status: balance < 1667 ? 'accumulating' : 'triggerable',
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
  amount: z.number().positive().max(100_000_000),
});

// POST /api/portfolio/deposit
// 资金池充值 + LCH 自动切分：按当前生效分配比例（演化参数或 LCH 兜底）拆入双层
portfolioRouter.post('/deposit', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;
    const parsed = depositSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: '验证失败', message: '充值金额必须是正数' }, 400);
    }
    const amount = round2(parsed.data.amount);
    const now = nowIso();

    const portfolio = await db.prepare(
      'SELECT total_balance, safe_layer_balance, ambition_layer_balance FROM portfolio WHERE user_id = ?'
    ).bind(userId).first<{
      total_balance: number;
      safe_layer_balance: number;
      ambition_layer_balance: number;
    }>();
    if (!portfolio) {
      return c.json({ success: false, error: 'Not Found', message: '未找到投资组合，请重新登录后重试' }, 400);
    }

    const { allocation } = await resolveActiveParams(db, userId);
    const safeRatio = allocation?.safe_ratio ?? 0.6;
    const safeAdded = round2(amount * safeRatio);
    const ambitionAdded = round2(amount - safeAdded);

    const newTotal = round2(portfolio.total_balance + amount);
    const newSafe = round2(portfolio.safe_layer_balance + safeAdded);
    const newAmbition = round2(portfolio.ambition_layer_balance + ambitionAdded);

    await db.prepare(
      'UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, last_balance_update = ?, updated_at = ? WHERE user_id = ?'
    ).bind(newTotal, newSafe, newAmbition, now, now, userId).run();

    return c.json({
      success: true,
      data: {
        amount,
        safe_added: safeAdded,
        ambition_added: ambitionAdded,
        safe_ratio: safeRatio,
        ambition_ratio: round2(1 - safeRatio),
        allocation_source: allocation?.source ?? 'lch',
        portfolio: {
          total_balance: newTotal,
          safe_layer_balance: newSafe,
          ambition_layer_balance: newAmbition,
        },
      },
      message: `已充值 ¥${amount.toFixed(2)}：安全层 +¥${safeAdded.toFixed(2)} / 进取层 +¥${ambitionAdded.toFixed(2)}`,
      timestamp: now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// PUT /api/portfolio
portfolioRouter.put('/', async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const db = c.env.DB;

    const allowedFields = ['total_balance', 'safe_layer_balance', 'ambition_layer_balance'] as const;
    type AllowedField = typeof allowedFields[number];
    const updates: Partial<Record<AllowedField, number>> = {};

    for (const field of allowedFields) {
      const bodyRecord = body as Record<string, unknown>;
      const value = bodyRecord[field];
      if (value !== undefined && typeof value === 'number') {
        updates[field] = value;
      }
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ success: false, error: 'Invalid input', message: '没有有效的更新字段' }, 400);
    }

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    await db.prepare(
      `UPDATE portfolio SET ${setClause}, updated_at = ? WHERE user_id = ?`
    ).bind(...values, nowIso(), userId).run();

    return c.json({ success: true, data: { message: '投资组合已更新' }, timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { portfolioRouter };

