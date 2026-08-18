#!/usr/bin/env node

import type { MarketRow } from '../src/lib/market-validation';
import type { TrackedSymbol } from './symbols';

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

import { findMissingSymbols, parseMarketCsv } from '../src/lib/market-validation';

import { createAkshareFetchScript } from './akshare-fetch';
import { resolvePythonCommand, TRACKED_SYMBOLS } from './symbols';

interface MarketSetupConfig {
  codes: readonly TrackedSymbol[];
  outputDir: string;
}

const FULL_HISTORY_START = '1990-01-01';

function findPython(): string {
  return resolvePythonCommand();
}

function generateImportSql(config: MarketSetupConfig): void {
  console.log('\nGenerating SQL import file...');
  const sqlPath = resolve(config.outputDir, 'import_market_data.sql');
  const lines: string[] = [
    '-- Alpha-Life Engine Market Data Import',
    `-- Generated: ${new Date().toISOString()}`,
    '',
  ];

  const allRows: MarketRow[] = [];
  for (const etf of config.codes) {
    const csvFile = resolve(config.outputDir, `${etf.code.replace('.', '_')}.csv`);
    if (!existsSync(csvFile)) {
      throw new Error(`${etf.name} CSV not found: ${csvFile} — market setup must cover all 6 tracked symbols`);
    }
    const csv = readFileSync(csvFile, 'utf8');
    const rows = parseMarketCsv(csv);
    allRows.push(...rows);
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      lines.push(`INSERT OR IGNORE INTO market_data (symbol, date, open, high, low, close, volume) VALUES ${chunk
        .map(r => `('${r.symbol}', '${r.date}', ${r.open ?? 'NULL'}, ${r.high ?? 'NULL'}, ${r.low ?? 'NULL'}, ${r.close}, ${r.volume})`)
        .join(',')};`);
    }
    console.log(`   ${etf.name} (${etf.code}): ${rows.length} records`);
  }

  const expected = config.codes.map(c => c.code.replace(/^(sh|sz)\./, ''));
  const missing = findMissingSymbols(allRows.map(r => r.symbol), expected);
  if (missing.length > 0) throw new Error(`Market data missing for symbol(s): ${missing.join(', ')}`);

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
