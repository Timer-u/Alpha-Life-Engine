#!/usr/bin/env node
/**
 * Versioned migration runner for D1.
 *
 * Replaces the raw `wrangler d1 execute --file=schema.sql` wiring:
 *  1. Applies database/schema.sql as the idempotent baseline (CREATE IF NOT EXISTS).
 *  2. Applies every database/migrations/*.sql that is not yet recorded in the
 *     `schema_migrations` bookkeeping table (created on first run), in filename
 *     order, recording each as it succeeds.
 *
 * Usage:
 *   npm run database:migrate           # development (local D1)
 *   npm run database:migrate:prod      # production (remote D1)
 *
 * First run on a PRE-EXISTING database (migrations were applied manually
 * before this runner existed): tell it the applied watermark, e.g.
 *   tsx scripts/run-migrations.ts --baseline-through=002_money_cents.sql
 * Records everything up to (and including) that file as applied WITHOUT
 * running it — critical because 002 is a destructive data conversion that
 * must never be replayed. Fresh databases need no flag (baseline schema.sql
 * + duplicate-column/idempotent re-runs converge automatically).
 */

import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(process.cwd(), 'database/migrations');
const SCHEMA_FILE = resolve(process.cwd(), 'database/schema.sql');

const args = process.argv.slice(2);
const isProd = args.includes('--prod');
const baselineThrough = args.find(a => a.startsWith('--baseline-through='))?.split('=')[1];
const flag = isProd ? '--remote' : '--local';
const dbName = process.env[isProd ? 'D1_PROD_NAME' : 'D1_DEV_NAME'] ?? (isProd ? 'alpha-life-prod' : 'alpha-life-dev');

function d1(sql: string): string {
  return execSync(
    `wrangler d1 execute ${dbName} --command=${JSON.stringify(sql)} --json ${flag} --env ${isProd ? 'production' : 'development'}`,
    { encoding: 'utf8', timeout: 120000 },
  );
}

function d1File(file: string): void {
  execSync(
    `wrangler d1 execute ${dbName} --file="${file}" ${flag} --env ${isProd ? 'production' : 'development'}`,
    { stdio: 'inherit', timeout: 300000 },
  );
}

function queryAll<T>(sql: string): T[] {
  const stdout = d1(sql).trim();
  const parsed = JSON.parse(stdout) as
    | { result?: Array<{ results?: T[] }> }
    | Array<{ results?: T[] }>;
  const executions = Array.isArray(parsed) ? parsed : parsed.result;
  return executions?.[0]?.results ?? [];
}

function main(): void {
  console.log(`Running migrations against ${dbName} (${isProd ? 'production' : 'development'})`);

  // 0. bookkeeping table (idempotent)
  d1('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)');

  // 1. baseline schema — only for FRESH databases. On an existing DB the
  //    CREATE TABLE IF NOT EXISTS statements are no-ops while newer INDEX
  //    statements can reference columns that only later ALTER migrations add
  //    (exactly the 004/005 case), so re-running the baseline there is wrong;
  //    existing DBs converge purely through the numbered migrations.
  const hasUsers = queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  ).length > 0;
  if (!hasUsers) {
    console.log('  Fresh database: applying baseline schema.sql ...');
    d1File(SCHEMA_FILE);
  } else {
    console.log('  Existing database: skipping baseline schema.sql');
  }

  // 2. numbered migrations not yet applied
  const applied = new Set(queryAll<{ name: string }>('SELECT name FROM schema_migrations').map(r => r.name));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  // bootstrap watermark for pre-existing databases (see header comment)
  if (baselineThrough !== undefined) {
    if (!files.includes(baselineThrough)) {
      throw new Error(`--baseline-through=${baselineThrough} is not a migration file`);
    }
    for (const file of files) {
      if (file > baselineThrough || applied.has(file)) continue;
      console.log(`  Bootstrap: recording ${file} as already applied (not running it)`);
      d1(`INSERT INTO schema_migrations (name) VALUES ('${file}')`);
      applied.add(file);
    }
  }

  if (files.length === 0) {
    console.log('  No migration files found.');
  }
  for (const file of files) {
    if (applied.has(file)) continue;
    console.log(`  Applying ${file} ...`);
    const path = resolve(MIGRATIONS_DIR, file);
    try {
      // --file 是唯一可靠的执行通道（--command 携带多行 CRLF SQL 会失败）
      d1File(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Fresh databases converge via schema.sql (which already contains the
      // additive DDL of earlier migrations): "duplicate column name" /
      // "already exists" means this migration is already reflected — record
      // it and move on. Any other failure is real and aborts the run.
      if (!/duplicate column name|already exists/i.test(message)) {
        throw err;
      }
      console.log(`    already reflected in the current schema; recording as applied`);
    }
    // 记录放在应用之后单独执行（wrangler 单命令原子；未记录的重复应用会
    // 命中上面的 duplicate/already-exists 分支而收敛，破坏性迁移不得重放）
    d1(`INSERT INTO schema_migrations (name) VALUES ('${file}')`);
    applied.add(file);
  }

  const pending = files.filter(f => !applied.has(f));
  console.log(`Migrations complete: ${files.length} file(s) total, ${pending.length} pending.`);
  if (pending.length > 0) {
    throw new Error(`Failed to apply: ${pending.join(', ')}`);
  }
}

main();
