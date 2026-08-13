#!/usr/bin/env node
/**
 * Daily market data update script.
 * Fetches latest quotes via AKShare Sina (Python), generates INSERT SQL,
 * and imports into Cloudflare D1 via wrangler.
 *
 * Usage:
 *   npm run market:update              # development (default)
 *   npm run market:update -- --local   # development
 *   npm run market:update -- --dev     # development
 *   npm run market:update -- --prod    # production (--remote)
 *
 * Data source: AKShare Sina (fund_etf_hist_sina). Per-symbol start dates come
 * from the D1 high-water mark; symbols without rows fall back to full history.
 * Unknown flags are rejected loudly (never silently ignored).
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { createAkshareFetchScript } from './akshare-fetch';
import {
  asiaShanghaiToday,
  baoCodeToCsvName,
  isAsiaShanghaiWeekday,
  resolvePythonCommand,
  shiftDate,
  symbolFromCode,
  TRACKED_SYMBOLS,
} from './symbols';

const __filename = fileURLToPath(import.meta.url);

const FULL_HISTORY_START = '1990-01-01';
const HIGH_WATER_OVERLAP_DAYS = 5;

const PROD_FLAGS = ['--prod', '--production', '-p'] as const;
const DEV_FLAGS = ['--local', '--dev', '--development'] as const;

type Env = 'development' | 'production';

interface CliOptions {
  env: Env;
  dbName: string;
}

interface MarketRow {
  symbol: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number;
}

interface PythonSummary {
  count: number;
  symbols: string[];
  failures?: string[];
  error?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const knownFlags = new Set<string>([...PROD_FLAGS, ...DEV_FLAGS]);
  const unknown = args.filter(flag => !knownFlags.has(flag));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(', ')}\n` +
        `Usage: tsx scripts/daily-market-update.ts [--local|--dev|--development|--prod|--production|-p]`
    );
  }
  const isProd = PROD_FLAGS.some(flag => args.includes(flag));
  const env: Env = isProd ? 'production' : 'development';
  const dbKey = isProd ? 'D1_PROD_NAME' : 'D1_DEV_NAME';
  const defaultName = isProd ? 'alpha-life-prod' : 'alpha-life-dev';
  const dbName = process.env[dbKey] ?? defaultName;
  return { env, dbName };
}

/**
 * Per-symbol last stored date from D1 (`MAX(date) GROUP BY symbol`).
 * Empty map means "no history yet" -> full-history fallback for every symbol.
 */
function queryHighWaterMarks(dbName: string, env: Env): Record<string, string> {
  const flag = env === 'development' ? '--local' : '--remote';
  const cmd =
    `wrangler d1 execute ${dbName} --command=` +
    `"SELECT symbol, MAX(date) AS max_date FROM market_data GROUP BY symbol" --json ${flag}`;
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', timeout: 120000 }).trim();
    const parsed = JSON.parse(stdout) as
      | { result?: Array<{ results?: Array<{ symbol?: string; max_date?: string }> }> }
      | Array<{ results?: Array<{ symbol?: string; max_date?: string }> }>;
    const executions = Array.isArray(parsed) ? parsed : parsed.result;
    const rows = executions?.[0]?.results ?? [];
    const marks: Record<string, string> = {};
    for (const row of rows) {
      if (row.symbol && row.max_date) marks[row.symbol] = row.max_date;
    }
    return marks;
  } catch (error) {
    console.warn(
      `  WARN: could not read D1 high-water marks from ${dbName} (${env}); ` +
        `falling back to full-history fetch for all symbols. ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
}

/**
 * Per-symbol fetch window: last stored date minus a small overlap (re-fetch a
 * few days so late-published bars are caught and re-runs stay idempotent), or
 * the full-history start when a symbol has no rows yet.
 */
function computeWindows(marks: Record<string, string>): Record<string, string> {
  const windows: Record<string, string> = {};
  for (const sym of TRACKED_SYMBOLS) {
    const last = marks[symbolFromCode(sym.code)];
    windows[sym.code] = last
      ? shiftDate(last, -HIGH_WATER_OVERLAP_DAYS)
      : FULL_HISTORY_START;
  }
  return windows;
}

function generateInsertSql(data: MarketRow[]): string {
  const lines: string[] = [
    '-- Alpha-Life Engine Daily Market Data Update',
    `-- Generated: ${new Date().toISOString()}`,
    '',
  ];
  const batchSize = 500;
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    const values = batch
      .map(
        row =>
          `('${row.symbol}', '${row.date}', ${row.open ?? 'NULL'}, ${row.high ?? 'NULL'}, ` +
          `${row.low ?? 'NULL'}, ${row.close ?? 'NULL'}, ${row.volume})`
      )
      .join(',');
    lines.push(
      `INSERT OR IGNORE INTO market_data (symbol, date, open, high, low, close, volume) VALUES ${values};`
    );
  }
  return lines.join('\n');
}

function execPythonWithRetry(scriptPath: string): string {
  const python = resolvePythonCommand();
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return execSync(`${python} "${scriptPath}"`, {
        encoding: 'utf8',
        timeout: 300000,
      }).trim();
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string };
      const stdout = err.stdout ?? '';
      const stderr = err.stderr ?? '';
      const lastLine = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .pop();
      let detail = stderr.trim();
      if (lastLine) {
        try {
          const summary = JSON.parse(lastLine) as PythonSummary;
          const failed = summary.failures?.length ? summary.failures.join(', ') : undefined;
          if (failed) detail = detail ? `${failed} | ${detail}` : failed;
          if (summary.error) detail = detail ? `${summary.error} | ${detail}` : summary.error;
        } catch {
          // last line was not JSON; stderr carries the detail
        }
      }
      if (attempt < maxAttempts) {
        console.log(`  Python attempt ${attempt}/${maxAttempts} failed; retrying...`);
        continue;
      }
      throw new Error(`BaoStock fetch failed: ${detail || 'unknown error'}`, {
        cause: error,
      });
    }
  }
  throw new Error('BaoStock fetch failed (unreachable)');
}

function fetchDataViaPython(
  outputDir: string,
  windows: Record<string, string>
): MarketRow[] {
  const pyScript = createAkshareFetchScript(TRACKED_SYMBOLS, windows, outputDir);
  const pyFile = resolve(outputDir, 'daily_update.py');
  writeFileSync(pyFile, pyScript, 'utf8');

  console.log('  Fetching latest quotes via BaoStock...');
  const stdout = execPythonWithRetry(pyFile);

  const lines = stdout.split('\n');
  const lastLine = lines[lines.length - 1]?.trim();
  if (!lastLine) throw new Error('BaoStock Python produced no output');
  const parsed = JSON.parse(lastLine) as PythonSummary;
  if (parsed.error) throw new Error(`BaoStock error: ${parsed.error}`);
  if (parsed.failures?.length) {
    throw new Error(`BaoStock query failed for symbol(s): ${parsed.failures.join(', ')}`);
  }

  const allData: MarketRow[] = [];
  const returnedSymbols = new Set(parsed.symbols);
  for (const sym of TRACKED_SYMBOLS) {
    const bare = symbolFromCode(sym.code);
    if (!returnedSymbols.has(bare)) continue;
    const csvFile = resolve(outputDir, `${baoCodeToCsvName(sym.code)}.csv`);
    if (!existsSync(csvFile)) continue;

    const csv = readFileSync(csvFile, 'utf8');
    const rows = csv.split('\n').slice(1).filter(r => r.trim());
    for (const row of rows) {
      const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols.length < 6) continue;
      const [date, code, open, high, low, close, volume] = cols;
      if (!date || !close) continue;
      allData.push({
        symbol: code.replace('sh.', '').replace('sz.', ''),
        date,
        open: open ? parseFloat(open) : null,
        high: high ? parseFloat(high) : null,
        low: low ? parseFloat(low) : null,
        close: parseFloat(close),
        volume: volume ? parseInt(volume, 10) : 0,
      });
    }
  }

  console.log(`     Retrieved ${parsed.count} records`);
  const seen = new Set<string>();
  return allData.filter(row => {
    const key = `${row.symbol}|${row.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function importToD1(sqlPath: string, env: Env, dbName: string): void {
  const flag = env === 'development' ? '--local' : '--remote';
  const cmd = `wrangler d1 execute ${dbName} --file="${sqlPath}" ${flag}`;
  console.log(`  Writing to ${dbName} (${env})...`);
  execSync(cmd, { stdio: 'inherit', cwd: process.cwd(), timeout: 300000 });
}

export async function dailyMarketUpdate(): Promise<void> {
  console.log('');
  console.log('='.repeat(50));
  console.log('Alpha-Life Daily Market Data Update');
  console.log('='.repeat(50));
  console.log('');

  const { env, dbName } = parseArgs();
  const outputDir = resolve(process.cwd(), 'data/market_data');
  mkdirSync(outputDir, { recursive: true });

  const startTime = Date.now();

  try {
    console.log(`  Date (Asia/Shanghai): ${asiaShanghaiToday()}  ` +
      `weekday: ${isAsiaShanghaiWeekday()}  env: ${env}  db: ${dbName}`);
    console.log(`  Symbols: ${TRACKED_SYMBOLS.map(s => s.code).join(', ')}`);
    console.log('');

    console.log('Step 1: Determine per-symbol fetch windows (D1 high-water marks)');
    const marks = queryHighWaterMarks(dbName, env);
    const windows = computeWindows(marks);
    for (const sym of TRACKED_SYMBOLS) {
      const bare = symbolFromCode(sym.code);
      const last = marks[bare];
      console.log(
        last
          ? `     ${sym.code} (${sym.name}): last stored ${last}, fetch from ${windows[sym.code]}`
          : `     ${sym.code} (${sym.name}): no rows yet, full-history from ${windows[sym.code]}`
      );
    }
    console.log('');

    console.log('Step 2: Fetch BaoStock data');
    const data = fetchDataViaPython(outputDir, windows);

    if (data.length === 0) {
      if (isAsiaShanghaiWeekday()) {
        throw new Error(
          'No new market data for any tracked symbol on an Asia/Shanghai weekday. ' +
            'Expected on Chinese market holidays (CNY, National Day, etc.), but a real trading ' +
            'calendar is P1/out of scope so an empty weekday result is treated as a failure. ' +
            'If today is a trading day, BaoStock or the pipeline is down.'
        );
      }
      console.log('   No new data (Asia/Shanghai weekend — market closed, expected). Update skipped.');
      console.log('');
      console.log('='.repeat(50));
      console.log('Update completed (no changes)');
      return;
    }
    console.log('');

    console.log('Step 3: Generate SQL');
    const sql = generateInsertSql(data);
    const sqlPath = resolve(outputDir, `update_${asiaShanghaiToday()}.sql`);
    writeFileSync(sqlPath, sql, 'utf8');
    console.log(`     SQL file: ${sqlPath}`);
    const insertCount = sql.split('\n').filter(l => l.startsWith('INSERT')).length;
    console.log(`     ${insertCount} INSERT statements`);
    console.log('');

    console.log('Step 4: Import to Cloudflare D1');
    importToD1(sqlPath, env, dbName);
    console.log('');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('='.repeat(50));
    console.log(`Daily market data update completed (${elapsed}s)`);
    console.log(`   Database: ${dbName} (${env})`);
    console.log(`   Records inserted: ${insertCount}`);
    console.log('='.repeat(50));
  } catch (error) {
    console.error('');
    console.error('Update failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (process.argv[1] === __filename) {
  dailyMarketUpdate().catch(error => {
    console.error(error);
    process.exit(1);
  });
}