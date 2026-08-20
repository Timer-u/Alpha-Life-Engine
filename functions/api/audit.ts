import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';

import { sessionMiddleware } from './auth';

const auditRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

auditRouter.use('*', sessionMiddleware);

// GET /api/audit-logs — 审计日志列表
auditRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const rawLimit = parseInt(c.req.query('limit') ?? '100', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 100;
    const result = await c.env.DB.prepare(
      'SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(userId, limit).all();
    return c.json({ success: true, data: result.results, timestamp: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { auditRouter };
