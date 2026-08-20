import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

// Real-SQL regression tests for D1 batch semantics.
//
// FakeD1 matches SQL by text and returns canned rows, so it CANNOT catch the
// class of bug where a guarded statement in a D1 batch observes rows written by
// an EARLIER statement in the same batch (D1 batch() executes statements
// sequentially inside ONE SQL transaction). These tests run the ACTUAL batch
// SQL from transaction.ts / portfolio.ts against an in-memory SQLite database
// (node:sqlite DatabaseSync) to prove the real semantics:
//
//   - the audit INSERT must be ordered BEFORE the anchor INSERT (transactions /
//     deposits) so its idempotency guard sees COUNT=0 on first attempt (fires)
//     and COUNT=1 on retry (no-op). If it runs AFTER the anchor, the guard
//     always sees COUNT=1 and the audit row is silently never written.
//
// The SQL strings are duplicated here deliberately (the point is proving D1
// batch semantics, not refactoring the production code). Node >= 22.5 required.

function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      total_balance INTEGER NOT NULL DEFAULT 0, safe_layer_balance INTEGER NOT NULL DEFAULT 0,
      ambition_layer_balance INTEGER NOT NULL DEFAULT 0,
      last_balance_update DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL, name TEXT NOT NULL, shares DECIMAL(15,6) DEFAULT 0,
      avg_price REAL DEFAULT 0, current_price REAL DEFAULT 0, market_value INTEGER NOT NULL DEFAULT 0,
      last_price_update DATETIME DEFAULT CURRENT_TIMESTAMP, layer TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      symbol TEXT NOT NULL, shares DECIMAL(15,6) NOT NULL, price REAL NOT NULL,
      amount INTEGER NOT NULL, commission INTEGER NOT NULL,
      transaction_type TEXT NOT NULL, trigger_signal TEXT, layer TEXT NOT NULL,
      realized_pnl INTEGER, trade_date TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notes TEXT, idempotency_key TEXT, request_nonce TEXT
    );
    CREATE TABLE deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      action TEXT NOT NULL, entity TEXT NOT NULL, old_value TEXT, new_value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_transactions_user_idempotency
      ON transactions(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX idx_deposits_user_key ON deposits(user_id, idempotency_key);
  `);
  return db;
}

// Model D1 batch(): statements execute sequentially inside one transaction.
function runBatch(db: DatabaseSync, statements: Array<{ sql: string; params: SQLInputValue[] }>): void {
  db.exec('BEGIN');
  try {
    for (const stmt of statements) {
      db.prepare(stmt.sql).run(...stmt.params);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function countRows(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { c: number };
  return row.c;
}

const auditSql = (guard: string): string => `INSERT INTO audit_logs (user_id, action, entity, old_value, new_value, created_at)
  SELECT ?, 'transaction', 'transactions', NULL, ?, ?
  WHERE ${guard}
    AND (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0`;

// 判别子：仅当 user+idempotency_key 的行由本批次写入（request_nonce = 本次
// 请求的 UUID）时为 1。锚点 INSERT 最先执行，随后的持仓/资金变更以此判定
// 是否属于本批次 —— 重试/并发重复时锚点被幂等守卫拦截，本判别子为 0 →
// 整批无操作。nonce 每请求唯一，同毫秒的并发重复请求也不会误判。
const batchTxnGuard = `(SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ? AND request_nonce = ?) = 1`;

// BUY path — actual SQL from functions/api/transaction.ts (buy branch).
function buyBatch(params: { user: number; symbol: string; shares: number; price: number; amount: number; commission: number; type: 'buy'; layer: 'safe' | 'ambition'; tradeDate: string; now: string; key: string; nonce: string; totalCost: number; startTotal: number; startSafe: number; startAmbition: number }): Array<{ sql: string; params: SQLInputValue[] }> {
  const audit = {
    sql: auditSql('(SELECT safe_layer_balance FROM portfolio WHERE user_id = ?) >= ?'),
    params: [params.user, JSON.stringify({ symbol: params.symbol, shares: params.shares, price: params.price, amount: params.amount, commission: params.commission, transaction_type: params.type, layer: params.layer, realized_pnl: null, trade_date: params.tradeDate, idempotency_key: params.key }), params.now, params.user, params.totalCost, params.user, params.key],
  } as { sql: string; params: SQLInputValue[] };
  const statements = [
    audit,
    {
      // anchor INSERT FIRST: its balance guard sees the pre-batch balance;
      // subsequent mutations discriminate on this batch's own insert (request_nonce)
      sql: `INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes, idempotency_key, request_nonce)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?
        WHERE (SELECT safe_layer_balance FROM portfolio WHERE user_id = ?) >= ?
          AND (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0
        RETURNING id`,
      params: [params.user, params.symbol, params.shares, params.price, params.amount, params.commission, params.type, null, params.layer, params.tradeDate, params.now, null, params.key, params.nonce, params.user, params.totalCost, params.user, params.key],
    },
    {
      sql: `INSERT INTO positions (user_id, symbol, name, shares, avg_price, current_price, market_value, last_price_update, layer, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT safe_layer_balance FROM portfolio WHERE user_id = ?) >= ?
          AND ${batchTxnGuard}
        RETURNING id`,
      params: [params.user, params.symbol, 'name', params.shares, params.price, params.price, params.amount, params.now, params.layer, params.now, params.now, params.user, params.totalCost, params.user, params.key, params.nonce],
    },
    {
      sql: `UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, last_balance_update = ?, updated_at = ?
        WHERE user_id = ? AND safe_layer_balance >= ?
          AND ${batchTxnGuard}`,
      params: [
        params.startTotal + (params.layer === 'safe' ? -params.totalCost : 0) + (params.layer === 'ambition' ? -params.totalCost : 0),
        params.startSafe + (params.layer === 'safe' ? -params.totalCost : 0),
        params.startAmbition + (params.layer === 'ambition' ? -params.totalCost : 0),
        params.now, params.now, params.user, params.totalCost, params.user, params.key, params.nonce,
      ],
    },
  ] as Array<{ sql: string; params: SQLInputValue[] }>;
  return statements;
}

// SELL path — actual SQL from functions/api/transaction.ts (sell branch).
function sellBatch(params: { user: number; symbol: string; shares: number; price: number; amount: number; commission: number; type: 'sell'; layer: 'safe' | 'ambition'; tradeDate: string; now: string; key: string; nonce: string; realizedPnl: number; positionId: number; startTotal: number; startSafe: number; startAmbition: number }): Array<{ sql: string; params: SQLInputValue[] }> {
  const audit = {
    sql: auditSql('(SELECT shares FROM positions WHERE id = ?) >= ?'),
    params: [params.user, JSON.stringify({ symbol: params.symbol, shares: params.shares, price: params.price, amount: params.amount, commission: params.commission, transaction_type: params.type, layer: params.layer, realized_pnl: params.realizedPnl, trade_date: params.tradeDate, idempotency_key: params.key }), params.now, params.positionId, params.shares, params.user, params.key],
  } as { sql: string; params: SQLInputValue[] };
  const statements = [
    audit,
    {
      // anchor INSERT FIRST: its shares guard sees the pre-batch holdings
      sql: `INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes, idempotency_key, request_nonce)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT shares FROM positions WHERE id = ?) >= ?
          AND (SELECT COUNT(*) FROM transactions WHERE user_id = ? AND idempotency_key = ?) = 0
        RETURNING id`,
      params: [params.user, params.symbol, params.shares, params.price, params.amount, params.commission, params.type, null, params.layer, params.realizedPnl, params.tradeDate, params.now, null, params.key, params.nonce, params.positionId, params.shares, params.user, params.key],
    },
    {
      sql: `UPDATE positions SET shares = shares - ?, current_price = ?, market_value = ?, last_price_update = ?, updated_at = ?
        WHERE id = ? AND shares >= ?
          AND ${batchTxnGuard}`,
      params: [params.shares, params.price, params.amount - params.commission, params.now, params.now, params.positionId, params.shares, params.user, params.key, params.nonce],
    },
    {
      sql: `UPDATE portfolio SET total_balance = ?, safe_layer_balance = ?, ambition_layer_balance = ?, last_balance_update = ?, updated_at = ?
        WHERE user_id = ? AND (SELECT shares FROM positions WHERE id = ?) >= ?
          AND ${batchTxnGuard}`,
      params: [
        params.startTotal + (params.layer === 'safe' ? params.amount - params.commission : 0) + (params.layer === 'ambition' ? params.amount - params.commission : 0),
        params.startSafe + (params.layer === 'safe' ? params.amount - params.commission : 0),
        params.startAmbition + (params.layer === 'ambition' ? params.amount - params.commission : 0),
        params.now, params.now, params.user, params.positionId, params.shares, params.user, params.key, params.nonce,
      ],
    },
  ] as Array<{ sql: string; params: SQLInputValue[] }>;
  return statements;
}

// DEPOSIT path — actual SQL from functions/api/portfolio.ts.
function depositBatch(params: { user: number; amount: number; safeAdded: number; ambitionAdded: number; now: string; key: string }): Array<{ sql: string; params: SQLInputValue[] }> {
  const audit = {
    sql: `INSERT INTO audit_logs (user_id, action, entity, old_value, new_value, created_at)
      SELECT ?, 'deposit', 'portfolio', NULL, ?, ?
      WHERE (SELECT COUNT(*) FROM deposits WHERE user_id = ? AND idempotency_key = ?) = 0`,
    params: [params.user, JSON.stringify({ amount_cents: params.amount, idempotency_key: params.key, safe_added_cents: params.safeAdded, ambition_added_cents: params.ambitionAdded }), params.now, params.user, params.key],
  } as { sql: string; params: SQLInputValue[] };
  const statements = [
    audit,
    {
      sql: `UPDATE portfolio
        SET total_balance = total_balance + ?, safe_layer_balance = safe_layer_balance + ?,
            ambition_layer_balance = ambition_layer_balance + ?, last_balance_update = ?, updated_at = ?
        WHERE user_id = ?
          AND (SELECT COUNT(*) FROM deposits WHERE user_id = ? AND idempotency_key = ?) = 0
        RETURNING total_balance, safe_layer_balance, ambition_layer_balance`,
      params: [params.amount, params.safeAdded, params.ambitionAdded, params.now, params.now, params.user, params.user, params.key],
    },
    {
      sql: `INSERT INTO deposits (user_id, amount_cents, idempotency_key, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, idempotency_key) DO NOTHING RETURNING id`,
      params: [params.user, params.amount, params.key, params.now],
    },
  ] as Array<{ sql: string; params: SQLInputValue[] }>;
  return statements;
}

const USER = 7;
const KEY = 'tx-key-12345678';
const NOW = '2026-08-19T00:00:00.000Z';
const TRADE_DATE = '2026-08-19';

describe('D1 batch semantics (real SQLite): audit guard ordering', () => {
  it('BUY success: audit fires exactly once, before the txn INSERT', () => {
    const db = createDb();
db.prepare('INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance) VALUES (?,?,?,?)')
      .run(USER, 500000, 500000, 0);

    runBatch(db, buyBatch({ user: USER, symbol: '511360', shares: 100, price: 10, amount: 100000, commission: 500, type: 'buy', layer: 'safe', tradeDate: TRADE_DATE, now: NOW, key: KEY, nonce: 'nonce-1', totalCost: 100500, startTotal: 500000, startSafe: 500000, startAmbition: 0 }));

    expect(countRows(db, 'SELECT COUNT(*) AS c FROM audit_logs')).toBe(1);
    const audit = db.prepare('SELECT action, entity, new_value FROM audit_logs').get() as { action: string; entity: string; new_value: string };
    expect(audit.action).toBe('transaction');
    expect(audit.entity).toBe('transactions');
expect(JSON.parse(audit.new_value)).toMatchObject({ symbol: '511360', idempotency_key: KEY, transaction_type: 'buy' });
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM transactions')).toBe(1);
    // first run MUST mutate: position created, safe balance debited (total 100500)
    const position = db.prepare('SELECT shares AS s FROM positions WHERE user_id = ?').get(USER) as { s: number };
    expect(position.s).toBe(100);
    const balance = db.prepare('SELECT safe_layer_balance AS b FROM portfolio WHERE user_id = ?').get(USER) as { b: number };
    expect(balance.b).toBe(500000 - 100500);
  });

it('BUY duplicate retry (same idempotency_key, row pre-inserted): zero new audit rows, no double mutation', () => {
    const db = createDb();
    db.prepare('INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance) VALUES (?,?,?,?)')
      .run(USER, 500000, 500000, 0);
    db.prepare(`INSERT INTO positions (user_id, symbol, name, shares, avg_price, current_price, market_value, last_price_update, layer, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(USER, '511360', 'name', 100, 10, 10, 100000, NOW, 'safe', NOW, NOW);
    db.prepare(`INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?)`)
      .run(USER, '511360', 100, 10, 100000, 500, 'buy', 'safe', TRADE_DATE, NOW, KEY);

    runBatch(db, buyBatch({ user: USER, symbol: '511360', shares: 100, price: 10, amount: 100000, commission: 500, type: 'buy', layer: 'safe', tradeDate: TRADE_DATE, now: NOW, key: KEY, nonce: 'nonce-1', totalCost: 100500, startTotal: 500000, startSafe: 500000, startAmbition: 0 }));

    expect(countRows(db, 'SELECT COUNT(*) AS c FROM audit_logs')).toBe(0);
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM transactions')).toBe(1);
    // the whole batch is a no-op on duplicate: no new position row, shares and balance untouched
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM positions')).toBe(1);
    const shares = db.prepare('SELECT shares AS s FROM positions WHERE user_id = ?').get(USER) as { s: number };
    expect(shares.s).toBe(100);
    const balance = db.prepare('SELECT safe_layer_balance AS b FROM portfolio WHERE user_id = ?').get(USER) as { b: number };
    expect(balance.b).toBe(500000);
  });

  it('BUY concurrent duplicate (same key, same millisecond, different request_nonce): second batch is a full no-op', () => {
    const db = createDb();
    db.prepare('INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance) VALUES (?,?,?,?)')
      .run(USER, 500000, 500000, 0);

    runBatch(db, buyBatch({ user: USER, symbol: '511360', shares: 100, price: 10, amount: 100000, commission: 500, type: 'buy', layer: 'safe', tradeDate: TRADE_DATE, now: NOW, key: KEY, nonce: 'nonce-A', totalCost: 100500, startTotal: 500000, startSafe: 500000, startAmbition: 0 }));
    // concurrent duplicate: SAME idempotency_key AND same created_at timestamp,
    // but a different request nonce (the losing request's own UUID) — must no-op
    runBatch(db, buyBatch({ user: USER, symbol: '511360', shares: 100, price: 10, amount: 100000, commission: 500, type: 'buy', layer: 'safe', tradeDate: TRADE_DATE, now: NOW, key: KEY, nonce: 'nonce-B', totalCost: 100500, startTotal: 500000, startSafe: 500000, startAmbition: 0 }));

    expect(countRows(db, 'SELECT COUNT(*) AS c FROM audit_logs')).toBe(1);
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM transactions')).toBe(1);
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM positions')).toBe(1);
    const shares = db.prepare('SELECT shares AS s FROM positions WHERE user_id = ?').get(USER) as { s: number };
    expect(shares.s).toBe(100);
    const balance = db.prepare('SELECT safe_layer_balance AS b FROM portfolio WHERE user_id = ?').get(USER) as { b: number };
    expect(balance.b).toBe(500000 - 100500);
  });

  it('BUY insufficient funds (balance guard fails): zero audit rows', () => {
    const db = createDb();
db.prepare('INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance) VALUES (?,?,?,?)')
      .run(USER, 1000, 1000, 0);

    runBatch(db, buyBatch({ user: USER, symbol: '511360', shares: 100, price: 10, amount: 100000, commission: 500, type: 'buy', layer: 'safe', tradeDate: TRADE_DATE, now: NOW, key: KEY, nonce: 'nonce-1', totalCost: 100500, startTotal: 1000, startSafe: 1000, startAmbition: 0 }));

    expect(countRows(db, 'SELECT COUNT(*) AS c FROM audit_logs')).toBe(0);
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM transactions')).toBe(0);
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM positions')).toBe(0);
    const balance = db.prepare('SELECT safe_layer_balance AS b FROM portfolio WHERE user_id = ?').get(USER) as { b: number };
    expect(balance.b).toBe(1000);
  });

  it('SELL success: audit fires exactly once, before the txn INSERT', () => {
    const db = createDb();
    db.prepare('INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance) VALUES (?,?,?,?)')
      .run(USER, 1000, 1000, 0);
    db.prepare(`INSERT INTO positions (user_id, symbol, name, shares, avg_price, current_price, market_value, last_price_update, layer, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(USER, '511360', 'name', 100, 10, 10, 100000, NOW, 'safe', NOW, NOW);
    const positionId = (db.prepare('SELECT id FROM positions WHERE user_id = ?').get(USER) as { id: number }).id;

    runBatch(db, sellBatch({ user: USER, symbol: '511360', shares: 10, price: 10, amount: 10000, commission: 500, type: 'sell', layer: 'safe', tradeDate: TRADE_DATE, now: NOW, key: KEY, nonce: 'nonce-1', realizedPnl: 9500, positionId, startTotal: 1000, startSafe: 1000, startAmbition: 0 }));

    expect(countRows(db, 'SELECT COUNT(*) AS c FROM audit_logs')).toBe(1);
    const audit = db.prepare('SELECT action, entity, new_value FROM audit_logs').get() as { action: string; entity: string; new_value: string };
    expect(audit.action).toBe('transaction');
expect(JSON.parse(audit.new_value)).toMatchObject({ transaction_type: 'sell', idempotency_key: KEY });
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM transactions')).toBe(1);
    // first run MUST mutate: shares debited (100→90), safe balance credited (net 9500)
    const shares = db.prepare('SELECT shares AS s FROM positions WHERE id = ?').get(positionId) as { s: number };
    expect(shares.s).toBe(90);
    const balance = db.prepare('SELECT safe_layer_balance AS b FROM portfolio WHERE user_id = ?').get(USER) as { b: number };
    expect(balance.b).toBe(1000 + 9500);
  });

it('SELL duplicate retry (same idempotency_key, row pre-inserted): zero new audit rows, no double mutation', () => {
    const db = createDb();
    db.prepare('INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance) VALUES (?,?,?,?)')
      .run(USER, 1000, 1000, 0);
    db.prepare(`INSERT INTO positions (user_id, symbol, name, shares, avg_price, current_price, market_value, last_price_update, layer, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(USER, '511360', 'name', 100, 10, 10, 100000, NOW, 'safe', NOW, NOW);
    const positionId = (db.prepare('SELECT id FROM positions WHERE user_id = ?').get(USER) as { id: number }).id;
    db.prepare(`INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, ?)`)
      .run(USER, '511360', 10, 10, 10000, 500, 'sell', 'safe', TRADE_DATE, NOW, KEY);

    runBatch(db, sellBatch({ user: USER, symbol: '511360', shares: 10, price: 10, amount: 10000, commission: 500, type: 'sell', layer: 'safe', tradeDate: TRADE_DATE, now: NOW, key: KEY, nonce: 'nonce-1', realizedPnl: 9500, positionId, startTotal: 1000, startSafe: 1000, startAmbition: 0 }));

    expect(countRows(db, 'SELECT COUNT(*) AS c FROM audit_logs')).toBe(0);
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM transactions')).toBe(1);
    // the whole batch is a no-op on duplicate: shares and balance untouched
    const shares = db.prepare('SELECT shares AS s FROM positions WHERE id = ?').get(positionId) as { s: number };
    expect(shares.s).toBe(100);
    const balance = db.prepare('SELECT safe_layer_balance AS b FROM portfolio WHERE user_id = ?').get(USER) as { b: number };
    expect(balance.b).toBe(1000);
  });

  it('SELL insufficient shares (shares guard fails): zero audit rows', () => {
    const db = createDb();
    db.prepare('INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance) VALUES (?,?,?,?)')
      .run(USER, 1000, 1000, 0);
    db.prepare(`INSERT INTO positions (user_id, symbol, name, shares, avg_price, current_price, market_value, last_price_update, layer, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(USER, '511360', 'name', 5, 10, 10, 5000, NOW, 'safe', NOW, NOW);
    const positionId = (db.prepare('SELECT id FROM positions WHERE user_id = ?').get(USER) as { id: number }).id;

    runBatch(db, sellBatch({ user: USER, symbol: '511360', shares: 10, price: 10, amount: 10000, commission: 500, type: 'sell', layer: 'safe', tradeDate: TRADE_DATE, now: NOW, key: KEY, nonce: 'nonce-1', realizedPnl: 9500, positionId, startTotal: 1000, startSafe: 1000, startAmbition: 0 }));

    expect(countRows(db, 'SELECT COUNT(*) AS c FROM audit_logs')).toBe(0);
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM transactions')).toBe(0);
    const shares = db.prepare('SELECT shares AS s FROM positions WHERE id = ?').get(positionId) as { s: number };
    expect(shares.s).toBe(5);
  });

  it('DEPOSIT success: audit fires exactly once, before the deposits INSERT', () => {
    const db = createDb();
    db.prepare('INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance) VALUES (?,?,?,?)')
      .run(USER, 0, 0, 0);

    runBatch(db, depositBatch({ user: USER, amount: 100000, safeAdded: 60000, ambitionAdded: 40000, now: NOW, key: KEY }));

    expect(countRows(db, 'SELECT COUNT(*) AS c FROM audit_logs')).toBe(1);
    const audit = db.prepare('SELECT action, entity, new_value FROM audit_logs').get() as { action: string; entity: string; new_value: string };
    expect(audit.action).toBe('deposit');
    expect(audit.entity).toBe('portfolio');
    expect(JSON.parse(audit.new_value)).toMatchObject({ amount_cents: 100000, idempotency_key: KEY });
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM deposits')).toBe(1);
    const balance = db.prepare('SELECT total_balance AS t, safe_layer_balance AS s, ambition_layer_balance AS a FROM portfolio WHERE user_id = ?').get(USER) as { t: number; s: number; a: number };
    expect(balance).toEqual({ t: 100000, s: 60000, a: 40000 });
  });

it('DEPOSIT duplicate retry (same idempotency_key, row pre-inserted): zero new audit rows', () => {
    const db = createDb();
    db.prepare('INSERT INTO portfolio (user_id, total_balance, safe_layer_balance, ambition_layer_balance) VALUES (?,?,?,?)')
      .run(USER, 100000, 60000, 40000);
    db.prepare('INSERT INTO deposits (user_id, amount_cents, idempotency_key, created_at) VALUES (?, ?, ?, ?)')
      .run(USER, 100000, KEY, NOW);

    runBatch(db, depositBatch({ user: USER, amount: 100000, safeAdded: 60000, ambitionAdded: 40000, now: NOW, key: KEY }));

    expect(countRows(db, 'SELECT COUNT(*) AS c FROM audit_logs')).toBe(0);
    expect(countRows(db, 'SELECT COUNT(*) AS c FROM deposits')).toBe(1);
    const balance = db.prepare('SELECT total_balance AS t FROM portfolio WHERE user_id = ?').get(USER) as { t: number };
    expect(balance.t).toBe(100000);
  });
});
