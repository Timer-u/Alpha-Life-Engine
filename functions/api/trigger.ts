import type { MarketPrices } from '../../src/lib/trigger-engine';
import type { TriggerInput, SignalType } from '../../src/types/api';
import type { Env, Variables } from './[[route]]';

import { Hono } from 'hono';
import { z } from 'zod';

import { triggerEngine } from '../../src/lib/trigger-engine';

import { sessionMiddleware } from './auth';
import { executionSuggestionEmailHtml, logNotification, sendEmail, wasRecentlyNotified } from './email';
import { resolveActiveParams } from './lch-utils';
import { SAFE_SYMBOLS, symbolName, TRACKED_SYMBOLS } from './symbols';

const triggerRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// 同一执行建议邮件的最短间隔（天），防止重复手动触发时重复轰炸
const EXECUTION_EMAIL_DEDUPE_DAYS = 1;

function nowIso(): string {
  return new Date().toISOString();
}

async function fetchLatestPrices(db: D1Database): Promise<MarketPrices> {
  const prices: MarketPrices = {};

  for (const symbol of TRACKED_SYMBOLS) {
    const result = await db.prepare(
      `SELECT close FROM market_data WHERE symbol = ? ORDER BY date DESC LIMIT 1`
    ).bind(symbol).all<{ close: number | null }>();

    if (result.results.length > 0 && result.results[0].close !== null) {
      prices[symbol] = result.results[0].close;
    }
  }

  return prices;
}

triggerRouter.use('*', sessionMiddleware);

const triggerSchema = z.object({
  signal_value: z.number().min(0),
  signal_type: z.enum(['BSM', 'DOUBLE', 'NORMAL', 'SKIP']),
});

// POST /api/trigger
triggerRouter.post('/', async (c) => {
  try {
    const userId = c.get('userId');
    const body = await c.req.json();
    const parsed = triggerSchema.parse(body);

    const portfolio = await c.env.DB.prepare('SELECT total_balance FROM portfolio WHERE user_id = ?').bind(userId).first<{ total_balance: number }>();
    if (!portfolio) return c.json({ success: false, error: 'Not Found', message: '未找到投资组合' }, 400);

    const input: TriggerInput = {
      user_id: userId,
      current_balance: portfolio.total_balance,
      signal_value: parsed.signal_value,
      signal_type: parsed.signal_type as SignalType,
    };

    const validation = triggerEngine.validateTriggerInput(input);
    if (!validation.valid) {
      return c.json({ success: false, error: 'Validation failed', message: validation.errors.join(', ') }, 400);
    }

    const { allocation: activeParams } = await resolveActiveParams(c.env.DB, userId);
    const marketPrices = await fetchLatestPrices(c.env.DB);

    const response = triggerEngine.makeTriggerDecision(input, marketPrices, activeParams);

    await c.env.DB.prepare(
      'INSERT INTO trigger_log (user_id, balance, trigger_decision, signal_value, executed_amount, commission, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, portfolio.total_balance, response.decision, input.signal_value,
      response.executed_amount ?? 0, response.commission, nowIso()).run();

    // EXECUTE 决策异步发送执行建议邮件（不阻塞响应），1 天内去重
    if (response.decision === 'EXECUTE') {
      const user = await c.env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first<{ email: string }>();
      if (user) {
        const emailPromise = (async () => {
          if (await wasRecentlyNotified(c.env.DB, userId, 'execution_suggestion', EXECUTION_EMAIL_DEDUPE_DAYS)) return;
          const sent = await sendEmail(
            c.env.RESEND_API_KEY,
            user.email,
            '执行建议：触发线已达成',
            executionSuggestionEmailHtml({
              executedAmount: response.executed_amount ?? 0,
              safeAmount: response.layer_allocation.safe_amount,
              ambitionAmount: response.layer_allocation.ambition_amount,
              commission: response.commission,
              nextSafeEtf: response.next_safe_etf,
              nextSafeEtfName: symbolName(response.next_safe_etf),
              nextAmbitionEtf: response.next_ambition_etf,
              nextAmbitionEtfName: symbolName(response.next_ambition_etf),
              message: response.message,
            })
          );
          if (sent) await logNotification(c.env.DB, userId, 'execution_suggestion');
        })().catch((err: unknown) => { console.error('Failed to send execution email:', err); });
        c.executionCtx.waitUntil(emailPromise);
      }
    }

    return c.json({ success: true, data: response, message: response.message, timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

// GET /api/trigger/market-prices
triggerRouter.get('/market-prices', async (c) => {
  try {
    const prices = await fetchLatestPrices(c.env.DB);

    const data = {
      prices,
      symbols: TRACKED_SYMBOLS.map(symbol => ({
        symbol,
        name: symbolName(symbol),
        price: prices[symbol] ?? null,
        layer: SAFE_SYMBOLS.includes(symbol) ? 'safe' as const : 'ambition' as const,
      })),
      last_update: nowIso(),
    };

    return c.json({ success: true, data, timestamp: nowIso() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ success: false, error: 'Failed', message }, 500);
  }
});

export { triggerRouter };

