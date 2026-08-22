import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';

import { tradeDateShanghai } from '../../src/lib/money';

import { sessionMiddleware } from './auth';

const exportRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

exportRouter.use('*', sessionMiddleware);

// GET /api/export — 导出当前用户全部账目数据（JSON 附件下载）
// audit_logs 只增不清理，默认截取最近 1000 条；?audit_limit=N（1..50000）或
// ?audit_since=ISO 可显式放宽/收窄，其余表为用户主动数据、量级可控
exportRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;
    const rawLimit = parseInt(c.req.query('audit_limit') ?? '1000', 10);
    const auditLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50000) : 1000;
    const auditSince = c.req.query('audit_since');

    const auditCondition = auditSince ? 'WHERE user_id = ? AND created_at >= ?' : 'WHERE user_id = ?';
    const auditBinds = auditSince ? [userId, auditSince] : [userId];
    // TODO: future work — streaming/paginated export for large accounts (Worker 128MB memory limit).
    const [portfolio, positions, transactions, reconciliations, dividends, auditLogs] = await Promise.all([
      db.prepare('SELECT * FROM portfolio WHERE user_id = ?').bind(userId).first(),
      db.prepare('SELECT * FROM positions WHERE user_id = ?').bind(userId).all(),
      db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at ASC').bind(userId).all(),
      db.prepare('SELECT * FROM reconciliations WHERE user_id = ? ORDER BY reconciliation_date ASC').bind(userId).all(),
      db.prepare('SELECT * FROM dividend_events WHERE user_id = ? ORDER BY ex_date ASC').bind(userId).all(),
      db.prepare(
        `SELECT * FROM audit_logs ${auditCondition} ORDER BY created_at ASC LIMIT ?`
      ).bind(...auditBinds, auditLimit).all(),
    ]);

    const payload = {
      exported_at: new Date().toISOString(),
      portfolio,
      positions: positions.results,
      transactions: transactions.results,
      reconciliations: reconciliations.results,
      dividend_events: dividends.results,
      audit_logs: auditLogs.results,
      audit_logs_truncated: auditLogs.results.length >= auditLimit,
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
