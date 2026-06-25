import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { sessionMiddleware } from './auth';

const strategyRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

function nowIso(): string {
  return new Date().toISOString();
}

strategyRouter.use('*', sessionMiddleware);

const reportSchema = z.object({
  report_data: z.string().min(1).max(5242880),
  pbo_score: z.number().nullable(),
  dsr_ranking: z.number().nullable(),
  parameter_count: z.number().int().positive(),
  evolution_timestamp: z.string().datetime(),
  next_scheduled_evolution: z.string().datetime().nullable(),
});

strategyRouter.post('/reports', async (c) => {
  try {
    const userId = c.get('userId');
    const db = c.env.DB;
    const body = await c.req.json();
    const parsed = reportSchema.safeParse(body);

    if (!parsed.success) {
      return c.json({
        success: false,
        error: '验证失败',
        message: parsed.error.issues.map((e: { message: string }) => e.message).join(', '),
      }, 400);
    }

    const data = parsed.data;

    await db.prepare(
      `INSERT OR REPLACE INTO strategy_reports
       (user_id, report_data, pbo_score, dsr_ranking, parameter_count, evolution_timestamp, next_scheduled_evolution)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      userId,
      data.report_data,
      data.pbo_score,
      data.dsr_ranking,
      data.parameter_count,
      data.evolution_timestamp,
      data.next_scheduled_evolution,
    ).run();

    return c.json({
      success: true,
      data: { message: '策略报告已保存' },
      timestamp: nowIso(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { strategyRouter };
