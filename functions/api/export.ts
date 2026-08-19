import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';

import { tradeDateShanghai } from '../../src/lib/money';

import { sessionMiddleware } from './auth';

const exportRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

exportRouter.use('*', sessionMiddleware);

// GET /api/export — 导出当前用户全部账目数据（JSON 附件下载）
exportRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;
    const [portfolio, positions, transactions, reconciliations, dividends, auditLogs] = await Promise.all([
      db.prepare('SELECT * FROM portfolio WHERE user_id = ?').bind(userId).first(),
      db.prepare('SELECT * FROM positions WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at ASC').bind(userId).all(),
      db.prepare('SELECT * FROM reconciliations WHERE user_id = ? ORDER BY reconciliation_date ASC').bind(userId).all(),
      db.prepare('SELECT * FROM dividend_events WHERE user_id = ? ORDER BY ex_date ASC').bind(userId).all(),
      db.prepare('SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at ASC').bind(userId).all(),
    ]);

    const payload = {
      exported_at: new Date().toISOString(),
      portfolio,
      positions: positions.results,
      transactions: transactions.results,
      reconciliations: reconciliations.results,
      dividend_events: dividends.results,
      audit_logs: auditLogs.results,
    };

    return c.body(JSON.stringify({ success: true, data: payload }, null, 2), 200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="alpha-life-export-${tradeDateShanghai()}.json"`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { exportRouter };