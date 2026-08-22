import type { TrackedSymbol } from './symbols';

/**
 * Generate the Python source that downloads daily bars from AKShare Sina
 * (`fund_etf_hist_sina`) for the given symbols and per-symbol start dates.
 *
 * NOTE: fund_etf_hist_sina has NO server-side date-range parameter — the
 * download is always the symbol's full history; `windows` only filters the
 * returned rows locally (`df[df.date >= start]`). The per-symbol start dates
 * reduce the SQL volume, not the download time.
 *
 * Output CSV columns are pinned to `date,code,open,high,low,close,volume,amount`
 * with `code` in dotted form (e.g. `sh.511360`) — the TS consumers in
 * daily-market-update.ts and market-setup.ts parse by position and depend on
 * this exact shape. Do not reorder or rename columns here.
 */
export function createAkshareFetchScript(
  codes: readonly TrackedSymbol[],
  windows: Record<string, string>,
  outputDir: string
): string {
  const codesJson = JSON.stringify(codes.map(c => [c.code, c.name]));
  const windowsJson = JSON.stringify(windows);
  const safeOutDir = JSON.stringify(outputDir);
  return `import json
import os
import sys
import time

import akshare as ak
import pandas as pd

CODES = ${codesJson}
WINDOWS = ${windowsJson}
OUT_DIR = ${safeOutDir}


def fetch_symbol(code, name, start_date):
    ak_code = code.replace(".", "")
    df = None
    for attempt in range(3):
        try:
            df = ak.fund_etf_hist_sina(symbol=ak_code)
            break
        except Exception as e:
            print(f"[WARN] {name} ({code}) attempt {attempt + 1}/3 failed: {e}", file=sys.stderr)
            if attempt < 2:
                time.sleep(5)
    if df is None or len(df) == 0:
        print(f"[FAIL] {name} ({code}): unreachable or empty after 3 attempts", file=sys.stderr)
        return None
    df = df[["date", "open", "high", "low", "close", "volume", "amount"]].copy()
    df["code"] = code
    df = df[["date", "code", "open", "high", "low", "close", "volume", "amount"]]
    df = df[df["date"].astype(str) >= start_date]
    rows = [
        {
            "date": str(r["date"]),
            "code": code,
            "open": float(r["open"]) if pd.notna(r["open"]) else None,
            "high": float(r["high"]) if pd.notna(r["high"]) else None,
            "low": float(r["low"]) if pd.notna(r["low"]) else None,
            "close": float(r["close"]) if pd.notna(r["close"]) else None,
            "volume": int(r["volume"]) if pd.notna(r["volume"]) else 0,
            "amount": float(r["amount"]) if pd.notna(r["amount"]) else 0.0,
        }
        for _, r in df.iterrows()
    ]
    fname = os.path.join(OUT_DIR, f"{code.replace('.', '_')}.csv")
    df.to_csv(fname, index=False)
    print(f"[OK] {name} ({code}): {len(rows)} rows from {start_date}", file=sys.stderr)
    return rows


results = []
failures = []
for code, name in CODES:
    rows = fetch_symbol(code, name, WINDOWS[code])
    if rows is None:
        failures.append(code)
        continue
    results.extend(rows)

symbols = sorted({r["code"].replace("sh.", "").replace("sz.", "") for r in results})
print(json.dumps({"count": len(results), "symbols": symbols, "failures": failures}))
sys.exit(1 if failures else 0)
`;
}
