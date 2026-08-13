import { describe, expect, it } from 'vitest';

import { TRACKED_SYMBOLS, symbolFromCode } from '../symbols';

describe('symbol universe', () => {
  it('contains exactly the 6 live ETF symbols in canonical order', () => {
    expect(TRACKED_SYMBOLS.map(s => s.code)).toEqual([
      'sh.511360',
      'sh.511880',
      'sh.511990',
      'sh.510300',
      'sh.510500',
      'sh.515080',
    ]);
  });

  it('has no backtest-proxy role left', () => {
    // Sentinel: widen SymbolRole to `string[]` so this stays a real guard if a
    // future refactor ever re-introduces a 'backtest-proxy' role. Do not remove.
    const roles: readonly string[] = TRACKED_SYMBOLS.map(s => s.role);
    expect(roles.every(r => r !== 'backtest-proxy')).toBe(true);
  });

  it('has 3 safe and 3 ambition symbols with unique codes', () => {
    const codes = TRACKED_SYMBOLS.map(s => s.code);
    expect(new Set(codes).size).toBe(6);
    expect(TRACKED_SYMBOLS.filter(s => s.layer === 'safe')).toHaveLength(3);
    expect(TRACKED_SYMBOLS.filter(s => s.layer === 'ambition')).toHaveLength(3);
  });

  it('symbolFromCode strips the exchange prefix', () => {
    expect(symbolFromCode('sh.510300')).toBe('510300');
  });
});
