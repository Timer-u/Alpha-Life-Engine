import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRouter } from './functions/api/auth'
import { marketDataRouter } from './functions/api/market-data'
import { runScheduledNotifications } from './functions/api/notifications'
import { portfolioRouter } from './functions/api/portfolio'
import { reconciliationRouter } from './functions/api/reconciliation'
import { strategyRouter } from './functions/api/strategy'
import { transactionRouter } from './functions/api/transaction'
import { triggerRouter } from './functions/api/trigger'

const app = new Hono()

app.use('*', cors({
  origin: ['http://localhost:3000', 'https://alpha-life.yourdomain.com'],
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
}))

app.options('*', (c) => new Response(null, { status: 204 }))

app.get('/health', (c) => {
  return c.json({
    success: true,
    data: { status: 'ok', env: c.env.ENVIRONMENT },
    timestamp: new Date().toISOString(),
  })
})

app.route('/api/auth', authRouter)
app.route('/api/portfolio', portfolioRouter)
app.route('/api/transactions', transactionRouter)
app.route('/api/trigger', triggerRouter)
app.route('/api/strategy', strategyRouter)
app.route('/api/market-data', marketDataRouter)
app.route('/api/reconciliation', reconciliationRouter)

app.notFound((c) => c.json({ success: false, error: 'Not Found' }, 404))

app.onError((err, c) => {
  console.error('API Error:', err)
  return c.json({
    success: false,
    error: 'Internal Server Error',
    message: c.env.ENVIRONMENT === 'development' ? err.message : 'Something went wrong',
  }, 500)
})

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduledNotifications(env))
  },
}
