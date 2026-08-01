import type { LayerType } from '../../src/types/api';

interface TxRow {
  symbol: string;
  shares: number;
  price: number;
  amount: number;
  commission: number;
  transaction_type: 'buy' | 'sell';
  layer: LayerType;
  created_at: string;
}

export interface PerformancePoint {
  date: string;
  market_value: number;
  invested: number;
  cumulative_gain: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 按日重放交易流水，结合 market_data 收盘价构建单层每日序列：
 * - invested：净投入现金（买入含佣金累加，卖出净回款扣减）
 * - market_value：当日持仓市值（收盘价缺失时沿用最近价格）
 * - cumulative_gain：累计收益 = 市值 - 净投入
 */
export function buildSeries(txs: TxRow[], dates: string[], closes: Map<string, number>): PerformancePoint[] {
  if (txs.length === 0) return [];
  const firstTxDate = txs[0].created_at.slice(0, 10);
  const shares = new Map<string, number>();
  const lastClose = new Map<string, number>();
  let invested = 0;
  let ti = 0;
  const points: PerformancePoint[] = [];

  for (const date of dates) {
    if (date < firstTxDate) continue;
    while (ti < txs.length && txs[ti].created_at.slice(0, 10) <= date) {
      const tx = txs[ti];
      const prev = shares.get(tx.symbol) ?? 0;
      if (tx.transaction_type === 'buy') {
        shares.set(tx.symbol, prev + tx.shares);
        invested += tx.amount + tx.commission;
      } else {
        shares.set(tx.symbol, Math.max(prev - tx.shares, 0));
        invested -= tx.amount - tx.commission;
      }
      if (!lastClose.has(tx.symbol)) lastClose.set(tx.symbol, tx.price);
      ti++;
    }

    let value = 0;
    for (const [sym, sh] of shares) {
      const close = closes.get(`${sym}|${date}`);
      if (close !== undefined) lastClose.set(sym, close);
      value += sh * (lastClose.get(sym) ?? 0);
    }

    points.push({
      date,
      market_value: round2(value),
      invested: round2(invested),
      cumulative_gain: round2(value - invested),
    });
  }
  return points;
}

export async function computeLayerPerformance(db: D1Database, userId: number): Promise<{
  safe: PerformancePoint[];
  ambition: PerformancePoint[];
}> {
  const txResult = await db.prepare(
    `SELECT symbol, shares, price, amount, commission, transaction_type, layer, created_at
     FROM transactions WHERE user_id = ? ORDER BY created_at ASC`
  ).bind(userId).all<TxRow>();
  const txs = txResult.results;
  if (txs.length === 0) return { safe: [], ambition: [] };

  const symbols = [...new Set(txs.map(t => t.symbol))];
  const firstDate = txs[0].created_at.slice(0, 10);

  const placeholders = symbols.map(() => '?').join(',');
  const mdResult = await db.prepare(
    `SELECT symbol, date, close FROM market_data
     WHERE symbol IN (${placeholders}) AND date >= ? AND close IS NOT NULL
     ORDER BY date ASC`
  ).bind(...symbols, firstDate).all<{ symbol: string; date: string; close: number }>();

  const closes = new Map<string, number>();
  const dateSet = new Set<string>();
  for (const row of mdResult.results) {
    closes.set(`${row.symbol}|${row.date}`, row.close);
    dateSet.add(row.date);
  }
  // 交易日期并入日期轴，保证盘后/非交易日录入的交易也被计入
  for (const tx of txs) dateSet.add(tx.created_at.slice(0, 10));
  const dates = [...dateSet].sort();

  return {
    safe: buildSeries(txs.filter(t => t.layer === 'safe'), dates, closes),
    ambition: buildSeries(txs.filter(t => t.layer === 'ambition'), dates, closes),
  };
}
