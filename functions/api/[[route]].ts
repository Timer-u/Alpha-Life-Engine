import type { Context } from 'hono'

import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { auditRouter } from './audit'
import { authRouter } from './auth'
import { dividendsRouter } from './dividends'
import { exportRouter } from './export'
import { marketDataRouter } from './market-data'
import { runScheduledMarketUpdate } from './market-update'
import { runScheduledNotifications } from './notifications'
import { portfolioRouter } from './portfolio'
import { reconciliationRouter } from './reconciliation'
import { strategyRouter } from './strategy'
import { transactionRouter } from './transaction'
import { triggerRouter } from './trigger'

export interface Env {
  DB: D1Database
  RESEND_API_KEY: string
  ENVIRONMENT: string
  SESSION_DAYS: string
}

export type Variables = {
  userId: number
}

const healthHandler = (c: Context<{ Bindings: Env }>) => {
  return c.json({
    success: true,
    data: { status: 'ok', env: c.env.ENVIRONMENT },
    timestamp: new Date().toISOString(),
  })
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>({
  getPath: (req) => {
    try {
      const url = new URL(req.url)
      return url.pathname
    } catch {
      return req.url || '/'
    }
  },
})

app.use(
  '*',
  cors({
    // 生产域名通过环境变量 CORS_ORIGIN 配置（逗号分隔）；
    // 未配置时仅允许本地开发源，不再携带占位域名
    origin: (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',').map(o => o.trim()),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  })
)

app.options('*', () => {
  return new Response(null, { status: 204 })
})

app.get('/health', healthHandler)
app.get('/api/health', healthHandler)

app.route('/api/auth', authRouter)
app.route('/api/audit-logs', auditRouter)
app.route('/api/dividends', dividendsRouter)
app.route('/api/export', exportRouter)
app.route('/api/portfolio', portfolioRouter)
app.route('/api/transactions', transactionRouter)
app.route('/api/trigger', triggerRouter)
app.route('/api/strategy', strategyRouter)
app.route('/api/market-data', marketDataRouter)
app.route('/api/reconciliation', reconciliationRouter)

app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: 'Not Found',
      message: `Endpoint ${c.req.path} not found`,
      timestamp: new Date().toISOString(),
    },
    404
  )
})

app.onError((err, c) => {
  console.error('API Error:', err)
  return c.json(
    {
      success: false,
      error: 'Internal Server Error',
      message: c.env.ENVIRONMENT === 'development' ? err.message : 'Something went wrong',
      timestamp: new Date().toISOString(),
    },
    500
  )
})

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.allSettled([
        runScheduledNotifications(env),
        // sessions/otps 只增不清理：每日 cron 顺带删除已过期行
        env.DB.batch([
          env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(new Date().toISOString()),
          env.DB.prepare('DELETE FROM otps WHERE expires_at <= ?').bind(new Date().toISOString()),
        ]).catch(err => { console.error('[scheduled] session/otp cleanup failed:', err); }),
        runScheduledMarketUpdate(env).then(result => {
          if (result.skipped) {
            console.warn(`[scheduled] market update skipped: ${result.reason ?? ''}`)
          } else {
            console.warn(`[scheduled] market update ok: ${result.updatedSymbols.length} symbols, ${result.insertedRows} rows`)
          }
        }),
      ]).then(results => {
        for (const r of results) {
          if (r.status === 'rejected') console.error('[scheduled] task failed:', r.reason)
        }
      })
    )
  },
}