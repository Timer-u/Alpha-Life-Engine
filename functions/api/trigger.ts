import type { MarketPrices } from '../../src/lib/trigger-engine';
import type { TriggerInput, SignalType } from '../../src/types/api';
import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { triggerEngine } from '../../src/lib/trigger-engine';

import { sessionMiddleware } from './auth';

const triggerRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const TRACKED_SYMBOLS = ['511360', '511880', '000300', '000905', '000922'];

function nowIso(): string {
  return new Date().toISOString();
}

async function fetchLatestPrices(db: D1Database): Promise<MarketPrices> {
  const prices: MarketPrices = {};

  for (const symbol of TRACKED_SYMBOLS) {
    const result = await db.prepare(
      `SELECT close FROM market_data WHERE symbol = ? ORDER BY date DESC LIMIT 1`
    ).bind(symbol).all<{ close: number | null }>();

    if (result.results.length > 0 && result.results[0].close !== null) {
      prices[symbol] = result.results[0].close;
    }
  }

  return prices;
}

triggerRouter.use('*', sessionMiddleware);

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
      response.executed_amount ?? 0, response.commission, nowIso()).run();

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
      '000300': '沪深300 (指数)',
      '000905': '中证500 (指数)',
      '000922': '中证红利 (指数)',
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

