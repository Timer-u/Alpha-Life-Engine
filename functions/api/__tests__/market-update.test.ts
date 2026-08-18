import type { Env } from '../[[route]]';

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarketValidationError } from '../../../src/lib/market-validation';
import { runScheduledMarketUpdate } from '../market-update';
import { TRACKED_SYMBOLS } from '../symbols';

import { asD1, FakeD1 } from './helpers/fake-d1';

const SAMPLE_TEXT = readFileSync(new URL('./fixtures/sina-511360-sample.txt', import.meta.url), 'utf8');
const INVALID_TEXT = readFileSync(new URL('./fixtures/sina-511360-invalid.txt', import.meta.url), 'utf8');
const EMPTY_TEXT = readFileSync(new URL('./fixtures/sina-511360-empty.txt', import.meta.url), 'utf8');

function testEnv(db: FakeD1): Env {
  return { DB: asD1(db), RESEND_API_KEY: '', ENVIRONMENT: 'test', SESSION_DAYS: '7' };
}

function marketDb(): FakeD1 {
  return new FakeD1([
    { match: sql => sql.includes('GROUP BY symbol'), rows: TRACKED_SYMBOLS.map(symbol => ({ symbol, max_date: '2026-08-10' })) },
    { match: sql => sql.includes('INSERT OR IGNORE INTO market_data'), rows: [] },
  ]);
}

function stubFetch(text: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(text, { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runScheduledMarketUpdate', () => {
  it('skips on a non-trading day without fetching or writing', async () => {
    const db = marketDb();
    const fetch = stubFetch(SAMPLE_TEXT);

    const result = await runScheduledMarketUpdate(testEnv(db), new Date('2026-08-15T04:00:00Z'));

    expect(result).toEqual({ skipped: true, reason: 'non-trading day 2026-08-15', updatedSymbols: [], insertedRows: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(db.statements).toEqual([]);
  });

  it('fetches, validates, and inserts rows for all tracked symbols', async () => {
    const db = marketDb();
    const fetch = stubFetch(SAMPLE_TEXT);

    const result = await runScheduledMarketUpdate(testEnv(db), new Date('2026-08-19T04:00:00Z'));

    expect(result.skipped).toBe(false);
    expect(result.updatedSymbols.sort()).toEqual([...TRACKED_SYMBOLS].sort());
    expect(result.insertedRows).toBe(TRACKED_SYMBOLS.length * 2);
    expect(fetch).toHaveBeenCalledTimes(TRACKED_SYMBOLS.length);

    const insertStatements = db.statements.filter(sql => sql.includes('INSERT OR IGNORE INTO market_data'));
    expect(insertStatements).toHaveLength(TRACKED_SYMBOLS.length);
    for (const sql of insertStatements) {
      expect(sql).toContain('2026-08-11');
      expect(sql).toContain('2026-08-12');
      expect(sql).not.toContain('2026-08-13');
    }
  });

  it('throws when Sina returns no data for any symbol on a trading day', async () => {
    const db = marketDb();
    stubFetch(EMPTY_TEXT);

    await expect(runScheduledMarketUpdate(testEnv(db), new Date('2026-08-19T04:00:00Z'))).rejects.toThrow(
      'Sina returned no data for any tracked symbol on trading day 2026-08-19'
    );
    expect(db.statements).toEqual([]);
  });

  it('rejects rows with invalid OHLC (close = 0)', async () => {
    const db = marketDb();
    stubFetch(INVALID_TEXT);

    await expect(runScheduledMarketUpdate(testEnv(db), new Date('2026-08-19T04:00:00Z'))).rejects.toBeInstanceOf(
      MarketValidationError
    );
    expect(db.statements).toEqual([]);
  });
});
