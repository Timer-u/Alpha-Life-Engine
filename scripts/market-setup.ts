#!/usr/bin/env node

import type { TrackedSymbol } from './symbols';

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { createAkshareFetchScript } from './akshare-fetch';
import { resolvePythonCommand, symbolFromCode, TRACKED_SYMBOLS } from './symbols';

interface MarketSetupConfig {
  codes: readonly TrackedSymbol[];
  outputDir: string;
}

const FULL_HISTORY_START = '1990-01-01';

function findPython(): string {
  const python = resolvePythonCommand();
  if (!python) {
    console.error('ERROR: akshare or pandas not installed. Run: pip install akshare pandas');
    process.exit(1);
  }
  return python;
}

function generateImportSql(config: MarketSetupConfig): void {
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

export async function marketSetup() {
  console.log('='.repeat(50));
  console.log('Market Data Historical Data Initialization');
  console.log('='.repeat(50));
  console.log('');

  const python = findPython();
  console.log(`Using Python: ${python}`);
  console.log('');

  const config: MarketSetupConfig = {
    codes: TRACKED_SYMBOLS,
    outputDir: resolve(process.cwd(), 'data/market_data'),
  };

  try {
    mkdirSync(config.outputDir, { recursive: true });
    console.log(`Data directory created: ${config.outputDir}`);
    console.log('');

    const fullWindows: Record<string, string> = {};
    for (const sym of TRACKED_SYMBOLS) fullWindows[sym.code] = FULL_HISTORY_START;

    const pythonScript = createAkshareFetchScript(config.codes, fullWindows, config.outputDir);
    const scriptPath = resolve(config.outputDir, 'download.py');
    writeFileSync(scriptPath, pythonScript, 'utf8');
    console.log(`Python script created: ${scriptPath}`);
    console.log('');

    console.log('Downloading full history...');
    console.log(`   Assets: ${config.codes.map(c => `${c.code}(${c.name})`).join(', ')}`);
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
    console.log('Market data initialization completed');
    console.log('='.repeat(50));
    console.log('');
    console.log('Next steps:');
    console.log('1. Run npm run database:import-market to import data into D1');
    console.log('2. Configure GitHub Actions for automated daily updates');
    console.log('');
  } catch (error) {
    console.error('Market data initialization failed:', error);
    process.exit(1);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  marketSetup().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
