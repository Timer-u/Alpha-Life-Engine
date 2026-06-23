import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRouter } from './auth'
import { portfolioRouter } from './portfolio'
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
    origin: ['http://localhost:3000', 'https://alpha-life.yourdomain.com'],
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  })
)

app.options('*', () => {
  return new Response(null, { status: 204 })
})

app.get('/health', (c) => {
  const env = c.env || {}
  return c.json({
    success: true,
    data: { status: 'ok', env: env.ENVIRONMENT },
    timestamp: new Date().toISOString(),
  })
})

app.route('/auth', authRouter)
app.route('/portfolio', portfolioRouter)
app.route('/transactions', transactionRouter)
app.route('/trigger', triggerRouter)

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
  const env = c.env || {}
  return c.json(
    {
      success: false,
      error: 'Internal Server Error',
      message: env.ENVIRONMENT === 'development' ? err.message : 'Something went wrong',
      timestamp: new Date().toISOString(),
    },
    500
  )
})

export const onRequest = app.fetch
