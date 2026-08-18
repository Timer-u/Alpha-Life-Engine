import { describe, expect, it } from 'vitest';

import { buildSeries } from '../performance';

interface Tx {
  symbol: string;
  shares: number;
  price: number;
  amount_cents: number;
  commission_cents: number;
  transaction_type: 'buy' | 'sell';
  layer: 'safe' | 'ambition';
  trade_date: string;
}

function buy(symbol: string, shares: number, price: number, at: string): Tx {
  return { symbol, shares, price, amount_cents: Math.round(shares * price * 100), commission_cents: 500, transaction_type: 'buy', layer: 'safe', trade_date: at };
}

function sell(symbol: string, shares: number, price: number, at: string): Tx {
  return { symbol, shares, price, amount_cents: Math.round(shares * price * 100), commission_cents: 500, transaction_type: 'sell', layer: 'safe', trade_date: at };
}

describe('buildSeries (integer cents)', () => {
  it('returns an empty series for no transactions', () => {
    expect(buildSeries([], ['2026-01-01'], new Map())).toEqual([]);
  });

  it('tracks invested cash (amount + commission) in cents and marks valuation against it', () => {
    const txs = [buy('A', 10, 100, '2026-01-01')];
    const closes = new Map([['A|2026-01-01', 100], ['A|2026-01-02', 105]]);
    const points = buildSeries(txs, ['2026-01-01', '2026-01-02'], closes);

    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({ date: '2026-01-01', market_value: 100000, invested: 100500, cumulative_gain: -500 });
    expect(points[1]).toEqual({ date: '2026-01-02', market_value: 105000, invested: 100500, cumulative_gain: 4500 });
  });

  it('subtracts net proceeds (amount - commission) from invested on sell', () => {
    const txs = [
      buy('A', 10, 100, '2026-01-01'),
      sell('A', 2, 110, '2026-01-02'),
    ];
    const closes = new Map([['A|2026-01-01', 100], ['A|2026-01-02', 105]]);
    const points = buildSeries(txs, ['2026-01-01', '2026-01-02'], closes);

    expect(points[1]).toEqual({ date: '2026-01-02', market_value: 84000, invested: 79000, cumulative_gain: 5000 });
  });

  it('carries the last known close forward when a date has no close price', () => {
    const txs = [buy('A', 10, 100, '2026-01-01')];
    const closes = new Map([['A|2026-01-01', 100]]);
    const points = buildSeries(txs, ['2026-01-01', '2026-01-02'], closes);

    expect(points[1].market_value).toBe(100000);
  });
});
