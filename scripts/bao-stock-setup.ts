#!/usr/bin/env node

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

interface BaoStockConfig {
  codes: Array<{ code: string; name: string }>;
  startDate: string;
  endDate: string;
  outputDir: string;
}

const TRACKED_ETFS = [
  { code: 'sh.511360', name: 'Haitong Short-Term Bond ETF', layer: 'safe' },
  { code: 'sh.511880', name: 'Yinhua Rili Money Market', layer: 'safe' },
  { code: 'sh.000300', name: 'CSI 300 Index', layer: 'ambition' },
  { code: 'sh.000905', name: 'CSI 500 Index', layer: 'ambition' },
  { code: 'sh.000922', name: 'CSI Dividend Index', layer: 'ambition' },
];

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

function createPythonScript(config: BaoStockConfig): string {
  const codesJson = JSON.stringify(config.codes.map(c => [c.code, c.name]));
  const safeOutDir = JSON.stringify(config.outputDir);
  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BaoStock historical data download + daily update script
"""

import baostock as bs
import pandas as pd
import sys
import os
import time
from datetime import datetime, timedelta

class BaoStockDownloader:
    def __init__(self, output_dir: str):
        self.output_dir = output_dir
        self.codes = ${codesJson}
        self.start_date = '1990-01-01'
        self.end_date = datetime.now().strftime('%Y-%m-%d')

    def login(self, retries=3):
        for attempt in range(retries):
            try:
                lg = bs.login()
                if lg.error_code == '0':
                    print(f"[OK] BaoStock login successful")
                    return True
                print(f"[FAIL] Login failed (attempt {attempt+1}/{retries}): {lg.msg}")
            except Exception as e:
                print(f"[FAIL] Login exception (attempt {attempt+1}/{retries}): {e}")
            time.sleep(2)
        return False

    def download_k_data(self, code: str, name: str, start_date: str = None):
        print(f"  -> {name} ({code})")
        try:
            rs = bs.query_history_k_data_plus(
                code,
                'date,code,open,high,low,close,volume,amount',
                start_date=start_date or self.start_date,
                end_date=self.end_date,
                frequency='d'
            )
            if rs.error_code != '0':
                print(f"     [FAIL] {rs.error_msg}")
                return None
            data = []
            while (rs.error_code == '0') & rs.next():
                row = rs.get_row_data()
                try:
                    data.append({
                        'date': row[0],
                        'code': row[1],
                        'open': float(row[2]) if row[2] else None,
                        'high': float(row[3]) if row[3] else None,
                        'low': float(row[4]) if row[4] else None,
                        'close': float(row[5]) if row[5] else None,
                        'volume': int(row[6]) if row[6] else 0,
                        'amount': float(row[7]) if row[7] else 0,
                    })
                except (ValueError, IndexError) as e:
                    print(f"     [WARN] row parsing error: {e}")
                    continue
            if data:
                df = pd.DataFrame(data)
                filename = f"{code.replace('.', '_')}.csv"
                filepath = os.path.join(self.output_dir, filename)
                df.to_csv(filepath, index=False)
                print(f"     [OK] {len(data)} records")
                return data
            else:
                print(f"     [SKIP] No data")
                return None
        except Exception as e:
            print(f"     [FAIL] {e}")
            return None

    def download_all_history(self):
        if not self.login():
            return False
        try:
            total = 0
            for code, name in self.codes:
                data = self.download_k_data(code, name)
                if data:
                    total += len(data)
            print(f"\\n[OK] All done: {len(self.codes)} ETFs/Indices, {total} records")
            return True
        finally:
            bs.logout()

    def download_latest(self, days_back: int = 5):
        if not self.login():
            return False
        try:
            start = (datetime.now() - timedelta(days=days_back)).strftime('%Y-%m-%d')
            print(f"[INFO] Fetching last {days_back} days from {start}")
            total = 0
            for code, name in self.codes:
                data = self.download_k_data(code, name, start_date=start)
                if data:
                    total += len(data)
            print(f"\\n[OK] Daily update done: {total} new records")
            return True
        finally:
            bs.logout()

if __name__ == '__main__':
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else 'full'
    downloader = BaoStockDownloader(${safeOutDir})
    if mode == 'daily':
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
    ''
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
        const symbol = code.replace(/^(sh|sz)\./, '');
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

  checkPythonDeps();

  const config: BaoStockConfig = {
    codes: TRACKED_ETFS,
    startDate: '1990-01-01',
    endDate: new Date().toISOString().split('T')[0],
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
        execSync(`python "${scriptPath}"`, { stdio: 'inherit' });
        executed = true;
        break;
      } catch {
        try {
          execSync(`python3 "${scriptPath}"`, { stdio: 'inherit' });
          executed = true;
          break;
        } catch {
          if (attempt === 1) {
            console.log('Retrying Python execution...');
            continue;
          } else {
            throw new Error('Python execution failed after retries');
          }
        }
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
    console.log('1. Run npm run database:migrate to import data into D1');
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
