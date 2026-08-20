#!/usr/bin/env node
/**
 * Export the A-share trading calendar to a checked-in JSON file.
 *
 * Runs akshare's `tool_trade_date_hist_sina` (via Python) and writes
 * `src/lib/trade-calendar.json` — the offline source of truth used by
 * `src/lib/trading-calendar.ts` at runtime (no network at test time).
 *
 * Usage:
 *   npx tsx scripts/export-trade-calendar.ts
 */

import { execSync } from 'child_process';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { resolvePythonCommand } from './symbols';

const CALENDAR_START = '2013-01-01';
const CALENDAR_THROUGH = '2027-12-31';
const OUT_FILE = resolve(import.meta.dirname, '../src/lib/trade-calendar.json');
const PY_FILE = resolve(tmpdir(), 'export_trade_calendar.py');

const PY_SNIPPET = `import json
import sys

import akshare as ak

try:
    df = ak.tool_trade_date_hist_sina()
except Exception as exc:
    print(json.dumps({"error": f"tool_trade_date_hist_sina failed: {exc}"}))
    sys.exit(1)

raw = df["trade_date"].astype(str)
raw = raw[(raw >= "${CALENDAR_START}") & (raw <= "${CALENDAR_THROUGH}")]
print(json.dumps(raw.tolist()))
`;

interface CalendarOutput {
  dates: string[];
}

function parseCalendarOutput(json: string): CalendarOutput {
  const value = JSON.parse(json) as string[] | { error: string };
  if (!Array.isArray(value)) throw new Error(value.error);
  return { dates: value };
}

export async function exportTradeCalendar(): Promise<string> {
  const python = resolvePythonCommand();
  try {
    writeFileSync(PY_FILE, PY_SNIPPET, 'utf8');

    const stdout = execSync(`${python} "${PY_FILE}"`, {
      encoding: 'utf8',
      timeout: 300000,
    }).trim();

    const lines = stdout.split('\n').filter(line => line.trim().length > 0);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) throw new Error('Trade calendar Python produced no output');
    const parsed = parseCalendarOutput(lastLine);

    const dates = [...new Set(parsed.dates)].sort();
    const lastDate = dates[dates.length - 1];
    const schema = {
      source: 'akshare tool_trade_date_hist_sina',
      generated_at: new Date().toISOString().slice(0, 10),
      through: lastDate,
      dates,
    };
    writeFileSync(OUT_FILE, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${dates.length} trading days (${CALENDAR_START}..${lastDate}) to ${OUT_FILE}`);
    return OUT_FILE;
  } finally {
    if (existsSync(PY_FILE)) unlinkSync(PY_FILE);
  }
}

if (process.argv[1] === import.meta.filename) {
  exportTradeCalendar().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
