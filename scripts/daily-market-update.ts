#!/usr/bin/env node
/**
 * Daily market data update script.
 * Fetches latest quotes via BaoStock (Python), generates INSERT SQL,
 * and imports into Cloudflare D1 via wrangler.
 *
 * Usage:
 *   npm run market:update             # development (--local)
 *   npm run market:update -- --prod   # production (--remote)
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

const TRACKED_ETFS = [
  { code: 'sh.511360', name: 'Haitong Short-Term Bond ETF', layer: 'safe' },
  { code: 'sh.511880', name: 'Yinhua Rili Money Market', layer: 'safe' },
  { code: 'sh.000300', name: 'CSI 300 Index', layer: 'ambition' },
  { code: 'sh.000905', name: 'CSI 500 Index', layer: 'ambition' },
  { code: 'sh.000922', name: 'CSI Dividend Index', layer: 'ambition' },
];

function parseArgs(): { env: 'development' | 'production'; dbName: string } {
  const args = process.argv.slice(2);
  const isProd = args.includes('--prod') || args.includes('--production') || args.includes('-p');
  const env = isProd ? 'production' : 'development';
  const dbKey = isProd ? 'D1_PROD_NAME' : 'D1_DEV_NAME';
  const defaultName = isProd ? 'alpha-life-prod' : 'alpha-life-dev';
  const dbName = process.env[dbKey] ?? defaultName;
  return { env, dbName };
}

function checkPythonDeps(): void {
  try {
    execSync('python -c "import baostock, pandas"', { stdio: 'ignore' });
  } catch {
    try {
      execSync('python3 -c "import baostock, pandas"', { stdio: 'ignore' });
    } catch {
      console.error('ERROR: baostock or pandas not installed. Run: pip install baostock pandas');
      process.exit(1);
    }
  }
}

function createPythonScript(outputDir: string): string {
  const codesJson = JSON.stringify(TRACKED_ETFS.map(c => [c.code, c.name]));
  const safeOutDir = JSON.stringify(outputDir);
  return `
import baostock as bs, pandas as pd, sys, os, json, time
from datetime import datetime, timedelta

codes = ${codesJson}
out_dir = ${safeOutDir}
start = (datetime.now() - timedelta(days=10)).strftime('%Y-%m-%d')
end = datetime.now().strftime('%Y-%m-%d')

def login_with_retry(retries=3):
    for attempt in range(retries):
        try:
            lg = bs.login()
            if lg.error_code == '0':
                return lg
            print(f"Login failed (attempt {attempt+1}/{retries}): {lg.msg}", file=sys.stderr)
        except Exception as e:
            print(f"Login exception (attempt {attempt+1}/{retries}): {e}", file=sys.stderr)
        time.sleep(2)
    return None

lg = login_with_retry()
if lg is None:
    print(json.dumps({"error": "BaoStock login failed after retries"}))
    sys.exit(1)

results = []
for code, name in codes:
    rs = bs.query_history_k_data_plus(
        code, 'date,code,open,high,low,close,volume,amount',
        start_date=start, end_date=end, frequency='d'
    )
    if rs.error_code != '0':
        print(f"Query error for {code}: {rs.error_msg}", file=sys.stderr)
        continue
    while (rs.error_code == '0') & rs.next():
        r = rs.get_row_data()
        try:
            results.append({
                "symbol": r[1].replace("sh.", "").replace("sz.", ""),
                "date": r[0],
                "open": float(r[2]) if r[2] else None,
                "high": float(r[3]) if r[3] else None,
                "low": float(r[4]) if r[4] else None,
                "close": float(r[5]) if r[5] else None,
                "volume": int(r[6]) if r[6] else 0,
            })
        except:
            continue

bs.logout()

df = pd.DataFrame(results)
for code, name in codes:
    sym = code.replace("sh.", "").replace("sz.", "")
    sub = df[df["symbol"] == sym]
    if not sub.empty:
        fname = os.path.join(out_dir, f"{code.replace('.', '_')}.csv")
        sub.to_csv(fname, index=False)

print(json.dumps({"count": len(results), "symbols": list(set(r["symbol"] for r in results))}))
`;
}

function generateInsertSql(data: Array<{
  symbol: string; date: string; open: number | null;
  high: number | null; low: number | null; close: number | null; volume: number;
}>): string {
  const lines: string[] = [
    '-- Alpha-Life Engine Daily Market Data Update',
    `-- Generated: ${new Date().toISOString()}`,
    ''
  ];
  const batchSize = 500;
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);
    const values = batch.map(row =>
      `('${row.symbol}', '${row.date}', ${row.open ?? 'NULL'}, ${row.high ?? 'NULL'}, ${row.low ?? 'NULL'}, ${row.close ?? 'NULL'}, ${row.volume})`
    ).join(',');
    lines.push(`INSERT OR IGNORE INTO market_data (symbol, date, open, high, low, close, volume) VALUES ${values};`);
  }
  return lines.join('\n');
}

function execPythonWithRetry(scriptPath: string, args: string[] = []): string {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return execSync(`python "${scriptPath}" ${args.join(' ')}`, { encoding: 'utf8', timeout: 120000 });
    } catch {
      try {
        return execSync(`python3 "${scriptPath}" ${args.join(' ')}`, { encoding: 'utf8', timeout: 120000 });
      } catch {
        if (attempt < maxAttempts) {
          console.log(`Retry ${attempt}/${maxAttempts} after error...`);
          continue;
        }
        throw new Error(`Python execution failed after ${maxAttempts} attempts`);
      }
    }
  }
  throw new Error(`Python execution failed after ${maxAttempts} attempts`);
}

function fetchDataViaPython(outputDir: string): Array<{
  symbol: string; date: string; open: number | null;
  high: number | null; low: number | null; close: number | null; volume: number;
}> {
  const pyScript = createPythonScript(outputDir);
  const pyFile = resolve(outputDir, 'daily_update.py');
  writeFileSync(pyFile, pyScript, 'utf8');

  console.log('  Fetching latest quotes via BaoStock...');
  const stdout = execPythonWithRetry(pyFile);

  const lines = stdout.trim().split('\n');
  const lastLine = lines[lines.length - 1];
  const parsed = JSON.parse(lastLine);
  if (parsed.error) {
    throw new Error(`BaoStock error: ${parsed.error}`);
  }

  const allData: Array<{
    symbol: string; date: string; open: number | null;
    high: number | null; low: number | null; close: number | null; volume: number;
  }> = [];

  for (const etf of TRACKED_ETFS) {
    const csvFile = resolve(outputDir, `${etf.code.replace('.', '_')}.csv`);
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

function importToD1(sqlPath: string, env: 'development' | 'production', dbName: string): void {
  const isLocal = env === 'development';
  const flag = isLocal ? '--local' : '--remote';
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

  checkPythonDeps();

  const { env, dbName } = parseArgs();
  const outputDir = resolve(process.cwd(), 'data/market_data');
  mkdirSync(outputDir, { recursive: true });

  const startTime = Date.now();

  try {
    console.log('Step 1: Fetch BaoStock data');
    const data = fetchDataViaPython(outputDir);
    if (data.length === 0) {
      console.log('   No new data, update skipped');
      console.log('');
      console.log('='.repeat(50));
      console.log('Update completed (no changes)');
      return;
    }
    console.log('');

    console.log('Step 2: Generate SQL');
    const sql = generateInsertSql(data);
    const sqlPath = resolve(outputDir, `update_${new Date().toISOString().split('T')[0]}.sql`);
    writeFileSync(sqlPath, sql, 'utf8');
    console.log(`     SQL file: ${sqlPath}`);
    const insertCount = sql.split('\n').filter(l => l.startsWith('INSERT')).length;
    console.log(`     ${insertCount} INSERT statements`);
    console.log('');

    console.log('Step 3: Import to Cloudflare D1');
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
