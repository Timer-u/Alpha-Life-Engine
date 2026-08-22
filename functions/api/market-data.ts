import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';

import { sessionMiddleware } from './auth';
import { TRACKED_SYMBOLS } from './symbols';

const marketDataRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

marketDataRouter.use('*', sessionMiddleware);

// GET /api/market-data/history
// 可选查询参数：start/end（YYYY-MM-DD 日期闭区间）。默认返回全部历史
// （本地演化器依赖全量），带范围时可避免无界全表传输。
marketDataRouter.get('/history', async (c) => {
  try {
    const start = c.req.query('start');
    const end = c.req.query('end');
    if ((start !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(start)) ||
        (end !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(end))) {
      return c.json({ success: false, error: '验证失败', message: 'start/end 必须是 YYYY-MM-DD' }, 400);
    }

    const placeholders = TRACKED_SYMBOLS.map(() => '?').join(',');
    const conditions = [`symbol IN (${placeholders})`];
    const binds: string[] = [...TRACKED_SYMBOLS];
    if (start !== undefined) {
      conditions.push('date >= ?');
      binds.push(start);
    }
    if (end !== undefined) {
      conditions.push('date <= ?');
      binds.push(end);
    }

    const result = await c.env.DB.prepare(
      `SELECT symbol, date, open, high, low, close, volume
       FROM market_data
       WHERE ${conditions.join(' AND ')}
       ORDER BY symbol, date`
    ).bind(...binds).all<{
      symbol: string;
      date: string;
      open: number | null;
      high: number | null;
      low: number | null;
      close: number | null;
      volume: number | null;
    }>();

    return c.json({ success: true, data: result.results, count: result.results.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { marketDataRouter };
