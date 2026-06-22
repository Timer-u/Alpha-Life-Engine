import { Hono } from 'hono';
import { z } from 'zod';
import { triggerEngine } from '../../src/lib/trigger-engine';
import type { Env, Variables } from './[[route]]';
import type { TriggerInput, SignalType } from '../../src/types/api';
import type { MarketPrices } from '../../src/lib/trigger-engine';

const triggerRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================
// 跟踪的 ETF 列表（与 BaoStock 脚本保持一致）
// ============================================================
const TRACKED_SYMBOLS = ['511360', '511880', '510300', '510500', '515080'];

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 从 MarketData 表查询指定 ETF 的最新收盘价
 * 按 symbol + date 取每个 symbol 的最新记录
 */
async function fetchLatestPrices(db: D1Database): Promise<MarketPrices> {
  const prices: MarketPrices = {};

  for (const symbol of TRACKED_SYMBOLS) {
    const result = await db.prepare(
      `SELECT close FROM market_data WHERE symbol = ? ORDER BY date DESC LIMIT 1`
    ).bind(symbol).all<{ close: number }>();

    if (result.results && result.results.length > 0 && result.results[0].close !== null) {
      prices[symbol] = result.results[0].close;
    }
  }

  return prices;
}

// Session middleware
triggerRouter.use('*', async (c, next) => {
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

const triggerSchema = z.object({
  current_balance: z.number().min(0),
  signal_value: z.number().min(0),
  signal_type: z.enum(['BSM', 'DOUBLE', 'NORMAL', 'SKIP']),
});

// POST /api/trigger
triggerRouter.post('/', async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const parsed = triggerSchema.parse(body);

    const input: TriggerInput = {
      user_id: userId,
      current_balance: parsed.current_balance,
      signal_value: parsed.signal_value,
      signal_type: parsed.signal_type as SignalType,
    };

    const validation = triggerEngine.validateTriggerInput(input);
    if (!validation.valid) {
      return c.json({ success: false, error: 'Validation failed', message: validation.errors.join(', ') }, 400);
    }

    // 从 MarketData 表获取实时价格
    const marketPrices = await fetchLatestPrices(c.env.DB);

    const response = triggerEngine.makeTriggerDecision(input, marketPrices);

    await c.env.DB.prepare(
      'INSERT INTO trigger_log (user_id, balance, trigger_decision, signal_value, executed_amount, commission, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, input.current_balance, response.decision, input.signal_value,
      response.executed_amount || 0, response.commission, nowIso()).run();

    return c.json({ success: true, data: response, message: response.message, timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// GET /api/trigger/market-prices
triggerRouter.get('/market-prices', async (c) => {
  try {
    const prices = await fetchLatestPrices(c.env.DB);

    // 附加每个 symbol 的 ETF 名称信息
    const symbolNames: Record<string, string> = {
      '511360': '海富通短融ETF',
      '511880': '银华日利',
      '510300': '沪深300ETF',
      '510500': '中证500ETF',
      '515080': '招商中证红利ETF',
    };

    const data = {
      prices,
      symbols: TRACKED_SYMBOLS.map(symbol => ({
        symbol,
        name: symbolNames[symbol] || symbol,
        price: prices[symbol] ?? null,
        layer: ['511360', '511880'].includes(symbol) ? 'safe' as const : 'ambition' as const,
      })),
      last_update: nowIso(),
    };

    return c.json({ success: true, data, timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { triggerRouter, fetchLatestPrices };
