import type { Env } from './[[route]]';

import { findMissingSymbols, validateMarketRow } from '../../src/lib/market-validation';
import { asiaShanghaiDate, isTradingDay } from '../../src/lib/trading-calendar';

import { decodeSinaKlc, type SinaKlineRow } from './sina-klc-decoder';
import { sinaCode, TRACKED_SYMBOLS } from './symbols';

const ROW_BATCH_SIZE = 500;
const FETCH_TIMEOUT_MS = 10_000;

export { decodeSinaKlc, type SinaKlineRow };

export type SinaHistoryRow = Omit<SinaKlineRow, 'date'> & { date: string };

export async function fetchSinaHistory(
  symbol: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const url = `https://finance.sina.com.cn/realstock/company/${sinaCode(symbol)}/hisdata_klc2/klc_kl.js`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Sina fetch failed for ${symbol}: HTTP ${response.status}`);
    return response.text();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Sina fetch timed out for ${symbol}`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function parseSinaHistory(text: string, symbol = ''): SinaHistoryRow[] {
  // Loose envelope validation: real payloads always carry '=' then ';' after it.
  if (!text.includes('=') || text.indexOf(';', text.indexOf('=')) === -1) {
    throw new Error(`Sina response parse failed${symbol ? ` for ${symbol}` : ''}: payload missing '=' or ';' marker`);
  }
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
  let firstSymbolError: unknown;
  let fetchedSymbols = 0;

  for (const symbol of TRACKED_SYMBOLS) {
    try {
      const mark = marks.get(symbol) ?? '';
      const text = await fetchSinaHistory(symbol);
      fetchedSymbols += 1;
      const rows = parseSinaHistory(text, symbol).filter(r => r.date > mark && r.date <= today);
      if (rows.length === 0) continue;

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
    } catch (err) {
      firstSymbolError ??= err;
      console.warn(`[market-update] symbol failed: ${symbol}`, err);
    }
  }

  if (fetchedSymbols === 0) {
    if (firstSymbolError) throw firstSymbolError;
    throw new Error(`Sina returned no data for any tracked symbol on trading day ${today}`);
  }
  if (updatedSymbols.length === 0) {
    if (firstSymbolError) throw firstSymbolError;
    // 全部标的成功拉取且无校验错误，但都没有新行（手动补数后/数据源当日
    // 延迟）：这是"已最新"，不是拉取失败，勿抛错制造每日假告警
    return { skipped: true, reason: `all ${fetchedSymbols} symbols up to date on ${today}`, updatedSymbols: [], insertedRows: 0 };
  }
  const missing = findMissingSymbols(updatedSymbols, TRACKED_SYMBOLS);
  if (missing.length > 0) {
    console.warn(`[market-update] no data fetched for symbol(s): ${missing.join(', ')}`);
  }

  if (statements.length > 0) await env.DB.batch(statements);
  return { skipped: false, updatedSymbols, insertedRows };
}
