#!/usr/bin/env node
/**
 * Generate scripts/local_evolver/generated_symbols.py from scripts/symbols.ts.
 *
 * scripts/symbols.ts is the single source of truth for the tracked universe;
 * this sync removes the handwritten Python copy (api_client.TRACKED_SYMBOLS /
 * walk_forward.BACKTEST_SYMBOLS had to be manually kept in step).
 *
 * Run after editing symbols.ts:  npm run symbols:sync
 * CI verifies the checked-in file is up to date (git diff --exit-code).
 */
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import { AMBITION_SYMBOLS, SAFE_LIVE_TRADEABLES, symbolFromCode } from './symbols';

const OUT_PATH = resolve(process.cwd(), 'scripts/local_evolver/generated_symbols.py');

function pyList(values: readonly string[]): string {
  return `[${values.map(v => `"${v}"`).join(', ')}]`;
}

const safe = SAFE_LIVE_TRADEABLES.map(s => symbolFromCode(s.code));
const ambition = AMBITION_SYMBOLS.map(s => symbolFromCode(s.code));
const all = [...safe, ...ambition];

const content = `"""GENERATED FILE — do not edit by hand.

Single source of truth: scripts/symbols.ts (TRACKED_SYMBOLS).
Regenerate with: npm run symbols:sync (CI 用 git diff 校验，文件必须可复现，故不含时间戳)
"""

TRACKED_SYMBOLS: list[str] = ${pyList(all)}
SAFE_SYMBOLS: list[str] = ${pyList(safe)}
AMBITION_SYMBOLS: list[str] = ${pyList(ambition)}
`;

mkdirSync(resolve(OUT_PATH, '..'), { recursive: true });
writeFileSync(OUT_PATH, content, 'utf8');
console.log(`Wrote ${OUT_PATH}`);
console.log(`  safe:     ${safe.join(', ')}`);
console.log(`  ambition: ${ambition.join(', ')}`);
