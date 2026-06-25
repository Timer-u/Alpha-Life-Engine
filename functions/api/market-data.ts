import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';

import { sessionMiddleware } from './auth';

const marketDataRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const TRACKED_SYMBOLS = ['511360', '511880', '000300', '000905', '000922'];

marketDataRouter.use('*', sessionMiddleware);

// GET /api/market-data/history
marketDataRouter.get('/history', async (c) => {
  try {
    const placeholders = TRACKED_SYMBOLS.map(() => '?').join(',');
    const result = await c.env.DB.prepare(
      `SELECT symbol, date, open, high, low, close, volume
       FROM market_data
       WHERE symbol IN (${placeholders})
       ORDER BY symbol, date`
    ).bind(...TRACKED_SYMBOLS).all<{
      symbol: string;
      date: string;
      open: number | null;
      high: number | null;
      low: number | null;
      close: number | null;
      volume: number | null;
    }>();

    return c.json({ success: true, data: result.results });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { marketDataRouter };
