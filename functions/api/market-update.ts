import type { Env } from './[[route]]';

import { findMissingSymbols, validateMarketRow } from '../../src/lib/market-validation';
import { asiaShanghaiDate, isTradingDay, shiftDate } from '../../src/lib/trading-calendar';

import { decodeSinaKlc, type SinaKlineRow } from './sina-klc-decoder';
import { sinaCode, TRACKED_SYMBOLS } from './symbols';

const FULL_HISTORY_START = '1990-01-01';
const HIGH_WATER_OVERLAP_DAYS = 5;
const ROW_BATCH_SIZE = 500;

export { decodeSinaKlc, type SinaKlineRow };

export type SinaHistoryRow = Omit<SinaKlineRow, 'date'> & { date: string };

export async function fetchSinaHistory(
  symbol: string,
  _startDate: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const url = `https://finance.sina.com.cn/realstock/company/${sinaCode(symbol)}/hisdata_klc2/klc_kl.js`;
  const response = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Sina fetch failed for ${symbol}: HTTP ${response.status}`);
  return response.text();
}

export function parseSinaHistory(text: string): SinaHistoryRow[] {
  const payload = text.split('=')[1].split(';')[0].replaceAll('"', '');
  const rows = decodeSinaKlc(payload);
  for (const row of rows) {
    row.date = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
  }
  return rows as SinaHistoryRow[];
}

export interface MarketUpdateResult {
  skipped: boolean;
  reason?: string;
  updatedSymbols: string[];
  insertedRows: number;
}

export async function runScheduledMarketUpdate(env: Env, now: Date = new Date()): Promise<MarketUpdateResult> {
  const today = asiaShanghaiDate(now);
  if (!isTradingDay(today)) {
    return { skipped: true, reason: `non-trading day ${today}`, updatedSymbols: [], insertedRows: 0 };
  }

  const marksResult = await env.DB.prepare(
    'SELECT symbol, MAX(date) AS max_date FROM market_data GROUP BY symbol'
  ).all<{ symbol: string; max_date: string | null }>();
  const marks = new Map(marksResult.results.map(r => [r.symbol, r.max_date ?? '']));

  const statements: D1PreparedStatement[] = [];
  const updatedSymbols: string[] = [];
  let insertedRows = 0;
  const allSymbols: string[] = [];

  for (const symbol of TRACKED_SYMBOLS) {
    const mark = marks.get(symbol) ?? '';
    const startDate = mark ? shiftDate(mark, -HIGH_WATER_OVERLAP_DAYS) : FULL_HISTORY_START;
    const text = await fetchSinaHistory(symbol, startDate);
    const rows = parseSinaHistory(text).filter(r => r.date > mark && r.date <= today);
    if (rows.length === 0) continue;
    allSymbols.push(symbol);

    const validated = rows.map(r => validateMarketRow(
      { symbol, date: r.date, open: String(r.open), high: String(r.high), low: String(r.low), close: String(r.close), volume: String(r.volume) },
      0
    ));
    for (let i = 0; i < validated.length; i += ROW_BATCH_SIZE) {
      const chunk = validated.slice(i, i + ROW_BATCH_SIZE);
      const values = chunk.map(r =>
        `('${r.symbol}', '${r.date}', ${r.open ?? 'NULL'}, ${r.high ?? 'NULL'}, ${r.low ?? 'NULL'}, ${r.close}, ${r.volume})`
      ).join(',');
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO market_data (symbol, date, open, high, low, close, volume) VALUES ${values}`
      ));
    }
    insertedRows += validated.length;
    updatedSymbols.push(symbol);
  }

  const missing = findMissingSymbols(allSymbols, TRACKED_SYMBOLS);
  if (missing.length === TRACKED_SYMBOLS.length) {
    throw new Error(`Sina returned no data for any tracked symbol on trading day ${today}`);
  }
  if (missing.length > 0) {
    console.warn(`[market-update] no data fetched for symbol(s): ${missing.join(', ')}`);
  }

  if (statements.length > 0) await env.DB.batch(statements);
  return { skipped: false, updatedSymbols, insertedRows };
}