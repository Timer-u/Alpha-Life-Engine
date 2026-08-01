import { describe, expect, it } from 'vitest';

import { buildSeries } from '../performance';

interface Tx {
  symbol: string;
  shares: number;
  price: number;
  amount: number;
  commission: number;
  transaction_type: 'buy' | 'sell';
  layer: 'safe' | 'ambition';
  created_at: string;
}

function buy(symbol: string, shares: number, price: number, at: string): Tx {
  return { symbol, shares, price, amount: shares * price, commission: 5, transaction_type: 'buy', layer: 'safe', created_at: at };
}

function sell(symbol: string, shares: number, price: number, at: string): Tx {
  return { symbol, shares, price, amount: shares * price, commission: 5, transaction_type: 'sell', layer: 'safe', created_at: at };
}

describe('buildSeries', () => {
  it('returns an empty series for no transactions', () => {
    expect(buildSeries([], ['2026-01-01'], new Map())).toEqual([]);
  });

  it('tracks invested cash (amount + commission) and marks valuation against it', () => {
    const txs = [buy('A', 10, 100, '2026-01-01T10:00:00Z')];
    const closes = new Map([['A|2026-01-01', 100], ['A|2026-01-02', 105]]);
    const points = buildSeries(txs, ['2026-01-01', '2026-01-02'], closes);

    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ date: '2026-01-01', market_value: 1000, invested: 1005, cumulative_gain: -5 });
    expect(points[1]).toEqual({ date: '2026-01-02', market_value: 1050, invested: 1005, cumulative_gain: 45 });
  });

  it('subtracts net proceeds (amount - commission) from invested on sell', () => {
    const txs = [
      buy('A', 10, 100, '2026-01-01T10:00:00Z'),
      sell('A', 2, 110, '2026-01-02T11:00:00Z'),
    ];
    const closes = new Map([['A|2026-01-01', 100], ['A|2026-01-02', 105]]);
    const points = buildSeries(txs, ['2026-01-01', '2026-01-02'], closes);

    expect(points[1]).toEqual({ date: '2026-01-02', market_value: 840, invested: 790, cumulative_gain: 50 });
  });

  it('carries the last known close forward when a date has no close price', () => {
    const txs = [buy('A', 10, 100, '2026-01-01T10:00:00Z')];
    const closes = new Map([['A|2026-01-01', 100]]);
    const points = buildSeries(txs, ['2026-01-01', '2026-01-02'], closes);

    expect(points[1].market_value).toBe(1000);
  });
});
