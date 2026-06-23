import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from './[[route]]';

const transactionRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

function nowIso(): string {
  return new Date().toISOString();
}

// Session middleware (same pattern)
transactionRouter.use('*', async (c, next) => {
  const cookie = c.req.header('cookie') || '';
  const match = cookie.match(/session_token=([^;\s]+)/);
  if (!match) {
    return c.json({ success: false, error: 'Unauthorized', message: '未登录' }, 401);
  }

  const now = nowIso();
  const session = await c.env.DB.prepare(
    'SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ? LIMIT 1'
  ).bind(match[1], now).all<{
    id: number;
    token: string;
    user_id: number;
    created_at: string;
    expires_at: string;
    last_active: string;
    email: string;
    name: string;
  }>();

  if (!session.results || session.results.length === 0) {
    c.header('Set-Cookie', 'session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return c.json({ success: false, error: 'Unauthorized', message: '会话已过期' }, 401);
  }

  const row = session.results[0];
  c.set('userId', row.user_id);
  await next();
});

const transactionSchema = z.object({
  symbol: z.string().min(1),
  shares: z.number().positive(),
  price: z.number().positive(),
  commission: z.number().min(0).optional(),
  transaction_type: z.enum(['buy', 'sell']),
  layer: z.enum(['safe', 'ambition']),
  trigger_signal: z.string().optional(),
  notes: z.string().optional(),
});

// GET /api/transactions
transactionRouter.get('/', async (c) => {
  try {
    const userId = c.get('userId');
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const result = await c.env.DB.prepare(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(userId, limit).all<{
      id: number;
      user_id: number;
      symbol: string;
      shares: number;
      price: number;
      amount: number;
      commission: number;
      transaction_type: 'buy' | 'sell';
      trigger_signal: string | null;
      layer: 'safe' | 'ambition';
      created_at: string;
      notes: string | null;
    }>();

    return c.json({ success: true, data: result.results || [], timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// POST /api/transactions
transactionRouter.post('/', async (c) => {
  try {
    const userId = c.get('userId');
    const data = transactionSchema.parse(await c.req.json());
    const db = c.env.DB;

    const amount = data.shares * data.price;
    const commission = data.commission !== undefined ? data.commission : Math.max(amount * 0.0003, 5);

    const result = await db.prepare(
      `INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, created_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(userId, data.symbol, data.shares, data.price, amount, commission,
      data.transaction_type, data.trigger_signal || null, data.layer, nowIso(), data.notes || null).all<{
        id: number;
        user_id: number;
        symbol: string;
        shares: number;
        price: number;
        amount: number;
        commission: number;
        transaction_type: 'buy' | 'sell';
        trigger_signal: string | null;
        layer: 'safe' | 'ambition';
        created_at: string;
        notes: string | null;
      }>();

    // Update portfolio balance
    const portfolioResult = await db.prepare('SELECT * FROM portfolio WHERE user_id = ?').bind(userId).all<{
      id: number;
      user_id: number;
      total_balance: number;
      safe_layer_balance: number;
      ambition_layer_balance: number;
      last_balance_update: string;
      created_at: string;
      updated_at: string;
    }>();
    if (portfolioResult.results && portfolioResult.results.length > 0) {
      const portfolio = portfolioResult.results[0];
      const totalCost = amount + commission;

      if (data.transaction_type === 'buy') {
        const newTotal = portfolio.total_balance + totalCost;
        const newSafe = data.layer === 'safe'
          ? portfolio.safe_layer_balance + totalCost
          : portfolio.safe_layer_balance;
        const newAmbition = data.layer === 'ambition'
          ? portfolio.ambition_layer_balance + totalCost
          : portfolio.ambition_layer_balance;

        await db.prepare(
          'UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, updated_at = ? WHERE user_id = ?'
        ).bind(newTotal, newSafe, newAmbition, nowIso(), userId).run();
      }
    }

    const inserted = result.results?.[0] || null;
    return c.json({ success: true, data: inserted, message: '交易记录已创建', timestamp: nowIso() }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// POST /api/transactions/calculate-commission
transactionRouter.post('/calculate-commission', async (c) => {
  try {
    const body = await c.req.json();
    const bodyRecord = body as Record<string, unknown>; const amount = typeof body === 'object' && body !== null ? parseFloat(String(bodyRecord.amount ?? '')) : NaN;
    if (isNaN(amount) || amount <= 0) {
      return c.json({ success: false, error: 'Invalid input', message: '金额必须是正数' }, 400);
    }
    const commission = Math.max(amount * 0.0003, 5);
    return c.json({
      success: true,
      data: { amount, commission: Number(commission.toFixed(2)), commission_rate: 0.0003, commission_min: 5 },
      timestamp: nowIso(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { transactionRouter };

