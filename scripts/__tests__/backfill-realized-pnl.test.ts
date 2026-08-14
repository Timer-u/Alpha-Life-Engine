import { describe, expect, it } from 'vitest';

import { replayAndGenerateUpdates, type Tx } from '../backfill-realized-pnl';

const txs = (over: Partial<Tx>[]) => over.map((o, i) => ({
  id: i,
  user_id: 1,
  symbol: '511360',
  layer: 'safe',
  shares: 100,
  amount_cents: 100000,
  commission_cents: 500,
  transaction_type: 'buy' as const,
  ...o,
}));

describe('replayAndGenerateUpdates', () => {
  it('computes commission-inclusive realized pnl on sells', () => {
    const { updates } = replayAndGenerateUpdates(
      txs([
        { transaction_type: 'buy', shares: 100, amount_cents: 100000, commission_cents: 500 },
        { transaction_type: 'sell', shares: 20, amount_cents: 25000, commission_cents: 500 },
      ]),
    );
    // avgCents = (100000+500)/100 = 1005 ; cost of 20 = 20100 ; realized = (25000-500) - 20100 = 4400
    expect(updates).toEqual([`UPDATE transactions SET realized_pnl = 4400 WHERE id = 1;`]);
  });

  it('averages commission-inclusive cost across multiple buys', () => {
    const { updates, perKey } = replayAndGenerateUpdates(
      txs([
        { transaction_type: 'buy', shares: 100, amount_cents: 100000, commission_cents: 500 },
        { transaction_type: 'buy', shares: 100, amount_cents: 150000, commission_cents: 1000 },
        { transaction_type: 'sell', shares: 50, amount_cents: 140000, commission_cents: 500 },
      ]),
    );
    // avgCents after buys = (100*1005 + 151000) / 200 = 251500/200 = 1257.5
    // cost of 50 = 62875 ; realized = (140000-500) - 62875 = 76625
    expect(perKey.get('1|511360|safe')).toEqual({ shares: 150, avgCents: 1257.5 });
    expect(updates).toEqual([`UPDATE transactions SET realized_pnl = 76625 WHERE id = 2;`]);
  });

  it('clamps shares at zero and does not emit an update when selling from nothing', () => {
    const { updates, perKey } = replayAndGenerateUpdates(
      txs([
        { transaction_type: 'sell', shares: 20, amount_cents: 25000, commission_cents: 500 },
        { transaction_type: 'buy', shares: 100, amount_cents: 100000, commission_cents: 500 },
        { transaction_type: 'sell', shares: 150, amount_cents: 180000, commission_cents: 500 },
      ]),
    );
    // sell with no holdings: realized = (25000-500) - 0*20 = 24500
    // after buy: 100 shares @1005 ; sell 150 -> shares clamp to 0, cost of 150 = 150750, realized = (180000-500)-150750 = 28750
    expect(updates).toEqual([
      `UPDATE transactions SET realized_pnl = 24500 WHERE id = 0;`,
      `UPDATE transactions SET realized_pnl = 28750 WHERE id = 2;`,
    ]);
    expect(perKey.get('1|511360|safe')?.shares).toBe(0);
  });
});
