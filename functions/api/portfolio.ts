import { Hono } from 'hono';
import type { Env, Variables } from './[[route]]';

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

  // 收集所有 symbol
  const symbols = [...new Set(positions.map(p => p.symbol))];

  // 批量查询每个 symbol 的最新收盘价
  const priceMap: Record<string, number> = {};
  for (const symbol of symbols) {
    const result = await db.prepare(
      `SELECT close FROM market_data WHERE symbol = ? AND close IS NOT NULL ORDER BY date DESC LIMIT 1`
    ).bind(symbol).all<{ close: number }>();

    if (result.results && result.results.length > 0) {
      const closePrice = result.results[0].close;
      priceMap[symbol] = closePrice > 0 ? closePrice : result.results[0].close;
    }
  }

  // 更新股票的当前价格和市值
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

// Session middleware
portfolioRouter.use('*', async (c, next) => {
  const cookie = c.req.header('cookie') || '';
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

  if (!session.results || session.results.length === 0) {
    c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return c.json({ success: false, error: 'Unauthorized', message: '会话已过期' }, 401);
  }

  const row = session.results[0];
  c.set('userId', row.user_id);
  await next();
});

// GET /api/portfolio
portfolioRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;

    const portfolioResult = await db.prepare('SELECT * FROM portfolio WHERE user_id = ?').bind(userId).all<{
      id: number;
      user_id: number;
      total_balance: number;
      safe_layer_balance: number;
      ambition_layer_balance: number;
      last_balance_update: string;
      created_at: string;
      updated_at: string;
    }>();
    const portfolio = portfolioResult.results?.[0] || null;

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
    const rawPositions = positionsResult.results || [];

    // 用 MarketData 中的最新价格覆盖 positions 的 current_price
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
    const recentTransactions = txResult.results || [];

    const triggerResult = await db.prepare(
      'SELECT * FROM trigger_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(userId).all<{
      id: number;
      user_id: number;
      balance: number;
      trigger_decision: string;
      signal_value: number;
      executed_amount: number;
      commission: number;
      created_at: string;
    }>();
    const lastTrigger = triggerResult.results?.[0] || null;

    const strategyResult = await db.prepare(
      'SELECT * FROM strategy_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
    ).bind(userId).all<{
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
    const lastStrategy = strategyResult.results?.[0] || null;

    let daysSinceEvolution = 999;
    let pboScore: number | null = null;
    let statusColor: 'green' | 'yellow' | 'red' = 'red';

    if (lastStrategy) {
      const lastEvolution = new Date(lastStrategy.evolution_timestamp);
      daysSinceEvolution = Math.floor((Date.now() - lastEvolution.getTime()) / (1000 * 60 * 60 * 24));
      pboScore = lastStrategy.pbo_score;
    }

    if (daysSinceEvolution <= 7) statusColor = 'green';
    else if (daysSinceEvolution <= 45) statusColor = 'yellow';
    else statusColor = 'red';

    if (pboScore !== null && pboScore > 0.5) statusColor = 'red';

    const balance = portfolio ? portfolio.total_balance : 0;

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
          last_evolution: lastStrategy?.evolution_timestamp || null,
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
      const value = (body as any)[field];
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
