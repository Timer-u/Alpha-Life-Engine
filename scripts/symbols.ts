import { execSync } from 'child_process';

export type SymbolLayer = 'safe' | 'ambition';
export type SymbolRole = 'live-tradeable' | 'ambition';

export interface TrackedSymbol {
  /** Sina/AKShare instrument code with exchange prefix, e.g. 'sh.511880' */
  code: string;
  /** Human-readable label for logs/SQL headers */
  name: string;
  /** Portfolio layer (mirrors the `layer` column in D1) */
  layer: SymbolLayer;
  /** Pipeline role: how this symbol's history is consumed */
  role: SymbolRole;
}

/**
 * Cross-agent symbol contract shared by every pipeline script.
 *
 * Universe = 6 live-tradeable ETFs, fetched via AKShare Sina
 * (`fund_etf_hist_sina`). Verified 2026-08-13:
 *  - Sina provides 7-14 years of daily history per ETF (511880 since 2013-04,
 *    510300 since 2012-05, ...).
 *  - BaoStock free tier exposes only ~147 bars (from 2026-01-05) for EVERY ETF
 *    — this was why the old pipeline used index proxies; do not switch back.
 *  - Eastmoney (`fund_etf_hist_em`) is unreliable from this network (1/4
 *    success rate on 2026-08-13) — do not switch provider without re-verifying.
 */
export const SAFE_LIVE_TRADEABLES: readonly TrackedSymbol[] = [
  { code: 'sh.511360', name: 'Haitong Short-Term Bond ETF', layer: 'safe', role: 'live-tradeable' },
  { code: 'sh.511880', name: 'Yinhua Rili Money Market', layer: 'safe', role: 'live-tradeable' },
  { code: 'sh.511990', name: 'Huabao Tianyi Money ETF', layer: 'safe', role: 'live-tradeable' },
];

export const AMBITION_SYMBOLS: readonly TrackedSymbol[] = [
  { code: 'sh.510300', name: 'CSI 300 ETF', layer: 'ambition', role: 'ambition' },
  { code: 'sh.510500', name: 'CSI 500 ETF', layer: 'ambition', role: 'ambition' },
  { code: 'sh.515080', name: 'CSI Dividend ETF', layer: 'ambition', role: 'ambition' },
];

export const TRACKED_SYMBOLS: readonly TrackedSymbol[] = [
  ...SAFE_LIVE_TRADEABLES,
  ...AMBITION_SYMBOLS,
];

/** Strip the exchange prefix from a Sina/AKShare code ('sh.510300' -> '510300'). */
export function symbolFromCode(code: string): string {
  return code.replace(/^(sh|sz)\./, '');
}

/** Sina/AKShare code -> CSV basename ('sh.510300' -> 'sh_510300'). */
export function baoCodeToCsvName(code: string): string {
  return code.replace('.', '_');
}

const ASIA_SHANGHAI = 'Asia/Shanghai';

/** True when today is Mon-Fri in Asia/Shanghai (a plausible trading day). */
export function isAsiaShanghaiWeekday(): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: ASIA_SHANGHAI,
  }).format(new Date());
  return !['Sat', 'Sun'].includes(weekday);
}

/** Shift a YYYY-MM-DD calendar date by `days` (may be negative). */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, day + days));
  return target.toISOString().slice(0, 10);
}

const PYTHON_CANDIDATES = ['python', 'python3', 'py -3.14'] as const;

/**
 * Resolve a Python interpreter able to import akshare + pandas.
 * On GitHub Actions `python`/`python3` exist; on Windows the `py -3.14` launcher
 * is the fallback the evolver targets (the broken WindowsApps `python3` stub is
 * skipped because it exits non-zero on the import probe).
 */
export function resolvePythonCommand(): string {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      execSync(`${candidate} -c "import akshare, pandas"`, { stdio: 'ignore' });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `No Python with akshare+pandas found (tried: ${PYTHON_CANDIDATES.join(', ')}). ` +
      'Install via: pip install akshare pandas',
  );
}
