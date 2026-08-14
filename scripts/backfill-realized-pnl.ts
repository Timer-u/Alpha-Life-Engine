#!/usr/bin/env node
// Backfill realized_pnl on historical sells and recompute commission-inclusive avg_price.
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

const PROD_FLAGS = ['--prod', '--production', '-p'] as const;

export interface Tx { id: number; user_id: number; symbol: string; layer: string; shares: number; amount_cents: number; commission_cents: number; transaction_type: 'buy' | 'sell'; }

function queryRows(dbName: string, remote: boolean): Tx[] {
  const flag = remote ? '--remote' : '--local';
  const cmd = `wrangler d1 execute ${dbName} --command="SELECT id, user_id, symbol, layer, shares, amount AS amount_cents, commission AS commission_cents, transaction_type FROM transactions ORDER BY user_id, created_at ASC, id ASC" --json ${flag}`;
  const stdout = execSync(cmd, { encoding: 'utf8', timeout: 120000 }).trim();
  const parsed = JSON.parse(stdout) as Array<{ results?: Tx[] }>;
  return parsed[0]?.results ?? [];
}

export function replayAndGenerateUpdates(txs: Tx[]): {
  updates: string[];
  positionUpdates: string[];
  perKey: Map<string, { shares: number; avgCents: number }>;
} {
  const updates: string[] = [];
  const positionUpdates: string[] = [];
  const states = new Map<string, { shares: number; avgCents: number }>();
  for (const tx of txs) {
    const key = `${tx.user_id}|${tx.symbol}|${tx.layer}`;
    const st = states.get(key) ?? { shares: 0, avgCents: 0 };
    if (tx.transaction_type === 'buy') {
      const cost = tx.amount_cents + tx.commission_cents;
      const newShares = st.shares + tx.shares;
      st.avgCents = newShares > 0 ? (st.shares * st.avgCents + cost) / newShares : 0;
      st.shares = newShares;
    } else {
      const realized = Math.round((tx.amount_cents - tx.commission_cents) - st.avgCents * tx.shares);
      updates.push(`UPDATE transactions SET realized_pnl = ${realized} WHERE id = ${tx.id};`);
      st.shares = Math.max(st.shares - tx.shares, 0);
    }
    states.set(key, st);
  }
  for (const [key, st] of states) {
    if (st.shares <= 0) continue;
    const [userId, symbol, layer] = key.split('|');
    positionUpdates.push(
      `UPDATE positions SET avg_price = ${(st.avgCents / 100).toFixed(4)} WHERE user_id = ${userId} AND symbol = '${symbol}' AND layer = '${layer}';`
    );
  }
  return { updates, positionUpdates, perKey: states };
}

export async function backfillRealizedPnl(): Promise<void> {
  const args = process.argv.slice(2);
  const isProd = PROD_FLAGS.some(f => args.includes(f));
  const dbName = isProd ? 'alpha-life-prod' : 'alpha-life-dev';
  console.log(`Backfilling realized_pnl into ${dbName} (${isProd ? 'remote' : 'local'})...`);
  const txs = queryRows(dbName, isProd);
  const { updates, positionUpdates } = replayAndGenerateUpdates(txs);
  const allUpdates = [...updates, ...positionUpdates];
  console.log(`  ${txs.length} transactions, ${updates.length} sells to backfill, ${positionUpdates.length} positions to update`);
  if (allUpdates.length > 0) {
    const sqlPath = resolve(process.cwd(), 'data/backfill_realized_pnl.sql');
    writeFileSync(sqlPath, allUpdates.join('\n'), 'utf8');
    execSync(`wrangler d1 execute ${dbName} --file="${sqlPath}" ${isProd ? '--remote' : '--local'}`, { stdio: 'inherit', timeout: 300000 });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  backfillRealizedPnl().catch(e => { console.error(e); process.exit(1); });
}
