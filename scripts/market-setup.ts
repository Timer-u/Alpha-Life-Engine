#!/usr/bin/env node

import type { TrackedSymbol } from './symbols';

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  asiaShanghaiToday,
  resolvePythonCommand,
  symbolFromCode,
  TRACKED_SYMBOLS,
} from './symbols';

interface BaoStockConfig {
  codes: readonly TrackedSymbol[];
  startDate: string;
  endDate: string;
  outputDir: string;
}

const FULL_HISTORY_START = '1990-01-01';

function findPython(): string {
  const python = resolvePythonCommand();
  if (!python) {
    console.error('ERROR: baostock or pandas not installed. Run: pip install baostock pandas');
    process.exit(1);
  }
  return python;
}

function createPythonScript(config: BaoStockConfig): string {
  const codesJson = JSON.stringify(config.codes.map(c => [c.code, c.name]));
  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BaoStock historical data download + daily update script."""

import baostock as bs
import json
import os
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")


class BaoStockDownloader:
    """Download daily bars for tracked symbols from BaoStock."""

    def __init__(self, output_dir: str = ""):
        self.output_dir = output_dir or os.path.dirname(os.path.abspath(__file__))
        self.codes = ${codesJson}
        self.start_date = "1990-01-01"
        self.end_date = datetime.now(SHANGHAI_TZ).strftime("%Y-%m-%d")

    def login(self, retries: int = 3) -> bool:
        for attempt in range(retries):
            try:
                lg = bs.login()
                if lg.error_code == "0":
                    print("[OK] BaoStock login successful")
                    return True
                print(f"[FAIL] Login failed (attempt {attempt+1}/{retries}): {lg.error_msg}")
            except Exception as e:
                print(f"[FAIL] Login exception (attempt {attempt+1}/{retries}): {e}")
            time.sleep(2)
        return False

    def download_k_data(
        self, code: str, name: str, start_date: str | None = None
    ) -> list[dict] | None:
        print(f"  -> {name} ({code})")
        if not self.login():
            return None
        try:
            rs = bs.query_history_k_data_plus(
                code,
                "date,code,open,high,low,close,volume,amount",
                start_date=start_date or self.start_date,
                end_date=self.end_date,
                frequency="d",
            )
            if rs.error_code == "0":
                data = []
                while (rs.error_code == "0") & rs.next():
                    row = rs.get_row_data()
                    data.append(
                        {
                            "date": row[0],
                            "code": row[1],
                            "open": float(row[2]) if row[2] else None,
                            "high": float(row[3]) if row[3] else None,
                            "low": float(row[4]) if row[4] else None,
                            "close": float(row[5]) if row[5] else None,
                            "volume": int(row[6]) if row[6] else 0,
                            "amount": float(row[7]) if row[7] else 0.0,
                        }
                    )
                if data:
                    df = pd.DataFrame(data)
                    filename = f"{code.replace('.', '_')}.csv"
                    filepath = os.path.join(self.output_dir, filename)
                    df.to_csv(filepath, index=False)
                    print(f"     [OK] {len(data)} records")
                    return data
                print(f"     [SKIP] No data for {code}")
                return None
            print(f"     [FAIL] Query error {code}: {rs.error_msg}")
            return None
        except Exception as e:
            print(f"     [FAIL] {code}: {e}")
            return None
        finally:
            bs.logout()

    def download_all_history(self) -> bool:
        ok = True
        errors: list[str] = []
        total = 0
        try:
            for code, name in self.codes:
                data = self.download_k_data(code, name)
                if data:
                    total += len(data)
                else:
                    errors.append(code)
                time.sleep(0.5)
            if errors:
                print(f"[FAIL] Downloads failed for: {', '.join(errors)}", file=sys.stderr)
                ok = False
            else:
                print(f"\\n[OK] All done: {len(self.codes)} symbols, {total} records")
        finally:
            bs.logout()
        return ok

    def download_latest(self, days_back: int = 5) -> bool:
        start = (datetime.now(SHANGHAI_TZ) - timedelta(days=days_back)).strftime("%Y-%m-%d")
        print(f"[INFO] Fetching last {days_back} days from {start}")
        ok = True
        errors: list[str] = []
        total = 0
        try:
            for code, name in self.codes:
                data = self.download_k_data(code, name, start_date=start)
                if data:
                    total += len(data)
                else:
                    errors.append(code)
                time.sleep(0.5)
            if errors:
                print(f"[FAIL] Downloads failed for: {', '.join(errors)}", file=sys.stderr)
                ok = False
            else:
                print(f"\\n[OK] Daily update done: {total} records")
        finally:
            bs.logout()
        return ok


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "full"
    downloader = BaoStockDownloader()
    if mode == "daily":
        success = downloader.download_latest()
    else:
        success = downloader.download_all_history()
    sys.exit(0 if success else 1)
`;
}

function generateImportSql(config: BaoStockConfig): void {
  console.log('\nGenerating SQL import file...');
  const sqlPath = resolve(config.outputDir, 'import_market_data.sql');
  const lines: string[] = [
    '-- Alpha-Life Engine Market Data Import',
    `-- Generated: ${new Date().toISOString()}`,
    '',
  ];

  for (const etf of config.codes) {
    const csvFile = resolve(config.outputDir, `${etf.code.replace('.', '_')}.csv`);
    try {
      const csv = readFileSync(csvFile, 'utf8');
      const rows = csv.split('\n').slice(1).filter(r => r.trim());
      const batchRows: string[] = [];
      for (const row of rows) {
        const cols = row.split(',');
        if (cols.length < 6) continue;
        const [date, code, open, high, low, close, volume, _amount] = cols.map(c => c.trim());
        if (!date || !close) continue;
        // Extract symbol: remove 'sh.' or 'sz.' prefix
        const symbol = symbolFromCode(code);
        batchRows.push(
          `('${symbol}', '${date}', ${open || 'NULL'}, ${high || 'NULL'}, ${low || 'NULL'}, ${close || 'NULL'}, ${volume || '0'})`
        );
      }
      const chunkSize = 500;
      for (let i = 0; i < batchRows.length; i += chunkSize) {
        const chunk = batchRows.slice(i, i + chunkSize);
        lines.push(`INSERT OR IGNORE INTO market_data (symbol, date, open, high, low, close, volume) VALUES ${chunk.join(',')};`);
      }
      console.log(`   ${etf.name} (${etf.code}): ${batchRows.length} records`);
    } catch {
      console.log(`   WARNING: ${etf.name} CSV not found, skipped`);
    }
  }

  writeFileSync(sqlPath, lines.join('\n'), 'utf8');
  console.log(`SQL import file generated: ${sqlPath}`);
}

export async function baoStockSetup() {
  console.log('='.repeat(50));
  console.log('BaoStock Historical Data Initialization');
  console.log('='.repeat(50));
  console.log('');

  const python = findPython();
  console.log(`Using Python: ${python}`);
  console.log('');

  const config: BaoStockConfig = {
    codes: TRACKED_SYMBOLS,
    startDate: FULL_HISTORY_START,
    endDate: asiaShanghaiToday(),
    outputDir: resolve(process.cwd(), 'data/market_data'),
  };

  try {
    mkdirSync(config.outputDir, { recursive: true });
    console.log(`Data directory created: ${config.outputDir}`);
    console.log('');

    const pythonScript = createPythonScript(config);
    const scriptPath = resolve(config.outputDir, 'download.py');
    writeFileSync(scriptPath, pythonScript, 'utf8');
    console.log(`Python script created: ${scriptPath}`);
    console.log('');

    console.log('Downloading historical data...');
    console.log(`   Range: ${config.startDate} to ${config.endDate}`);
    console.log(`   Assets: ${config.codes.map(c => `${c.code}(${c.name})`).join(', ')}`);
    console.log('');
    console.log('Note: First-time download may take 10-30 minutes');
    console.log('');

    let executed = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        execSync(`${python} "${scriptPath}"`, { stdio: 'inherit' });
        executed = true;
        break;
      } catch {
        if (attempt === 1) {
          console.log('Retrying Python execution...');
          continue;
        }
        throw new Error('Python execution failed after retries');
      }
    }
    if (!executed) throw new Error('Could not run Python script');

    generateImportSql(config);

    console.log('');
    console.log('='.repeat(50));
    console.log('BaoStock initialization completed');
    console.log('='.repeat(50));
    console.log('');
    console.log('Next steps:');
    console.log('1. Run npm run database:import-market to import data into D1');
    console.log('2. Configure GitHub Actions for automated daily updates');
    console.log('');
  } catch (error) {
    console.error('BaoStock initialization failed:', error);
    process.exit(1);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  baoStockSetup().catch(error => {
    console.error(error);
    process.exit(1);
  });
}