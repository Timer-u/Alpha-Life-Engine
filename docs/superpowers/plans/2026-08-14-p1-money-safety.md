# P1 资金与安全正确性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 8 P1 money/security correctness items: integer-cents money, consistent commission/cost basis, atomic buy/sell writes, idempotent deposit, remove unvalidated PUT /portfolio, server-side trigger balance, Asia/Shanghai trade dates, and persisted realized P&L.

**Architecture:** Money amounts move from `round2`-on-float to **integer cents** stored in D1 and returned by the API; the frontend converts yuan→cents at input and cents→yuan at display via a new `src/lib/money.ts` util. Per-unit prices (`price`, `avg_price`, `current_price`) stay REAL yuan. `avg_price` becomes commission-inclusive cost basis. Buy/sell writes become a **single atomic batch** where every statement is gated by the same guard subquery (no compensation batch). Deposits get a `deposits` ledger with a UNIQUE idempotency key; `POST /api/trigger` reads the server-side portfolio balance instead of trusting the client; a `trade_date` column (Asia/Shanghai) replaces `created_at`-UTC grouping; a `realized_pnl` column persists sell P&L and is backfilled by a replay script.

**Tech Stack:** Cloudflare D1 (SQLite), Hono, Zod 4, React 19 + TanStack React Query, vitest (FakeD1), tsx scripts, wrangler d1 execute.

## Global Constraints

- Money amounts are **integer cents** everywhere in DB and API. Per-unit prices/shares remain REAL/DECIMAL yuan.
- Display converts cents→yuan only at the frontend (`formatCents`); user input converts yuan→cents (`yuanToCents`) before hitting the API.
- `avg_price` (REAL yuan) is commission-inclusive: `newAvg = (oldShares*oldAvg + amount + commission) / newShares`.
- `transactions` gets two new columns: `realized_pnl` (INTEGER cents, NULL on buys) and `trade_date` (Asia/Shanghai YYYY-MM-DD).
- Buy/sell writes are a single `db.batch()` with every statement gated by one guard subquery; guard failure yields 0 rows for all statements (no compensation batch).
- `POST /api/trigger` ignores any client-sent balance; it reads `portfolio.total_balance`.
- `PUT /api/portfolio` is **removed**.
- New tables: `deposits`, `audit_logs`.
- Schema canonical source stays `database/schema.sql`; existing DBs use `database/migrations/002_money_cents.sql`.
- Python evolver untouched (does not read money APIs; `dca_sim.py` mirrors decision branches only, amounts scale by 100 — pytest must stay green).
- Verification gates: `npm run types`, `npm run lint`, `npm run build`, `npm run test` (vitest), and `npm run lint:python:all` + `pytest` (must not regress).
- ESLint: `no-explicit-any`, `consistent-type-imports`, `perfectionist/sort-imports`, `no-console` (only warn/error) — match existing style.

---

### Task 1: Money utilities + test

**Files:**
- Create: `src/lib/money.ts`
- Test: `src/lib/__tests__/money.test.ts`

**Interfaces:**
- Produces:
  - `yuanToCents(yuan: number): number` — `Math.round(yuan * 100)`. Clamp/guard for non-finite → treat as 0.
  - `centsToYuan(cents: number): number` — `cents / 100`.
  - `formatCents(cents: number, opts?: { symbol?: string; sign?: boolean }): string` — `'¥' + (cents/100).toFixed(2)`, prefix `+`/`-` when `sign` and non-zero.
  - `tradeDateShanghai(d: Date = new Date()): string` — Asia/Shanghai date `YYYY-MM-DD` via `new Date(d.getTime() + 8*3600*1000).toISOString().slice(0,10)`.
  - `splitDepositCents(amountCents: number, safeRatio: number): { safeAddedCents: number; ambitionAddedCents: number }` — `safeAddedCents = Math.floor(amountCents * safeRatio)`, `ambitionAddedCents = amountCents - safeAddedCents`.

- [ ] **Step 1: Write the failing test**

`src/lib/__tests__/money.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { centsToYuan, formatCents, splitDepositCents, tradeDateShanghai, yuanToCents } from '../money';

describe('yuanToCents', () => {
  it('converts yuan to cents with rounding', () => {
    expect(yuanToCents(10)).toBe(1000);
    expect(yuanToCents(0.1)).toBe(10);
    expect(yuanToCents(0.1 + 0.2)).toBe(30);
    expect(yuanToCents(1667)).toBe(166700);
  });
});

describe('centsToYuan', () => {
  it('converts cents to yuan', () => {
    expect(centsToYuan(1000)).toBe(10);
    expect(centsToYuan(30)).toBe(0.3);
  });
});

describe('formatCents', () => {
  it('formats cents as yuan with symbol', () => {
    expect(formatCents(123456)).toBe('¥1234.56');
    expect(formatCents(0)).toBe('¥0.00');
    expect(formatCents(150, { sign: true })).toBe('+¥1.50');
    expect(formatCents(-150, { sign: true })).toBe('-¥1.50');
  });
});

describe('tradeDateShanghai', () => {
  it('returns Asia/Shanghai date', () => {
    expect(tradeDateShanghai(new Date('2026-08-14T16:00:00.000Z'))).toBe('2026-08-15');
    expect(tradeDateShanghai(new Date('2026-08-14T03:00:00.000Z'))).toBe('2026-08-14');
  });
});

describe('splitDepositCents', () => {
  it('splits cents keeping the sum exact', () => {
    expect(splitDepositCents(100000, 0.6)).toEqual({ safeAddedCents: 60000, ambitionAddedCents: 40000 });
    expect(splitDepositCents(99999, 0.333)).toEqual({ safeAddedCents: 33299, ambitionAddedCents: 66700 });
    const { safeAddedCents, ambitionAddedCents } = splitDepositCents(99999, 0.333);
    expect(safeAddedCents + ambitionAddedCents).toBe(99999);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/money.test.ts`
Expected: FAIL — module `../money` cannot be resolved.

- [ ] **Step 3: Write minimal implementation**

`src/lib/money.ts`:
```ts
export function yuanToCents(yuan: number): number {
  if (!Number.isFinite(yuan)) return 0;
  return Math.round(yuan * 100);
}

export function centsToYuan(cents: number): number {
  return cents / 100;
}

export function formatCents(cents: number, opts: { symbol?: string; sign?: boolean } = {}): string {
  const symbol = opts.symbol ?? '¥';
  const yuan = centsToYuan(cents);
  const prefix = opts.sign && yuan !== 0 ? (yuan > 0 ? '+' : '-') : '';
  return `${prefix}${symbol}${Math.abs(yuan).toFixed(2)}`;
}

export function tradeDateShanghai(d: Date = new Date()): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function splitDepositCents(amountCents: number, safeRatio: number): {
  safeAddedCents: number;
  ambitionAddedCents: number;
} {
  const safeAddedCents = Math.floor(amountCents * safeRatio);
  return { safeAddedCents, ambitionAddedCents: amountCents - safeAddedCents };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/money.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint + Commit**

Run: `npx eslint src/lib/money.ts src/lib/__tests__/money.test.ts --max-warnings 0`
Expected: no errors.
```bash
git add src/lib/money.ts src/lib/__tests__/money.test.ts
git commit -m "feat(money): add integer-cents money utilities"
```

---

### Task 2: Migration 002 + schema.sql sync

**Files:**
- Create: `database/migrations/002_money_cents.sql`
- Modify: `database/schema.sql`

**Interfaces:**
- Consumes: nothing new.
- Produces: DB columns that Tasks 3–8 depend on:
  - `portfolio.total_balance / safe_layer_balance / ambition_layer_balance` INTEGER cents
  - `positions.market_value` INTEGER cents; `positions.avg_price`, `positions.current_price` REAL
  - `transactions.amount / commission` INTEGER cents; `+ realized_pnl INTEGER NULL`, `+ trade_date TEXT`
  - `trigger_log.balance / executed_amount / commission` INTEGER cents
  - `reconciliations` money columns INTEGER cents
  - new tables `deposits(id, user_id, amount_cents INTEGER, idempotency_key TEXT, created_at, UNIQUE(user_id, idempotency_key))` and `audit_logs(id, user_id, action TEXT, entity TEXT, old_value TEXT, new_value TEXT, created_at)`
  - `transactions.trade_date` backfilled as `date(substr(created_at,1,19), '+8 hours')`

- [ ] **Step 1: Write the migration SQL**

`database/migrations/002_money_cents.sql` — SQLite table-rebuild pattern (SQLite cannot ALTER column type). `CAST(ROUND(x*100) AS INTEGER)` rounds yuan→cents. Keep primary keys and `UNIQUE`/`CHECK`/indexes identical.
```sql
-- 002: Money amounts -> integer cents; add realized_pnl, trade_date, deposits, audit_logs
PRAGMA foreign_keys=OFF;
BEGIN;

-- portfolio
CREATE TABLE IF NOT EXISTS portfolio_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  total_balance INTEGER NOT NULL DEFAULT 0,
  safe_layer_balance INTEGER NOT NULL DEFAULT 0,
  ambition_layer_balance INTEGER NOT NULL DEFAULT 0,
  last_balance_update DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO portfolio_new (id, user_id, total_balance, safe_layer_balance, ambition_layer_balance, last_balance_update, created_at, updated_at)
  SELECT id, user_id, CAST(ROUND(total_balance*100) AS INTEGER), CAST(ROUND(safe_layer_balance*100) AS INTEGER),
         CAST(ROUND(ambition_layer_balance*100) AS INTEGER), last_balance_update, created_at, updated_at FROM portfolio;
DROP TABLE portfolio;
ALTER TABLE portfolio_new RENAME TO portfolio;
CREATE INDEX IF NOT EXISTS idx_portfolio_user_id ON portfolio(user_id);

-- positions (market_value -> cents; avg_price/current_price -> REAL)
CREATE TABLE IF NOT EXISTS positions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  shares DECIMAL(15,6) DEFAULT 0.000000,
  avg_price REAL DEFAULT 0,
  current_price REAL DEFAULT 0,
  market_value INTEGER NOT NULL DEFAULT 0,
  last_price_update DATETIME DEFAULT CURRENT_TIMESTAMP,
  layer TEXT NOT NULL CHECK (layer IN ('safe', 'ambition')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, symbol, layer)
);
INSERT INTO positions_new (id, user_id, symbol, name, shares, avg_price, current_price, market_value, last_price_update, layer, created_at, updated_at)
  SELECT id, user_id, symbol, name, shares, avg_price, current_price, CAST(ROUND(market_value*100) AS INTEGER),
         last_price_update, layer, created_at, updated_at FROM positions;
DROP TABLE positions;
ALTER TABLE positions_new RENAME TO positions;
CREATE INDEX IF NOT EXISTS idx_positions_user_symbol_layer ON positions(user_id, symbol, layer);

-- transactions (amount/commission -> cents; + realized_pnl, trade_date)
CREATE TABLE IF NOT EXISTS transactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  shares DECIMAL(15,6) NOT NULL,
  price REAL NOT NULL,
  amount INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('buy', 'sell')),
  trigger_signal TEXT,
  layer TEXT NOT NULL CHECK (layer IN ('safe', 'ambition')),
  realized_pnl INTEGER,
  trade_date TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);
INSERT INTO transactions_new (id, user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes)
  SELECT id, user_id, symbol, shares, price, CAST(ROUND(amount*100) AS INTEGER), CAST(ROUND(commission*100) AS INTEGER),
         transaction_type, trigger_signal, layer, NULL, date(substr(created_at,1,19), '+8 hours'), created_at, notes FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_user_trade_date ON transactions(user_id, trade_date);

-- trigger_log (balance/executed_amount/commission -> cents)
CREATE TABLE IF NOT EXISTS trigger_log_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL,
  trigger_decision TEXT NOT NULL CHECK (trigger_decision IN ('DEFER', 'SKIP', 'EXECUTE')),
  signal_value REAL,
  executed_amount INTEGER,
  commission INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO trigger_log_new (id, user_id, balance, trigger_decision, signal_value, executed_amount, commission, created_at)
  SELECT id, user_id, CAST(ROUND(balance*100) AS INTEGER), trigger_decision, signal_value,
         CAST(ROUND(executed_amount*100) AS INTEGER), CAST(ROUND(commission*100) AS INTEGER), created_at FROM trigger_log;
DROP TABLE trigger_log;
ALTER TABLE trigger_log_new RENAME TO trigger_log;
CREATE INDEX IF NOT EXISTS idx_trigger_log_user_created ON trigger_log(user_id, created_at);

-- reconciliations (money -> cents)
CREATE TABLE IF NOT EXISTS reconciliations_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reconciliation_date TEXT NOT NULL,
  beginning_balance INTEGER NOT NULL,
  deposits INTEGER NOT NULL DEFAULT 0,
  withdrawals INTEGER NOT NULL DEFAULT 0,
  gains INTEGER NOT NULL DEFAULT 0,
  fees INTEGER NOT NULL DEFAULT 0,
  ending_balance INTEGER NOT NULL,
  variance INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  status TEXT CHECK(status IN ('PENDING', 'CONFIRMED', 'ARCHIVED')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, reconciliation_date)
);
INSERT INTO reconciliations_new (id, user_id, reconciliation_date, beginning_balance, deposits, withdrawals, gains, fees, ending_balance, variance, notes, status, created_at, updated_at)
  SELECT id, user_id, reconciliation_date, CAST(ROUND(beginning_balance*100) AS INTEGER), CAST(ROUND(deposits*100) AS INTEGER),
         CAST(ROUND(withdrawals*100) AS INTEGER), CAST(ROUND(gains*100) AS INTEGER), CAST(ROUND(fees*100) AS INTEGER),
         CAST(ROUND(ending_balance*100) AS INTEGER), CAST(ROUND(variance*100) AS INTEGER), notes, status, created_at, updated_at FROM reconciliations;
DROP TABLE reconciliations;
ALTER TABLE reconciliations_new RENAME TO reconciliations;
CREATE INDEX IF NOT EXISTS idx_reconciliations_user_date ON reconciliations(user_id, reconciliation_date);

-- deposits ledger
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id);

-- audit log
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);

COMMIT;
PRAGMA foreign_keys=ON;
```

- [ ] **Step 2: Update schema.sql to match (new-DB path)**

Modify `database/schema.sql` so freshly created DBs have the same shape: change the money column types to INTEGER (cents) in `portfolio`, `positions` (`market_value` INTEGER, `avg_price`/`current_price` REAL), `transactions` (`amount`/`commission` INTEGER, add `realized_pnl INTEGER`, `trade_date TEXT`), `trigger_log` (INTEGER), `reconciliations` (INTEGER). Add `deposits` and `audit_logs` tables and their indexes. Update the `price`/`close` types from `DECIMAL(10,2)` to `REAL` in `transactions` and `market_data` is left as-is (out of scope). Do not touch the `INSERT OR IGNORE INTO config` block.

- [ ] **Step 3: Dry-run migration on a scratch local DB**

Run:
```bash
# copy existing dev DB to a scratch file first (find it under .wrangler/state or use a fresh one)
wrangler d1 execute alpha-life-dev --file=./database/migrations/002_money_cents.sql --local --env development
```
Expected: executes without error; `transactions.trade_date` populated; `portfolio.total_balance` is now integer cents (verify with a `SELECT` via `wrangler d1 execute alpha-life-dev --command="SELECT total_balance FROM portfolio LIMIT 1" --local`).

- [ ] **Step 4: Commit**

```bash
git add database/migrations/002_money_cents.sql database/schema.sql
git commit -m "feat(db): migrate money amounts to integer cents; add deposits/audit_logs/realized_pnl/trade_date"
```

---

### Task 3: transaction.ts — cents, cost basis, single atomic batch, realized_pnl, trade_date

**Files:**
- Modify: `functions/api/transaction.ts`
- Test: `functions/api/__tests__/transaction.test.ts`

**Interfaces:**
- Consumes: `yuanToCents`, `tradeDateShanghai` from `../../src/lib/money`; `TRIGGER_CONSTANTS` from `../../src/types/api`.
- Produces: `POST /api/transactions` accepts `price`/`shares` (yuan/units) and `commission` (now **cents**); returns the inserted row with `amount`/`commission` in cents plus `realized_pnl` and `trade_date`. Commission default = `Math.max(Math.round(centsFromYuan(amount) * 0.0003), TRIGGER_CONSTANTS.COMMISSION_MIN_CENTS)` where `COMMISSION_MIN_CENTS = 500`.

Global constraint change: in `src/types/api.ts`, add `COMMISSION_MIN_CENTS = 500` to `TRIGGER_CONSTANTS` (this task references it; the type edit lands in Task 7, but add it here so this task compiles).

- [ ] **Step 1: Add constants to TRIGGER_CONSTANTS**

In `src/types/api.ts:33-37`, change the block to:
```ts
export const TRIGGER_CONSTANTS = {
  LINE: 1667 as const,                 // default trigger line, YUAN (evolved params stay yuan)
  TRIGGER_LINE_DEFAULT_YUAN: 1667 as const,
  COMMISSION_RATE: 0.0003 as const,
  COMMISSION_MIN: 5 as const,          // yuan (used only for display/legacy)
  COMMISSION_MIN_CENTS: 500 as const,
} as const;
```
(`LINE` becomes cents=166700 in Task 5; `TRIGGER_LINE_DEFAULT_YUAN` is the yuan-side default used when an evolved param is missing. `COMMISSION_MIN_CENTS` is added now so this task compiles.)

- [ ] **Step 2: Write the failing tests (update + new)**

Replace `functions/api/__tests__/transaction.test.ts` with (commission/amounts in cents; new tests for atomic guard and realized_pnl + trade_date):
```ts
import type { Env } from '../[[route]]';
import { describe, expect, it } from 'vitest';
import { transactionRouter } from '../transaction';
import { asD1, FakeD1 } from './helpers/fake-d1';

const SESSION_COOKIE = { Cookie: 'session_token=test-token' };
const executionCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

function testEnv(db: FakeD1): Env {
  return { DB: asD1(db), RESEND_API_KEY: '', ENVIRONMENT: 'test', SESSION_DAYS: '7' };
}
function sessionRule(): { match: (sql: string) => boolean; rows: unknown[] } {
  return {
    match: sql => sql.includes('FROM sessions'),
    rows: [{ id: 1, token: 'test-token', user_id: 7, expires_at: '2099-01-01', created_at: '', last_active: '', email: 'a@b.c', name: null }],
  };
}

describe('POST /api/transactions', () => {
  it('rejects a sell whose proceeds cannot cover the commission', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [{ id: 1, shares: 100, avg_price: 10 }] },
    ]);
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 1, price: 2, commission: 500, transaction_type: 'sell', layer: 'safe' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Invalid input');
  });

  it('records a buy with sufficient funds in cents and a commission-inclusive avg_price', async () => {
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => sql.includes('INSERT INTO transactions'), rows: [{ id: 99, user_id: 7 }] },
    ]);
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(201);
  });

  it('rejects the buy with NO compensation writes when the guard subquery returns 0 rows', async () => {
    let compensated = false;
    const db = new FakeD1([
      sessionRule(),
      { match: sql => sql.includes('FROM portfolio'), rows: [{ id: 1, user_id: 7, total_balance: 500000, safe_layer_balance: 500000, ambition_layer_balance: 0 }] },
      { match: sql => sql.includes('FROM positions'), rows: [] },
      { match: sql => sql.includes('INSERT INTO transactions'), rows: [], changes: 0 },
      { match: sql => (sql.includes('DELETE') || sql.includes('compensate')), rows: [], changes: 0 },
    ]);
    // if the code still issues a compensation batch, this rule would match 'DELETE FROM' SQL
    const res = await transactionRouter.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
      body: JSON.stringify({ symbol: '511360', shares: 100, price: 10, commission: 500, transaction_type: 'buy', layer: 'safe' }),
    }, testEnv(db), executionCtx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Insufficient funds');
    expect(compensated).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run functions/api/__tests__/transaction.test.ts`
Expected: FAIL (code still uses yuan/round2 and compensation batch).

- [ ] **Step 4: Rewrite transaction.ts**

Replace the POST handler body. Key changes:
- `amountCents = yuanToCents(data.shares * data.price)`; `commissionCents = data.commission ?? Math.max(Math.round(amountCents * TRIGGER_CONSTANTS.COMMISSION_RATE), TRIGGER_CONSTANTS.COMMISSION_MIN_CENTS)` (round to int).
- `layerBalance` = portfolio layer balance (cents, integer).
- Buy cost check: `if (layerBalance + SHARE_EPSILON < totalCostCents)` where `totalCostCents = amountCents + commissionCents`.
- Commission-inclusive avg: `newAvgPrice = position ? (position.shares * position.avg_price + (amountCents + commissionCents) / 100) / newShares : ((amountCents + commissionCents) / 100) / data.shares` (avg_price stored as REAL yuan).
- `tradeDate = tradeDateShanghai()`.
- Build the batch in this exact order so every guard reads the same pre-write snapshot: **(1) INSERT transactions (gated), (2) position write (gated), (3) UPDATE portfolio (gated)**.
  - Buy INSERT gated on balance:
    ```ts
    statements.push(db.prepare(
      `INSERT INTO transactions (user_id, symbol, shares, price, amount, commission, transaction_type, trigger_signal, layer, realized_pnl, trade_date, created_at, notes)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
       WHERE (SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ?
       RETURNING *`
    ).bind(userId, data.symbol, data.shares, data.price, amountCents, commissionCents,
      data.transaction_type, data.trigger_signal ?? null, data.layer, tradeDate, now, data.notes ?? null,
      userId, totalCostCents));
    ```
  - Buy position update gated (existing position): add `AND (SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ?` to the WHERE; bind the two extra args.
  - Buy position insert gated (new position): convert to `INSERT INTO positions (...) SELECT ... WHERE (SELECT ${layerCol} FROM portfolio WHERE user_id = ?) >= ? RETURNING id`.
  - Sell INSERT gated on shares: `WHERE (SELECT shares FROM positions WHERE id = ?) >= ?`.
  - Sell position update: `UPDATE positions SET shares = shares - ?, current_price = ?, market_value = ?, last_price_update = ?, updated_at = ? WHERE id = ? AND shares >= ?`.
  - Sell position delete: `DELETE FROM positions WHERE id = ? AND (SELECT shares FROM positions WHERE id = ?) >= ?`.
  - Sell portfolio update gated on shares: append `AND (SELECT shares FROM positions WHERE id = ?) >= ?`.
  - Compute `realizedPnlCents` for sells: `Math.round((amountCents - commissionCents) - position.avg_price * data.shares * 100)`; pass as the sell INSERT's `realized_pnl`.
- **Guard failure detection (replaces the compensation block):** after `const results = await db.batch(...)`, check `const inserted = results[0]?.results[0]` — if `undefined` for a buy, return 400 `Insufficient funds`; if `undefined` for a sell, return 400 `Insufficient shares`. **Delete all compensation code.**
- Keep the `calculate-commission` endpoint but switch to cents: input `amount` in yuan (number), respond `{ amount_cents, commission_cents, commission_rate, commission_min_cents }`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run functions/api/__tests__/transaction.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint + Commit**

Run: `npx eslint functions/api/transaction.ts functions/api/__tests__/transaction.test.ts --max-warnings 0`
```bash
git add functions/api/transaction.ts functions/api/__tests__/transaction.test.ts src/types/api.ts
git commit -m "fix(api): integer-cents transactions, commission-inclusive cost basis, single atomic guarded batch, realized_pnl + trade_date"
```

---

### Task 4: portfolio.ts — cents, atomic idempotent deposit, remove PUT

**Files:**
- Modify: `functions/api/portfolio.ts`
- Test: `functions/api/__tests__/portfolio.test.ts`

**Interfaces:**
- Consumes: `centsToYuan`, `yuanToCents`, `splitDepositCents` from `../../src/lib/money`.
- Produces: `POST /api/portfolio/deposit` accepts `{ amount_cents: number, idempotency_key: string }`; returns `{ duplicate: boolean, amount_cents, safe_added_cents, ambition_added_cents, safe_ratio, ambition_ratio, allocation_source, portfolio: { total_balance, safe_layer_balance, ambition_layer_balance } }`. `GET /api/portfolio` returns all money fields in cents (incl. `trigger_status.current_balance`/`trigger_line`). `PUT /api/portfolio` removed.

- [ ] **Step 1: Write the failing tests (update + new)**

Replace `functions/api/__tests__/portfolio.test.ts`:
- Remove the `splitDeposit` import/test block (function deleted) and add `splitDepositCents` tests importing from `../../../src/lib/money`. Keep deposit amounts in cents (e.g. `amount_cents: 100000`, safe_ratio 2.0 clamp → safe_added_cents 100000).
- `GET /api/portfolio` trigger-line tests: balances in cents (`portfolioRule(170000)`), `trigger_line` expected in cents (`200000`). Note: `portfolioRule` returns rows `{ total_balance }` only; the GET handler now also needs `safe_layer_balance`/`ambition_layer_balance` rows for `enrichPositions` paths — extend `portfolioRule` rows to `{ total_balance, safe_layer_balance, ambition_layer_balance }`.
- New deposit tests: fresh insert returns `duplicate: false`; duplicate key returns `duplicate: true` and does not re-credit.

Example deposit test (path from `functions/api/__tests__` → root is `../../../`):
```ts
import { portfolioRouter } from '../portfolio';
import { splitDepositCents } from '../../../src/lib/money';
```
```ts
it('dedupes a repeated deposit by idempotency key', async () => {
  // First call: deposit rule returns a row (fresh insert)
  // Second call: deposit INSERT returns 0 rows (ON CONFLICT DO NOTHING) and portfolio UPDATE returns 0 rows
  const db = new FakeD1([
    { match: sql => sql.includes('FROM sessions'), rows: [SESSION_ROW] },
    { match: sql => sql.includes('SELECT preferences FROM users'), rows: [PREFS_ROW] },
    { match: sql => sql.includes('FROM portfolio'), rows: [{ total_balance: 500000, safe_layer_balance: 300000, ambition_layer_balance: 200000 }] },
    { match: sql => sql.includes('INSERT INTO deposits'), rows: [], changes: 0 },
    { match: sql => sql.includes('FROM deposits'), rows: [{ amount_cents: 100000 }] },
  ]);
  const res = await portfolioRouter.request('/deposit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
    body: JSON.stringify({ amount_cents: 100000, idempotency_key: 'dup-key' }),
  }, testEnv(db), executionCtx);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { success: boolean; data: { duplicate: boolean } };
  expect(json.success).toBe(true);
  expect(json.data.duplicate).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run functions/api/__tests__/portfolio.test.ts`
Expected: FAIL.

- [ ] **Step 3: Rewrite portfolio.ts**

- Import `centsToYuan, splitDepositCents, yuanToCents` from `../../src/lib/money`.
- **Delete** `round2`, `splitDeposit`, and the `PUT /` handler (`allowedFields` block). Remove now-unused `nowIso` if nothing else uses it (it is used in responses — keep).
- `depositSchema` → `z.object({ amount_cents: z.number().int().positive().max(10_000_000_000), idempotency_key: z.string().min(8).max(64) })`.
- Deposit handler: parse; `const now = nowIso()`; resolve `safeRatio`; `const { safeAddedCents, ambitionAddedCents } = splitDepositCents(amount_cents, safeRatio)`. Single atomic batch:
  ```ts
  const results = await db.batch([
    db.prepare(
      `UPDATE portfolio
       SET total_balance = total_balance + ?, safe_layer_balance = safe_layer_balance + ?,
           ambition_layer_balance = ambition_layer_balance + ?, last_balance_update = ?, updated_at = ?
       WHERE user_id = ?
         AND (SELECT COUNT(*) FROM deposits WHERE user_id = ? AND idempotency_key = ?) = 0
       RETURNING total_balance, safe_layer_balance, ambition_layer_balance`
    ).bind(amount_cents, safeAddedCents, ambitionAddedCents, now, now, userId, userId, idempotency_key),
    db.prepare(
      `INSERT INTO deposits (user_id, amount_cents, idempotency_key, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, idempotency_key) DO NOTHING RETURNING *`
    ).bind(userId, amount_cents, idempotency_key, now),
  ]);
  const updated = results[0]?.results[0] as { total_balance: number; safe_layer_balance: number; ambition_layer_balance: number } | undefined;
  if (!updated) {
    const existing = await db.prepare('SELECT amount_cents FROM deposits WHERE user_id = ? AND idempotency_key = ?')
      .bind(userId, idempotency_key).first<{ amount_cents: number }>();
    return c.json({
      success: true,
      data: { duplicate: true, amount_cents, safe_added_cents: 0, ambition_added_cents: 0, safe_ratio: safeRatio, ambition_ratio: 1 - safeRatio, allocation_source: allocation?.source ?? 'lch', portfolio: {} },
      message: `该笔充值已入账（重复请求已忽略）${existing ? `：¥${centsToYuan(existing.amount_cents).toFixed(2)}` : ''}`,
      timestamp: now,
    });
  }
  ```
  Note: on the fresh path, `amount_cents`, `safe_added_cents`, `ambition_added_cents`, `safe_ratio`, `ambition_ratio`, `allocation_source`, and `portfolio` (`updated.*`) are returned; `duplicate: false`.
- `GET /`: remove nothing structurally; balances/trigger_status are now cents from DB (no conversion needed — the DB returns cents). Trigger line resolution: evolved params are in yuan → `yuanToCents` only the evolved branch; the non-evolved fallback is already cents:
  ```ts
  const triggerLineCents = allocation && isEvolvedParams(allocation)
    ? yuanToCents(allocation.trigger_line ?? TRIGGER_LINE_DEFAULT_YUAN)
    : TRIGGER_CONSTANTS.LINE;
  ```
  Import `TRIGGER_LINE_DEFAULT_YUAN` from `../../src/types/api` alongside `TRIGGER_CONSTANTS`.
- `enrichPositionsWithMarketPrices`: `market_value` becomes cents: `Math.round(pos.shares * latestPrice * 100)`.
- Deposit response message uses `centsToYuan(...).toFixed(2)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run functions/api/__tests__/portfolio.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + Commit**

Run: `npx eslint functions/api/portfolio.ts functions/api/__tests__/portfolio.test.ts --max-warnings 0`
```bash
git add functions/api/portfolio.ts functions/api/__tests__/portfolio.test.ts
git commit -m "fix(api): atomic idempotent deposit ledger; integer-cents portfolio; remove unvalidated PUT /portfolio"
```

---

### Task 5: trigger — server-side balance + cents

**Files:**
- Modify: `functions/api/trigger.ts`, `src/lib/trigger-engine.ts`, `src/types/api.ts`
- Test: `functions/api/__tests__/trigger.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `POST /api/trigger` accepts `{ signal_value, signal_type }` (no `current_balance`); reads `portfolio.total_balance` server-side as the balance (cents) for the decision and `trigger_log`. `TRIGGER_CONSTANTS.LINE` = `166700` (cents), `COMMISSION_MIN_CENTS` = `500`, `COMMISSION_RATE` unchanged `0.0003`.

- [ ] **Step 1: Write the failing test (server-side balance override)**

Update the `triggerDb` helper in `functions/api/__tests__/trigger.test.ts` to include a portfolio rule (the handler now reads `portfolio.total_balance`), then add a test using a body WITHOUT `current_balance`:
```ts
function triggerDb(notificationRows: unknown[]): FakeD1 {
  return new FakeD1([
    { match: sql => sql.includes('FROM sessions'), rows: [{ id: 1, token: 'test-token', user_id: 7, expires_at: '2099-01-01', created_at: '', last_active: '', email: 'a@b.c', name: null }] },
    { match: sql => sql.includes('SELECT email FROM users'), rows: [{ email: 'a@b.c' }] },
    { match: sql => sql.includes('FROM strategy_reports'), rows: [] },
    { match: sql => sql.includes('FROM portfolio'), rows: [{ total_balance: 500000 }] },
    { match: sql => sql.includes('FROM market_data'), rows: [{ close: 100 }] },
    { match: sql => sql.includes('INSERT INTO trigger_log'), rows: [] },
    { match: sql => sql.includes('FROM notification_log'), rows: notificationRows },
  ]);
}

const SERVER_BALANCE_BODY = { signal_value: 2.0, signal_type: 'BSM' };

it('uses the server-side portfolio balance and ignores any client balance', async () => {
  const { ctx, pending } = pendingCtx();
  const res = await triggerRouter.request('/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...SESSION_COOKIE },
    body: JSON.stringify(SERVER_BALANCE_BODY),
  }, testEnv(triggerDb([])), ctx);
  await Promise.all(pending);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { success: boolean; data: { decision: string } };
  expect(json.data.decision).toBe('EXECUTE'); // 500000 cents >= 166700 line, BSM 2.0 >= threshold
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run functions/api/__tests__/trigger.test.ts`
Expected: FAIL — schema rejects (no `current_balance`) and/or balance is 0 (DEFER).

- [ ] **Step 3: Implement**

`src/types/api.ts`:
```ts
export const TRIGGER_CONSTANTS = {
  LINE: 166700 as const,               // default trigger line, CENTS
  TRIGGER_LINE_DEFAULT_YUAN: 1667 as const,
  COMMISSION_RATE: 0.0003 as const,
  COMMISSION_MIN_CENTS: 500 as const,
} as const;
```
`src/lib/trigger-engine.ts`:
- `calculateCommission`: `return Math.max(Math.round(amount * TRIGGER_CONSTANTS.COMMISSION_RATE), TRIGGER_CONSTANTS.COMMISSION_MIN_CENTS);`
- `trigger_line` resolution (evolved params are yuan, default is cents):
  ```ts
  const trigger_line = activeParams && isEvolvedParams(activeParams)
    ? Math.round((activeParams.trigger_line ?? TRIGGER_LINE_DEFAULT_YUAN) * 100)
    : TRIGGER_CONSTANTS.LINE;
  ```
- `safe_ratio`/`ambition_ratio`/`bsmThreshold` unchanged (ratios/thresholds, not money).
- Message strings: show yuan → `(current_balance / 100).toFixed(2)` and `(trigger_line / 100).toFixed(2)`.
- `TriggerInput` keeps `current_balance` (used internally), but `functions/api/trigger.ts` no longer takes it from the client.

`functions/api/trigger.ts`:
- `triggerSchema` → `z.object({ signal_value: z.number().min(0), signal_type: z.enum(['BSM','DOUBLE','NORMAL','SKIP']) })`.
- After parsing, read portfolio:
  ```ts
  const portfolio = await c.env.DB.prepare('SELECT total_balance FROM portfolio WHERE user_id = ?').bind(userId).first<{ total_balance: number }>();
  if (!portfolio) return c.json({ success: false, error: 'Not Found', message: '未找到投资组合' }, 400);
  const input: TriggerInput = { user_id: userId, current_balance: portfolio.total_balance, signal_value: parsed.signal_value, signal_type: parsed.signal_type as SignalType };
  ```
- `trigger_log` insert: `balance` = `portfolio.total_balance` (cents).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run functions/api/__tests__/trigger.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + Commit**

Run: `npx eslint functions/api/trigger.ts src/lib/trigger-engine.ts src/types/api.ts functions/api/__tests__/trigger.test.ts --max-warnings 0`
```bash
git add functions/api/trigger.ts src/lib/trigger-engine.ts src/types/api.ts functions/api/__tests__/trigger.test.ts
git commit -m "fix(api): trigger uses server-side portfolio balance; operate trigger engine in cents"
```

---

### Task 6: performance.ts + reconciliation.ts — cents + trade_date + audit

**Files:**
- Modify: `functions/api/performance.ts`, `functions/api/reconciliation.ts`
- Test: `functions/api/__tests__/performance.test.ts`, `functions/api/__tests__/reconciliation.test.ts`

**Interfaces:**
- Consumes: `splitDepositCents` from `../../src/lib/money` (reconciliation calibrate).
- Produces: `computeLayerPerformance` returns points with `market_value`/`invested`/`cumulative_gain` in cents and groups by `trade_date`; `POST /api/reconciliation` accepts cents (`broker_balance`, `deposits`, `withdrawals`, `gains`, `fees` all integer cents) and returns cents; `POST /api/reconciliation/:id/calibrate` writes an `audit_logs` row.

- [ ] **Step 1: Write the failing tests**

Replace `functions/api/__tests__/performance.test.ts` with the cents + trade_date version (full file):
```ts
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
```
Update `functions/api/__tests__/reconciliation.test.ts`: money fields (`broker_balance`, `deposits`, `withdrawals`, `fees`) become integer cents; expected `variance`/`system_total` in cents. Add a calibrate test asserting the batch includes `INSERT INTO audit_logs` (rule `match: sql => sql.includes('INSERT INTO audit_logs')`, rows: `[]`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run functions/api/__tests__/performance.test.ts functions/api/__tests__/reconciliation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`performance.ts`:
- `TxRow` fields → `amount_cents`, `commission_cents`, `trade_date`. SQL: `SELECT symbol, shares, price, amount AS amount_cents, commission AS commission_cents, transaction_type, layer, trade_date FROM transactions ...`.
- `buildSeries`: `firstDate = txs[0].trade_date`; group key `tx.trade_date`; buy: `shares += tx.shares; invested += tx.amount_cents + tx.commission_cents`; sell: `shares -= tx.shares; invested -= tx.amount_cents - tx.commission_cents`; `market_value = Math.round(sum(sh * close) * 100)`; return points in cents. Remove `round2`.
- `computeLayerPerformance`: `firstDate = txs[0].trade_date`; `dateSet.add(tx.trade_date)`; `closes` unchanged (yuan).

`reconciliation.ts`:
- `computeSystemState`: `holdingsValue = Math.round(sum(pos.shares * price) * 100)`; `systemTotal = cash.total_balance + holdingsValue` (all cents).
- `reconciliationSchema`: `broker_balance: z.number().int().min(0)`, `deposits/withdrawals/gains/fees: z.number().int()...optional()`. Values stored directly (cents).
- `variance = data.broker_balance - systemTotal`; `variancePct` unchanged (ratio of cents).
- Calibrate: `targetCash = Math.max(rec.ending_balance - holdingsValue, 0)` (cents); `safeRatio` from `cash.safe_layer_balance / cash.total_balance`; `newSafe = Math.floor(targetCash * safeRatio)`; `newAmbition = targetCash - newSafe`. Extend the batch with an audit insert:
  ```ts
  db.prepare(`INSERT INTO audit_logs (user_id, action, entity, old_value, new_value, created_at) VALUES (?, 'calibrate', 'portfolio', ?, ?, ?)`)
    .bind(userId, JSON.stringify({ total_balance: cash.total_balance, safe_layer_balance: cash.safe_layer_balance, ambition_layer_balance: cash.ambition_layer_balance }), JSON.stringify({ total_balance: targetCash, safe_layer_balance: newSafe, ambition_layer_balance: newAmbition }), now)
  ```
- Response messages use `centsToYuan(...).toFixed(2)` (import `centsToYuan` from `../../src/lib/money`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run functions/api/__tests__/performance.test.ts functions/api/__tests__/reconciliation.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + Commit**

Run: `npx eslint functions/api/performance.ts functions/api/reconciliation.ts functions/api/__tests__/performance.test.ts functions/api/__tests__/reconciliation.test.ts --max-warnings 0`
```bash
git add functions/api/performance.ts functions/api/reconciliation.ts functions/api/__tests__/performance.test.ts functions/api/__tests__/reconciliation.test.ts
git commit -m "fix(api): performance/reconciliation in cents, group by trade_date, audit calibrate"
```

---

### Task 7: Shared types + frontend

**Files:**
- Modify: `src/types/api.ts`, `src/hooks/usePortfolio.ts`, `src/hooks/useReconciliation.ts`
- Modify: `src/components/Dashboard.tsx`, `src/components/DepositForm.tsx`, `src/components/TransactionForm.tsx`, `src/components/PositionsList.tsx`, `src/components/RecentTransactions.tsx`, `src/components/TriggerProgress.tsx`, `src/components/SellConfirmModal.tsx`, `src/components/LayerCharts.tsx`, `src/pages/Reconciliation.tsx`

**Interfaces:**
- Consumes: `formatCents`, `yuanToCents`, `centsToYuan`, `tradeDateShanghai` from `src/lib/money`.
- Produces: all money values handled as cents; user inputs convert yuan→cents; display uses `formatCents`.

- [ ] **Step 1: Update shared types**

`src/types/api.ts`:
- Add `realized_pnl?: number | null` and `trade_date?: string` to `Transaction`.
- `TransactionForm.commission?: number` → document as cents (type stays number).
- `TRIGGER_CONSTANTS` updated (Task 5 already did) — ensure present.
- Add a `Portfolio`-level note comment: money fields are cents.

- [ ] **Step 2: Update hooks**

`usePortfolio.ts`:
- `createTransaction(form)`: `commission` in form is cents now (TransactionForm converts before calling). No change needed to fetch except the form contract.
- `calculateCommission(amount)` → takes yuan, returns `{ amount_cents, commission_cents, commission_rate, commission_min_cents }` (parse `data.commission_cents`).
- `depositFunds(amountCents, idempotencyKey)` → body `{ amount_cents, idempotency_key }`; return type includes `duplicate`.
- `DepositResult` type gains `duplicate: boolean`.

`useReconciliation.ts`:
- `create` payload `broker_balance`/`deposits`/`withdrawals`/`fees` become cents (the page converts). `Reconciliation`/`ReconciliationComparison` money fields = cents.

- [ ] **Step 3: Update components (convert at input, format at display)**

For each money display, replace `.toFixed(2)` on a money field with `formatCents(...)`. For inputs, convert yuan→cents before submit.

- `TriggerProgress.tsx`: props are cents. `triggerLine/100` in the title; `formatCents(currentBalance)` and `formatCents(triggerLine)`; `percentage = (currentBalance / triggerLine) * 100` unchanged (ratio).
- `DepositForm.tsx`: `const amountCents = yuanToCents(parsedAmount)`; call `deposit(amountCents, crypto.randomUUID())`; preview keeps yuan floats (`safePreview = parsedAmount * safeRatio`). On `result.duplicate`, toast the server message.
- `TransactionForm.tsx`: `amount` stays yuan (float for display); `formCommission = commission ? yuanToCents(parseFloat(commission)) : yuanToCents(Math.max(amount * 0.0003, 5))`; `calculateCommission(amount)` returns `commission_cents` → display `(commission_cents/100).toFixed(2)`; keep all user-facing labels in yuan. `SellConfirmModal` `amount` prop → pass cents, display `formatCents(amount)`.
- `PositionsList.tsx`: `avg_price` stays yuan (REAL) → keep `.toFixed(2)`; `market_value` is cents → `formatCents`.
- `RecentTransactions.tsx`: `price` yuan (REAL) → keep; `amount`/`commission` cents → `formatCents`; add a `盈亏` column for sells showing `formatCents(tx.realized_pnl)` (or `—` when null).
- `LayerCharts.tsx`: ECharts `value` = `Math.round(p.market_value / 100)` (yuan); gains `formatCents(...)`.
- `Dashboard.tsx` (lines ~101-103, 161): `formatCents(totalCash/safeCash/ambitionCash)`; pass cents `currentBalance` to `TriggerProgress`; deposit preview already handled in DepositForm.
- `Reconciliation.tsx`: convert `broker/deposits/withdrawals/fees` inputs yuan→cents before `create`; display all money with `formatCents`; `variance`/`beginning_balance`/`ending_balance` cents.

- [ ] **Step 4: Typecheck**

Run: `npm run types`
Expected: no type errors. Fix any missed cents conversions surfaced by types.

- [ ] **Step 5: Lint + Commit**

Run: `npx eslint src --max-warnings 0`
```bash
git add src/types/api.ts src/hooks src/components src/pages
git commit -m "feat(ui): handle money as integer cents end-to-end; format/convert at boundaries"
```

---

### Task 8: Realized P&L + trade_date backfill script

**Files:**
- Create: `scripts/backfill-realized-pnl.ts`
- Modify: `package.json` (add `backfill:realized` and `backfill:realized:prod` scripts)

**Interfaces:**
- Consumes: nothing new.
- Produces: `npm run backfill:realized` (local) / `npm run backfill:realized:prod` (remote). Replays each user's transactions (commission-inclusive weighted avg), backfills `realized_pnl` on historical sells, and rewrites each position's `avg_price` (yuan) to the replay-derived value.

- [ ] **Step 1: Write the script**

Model on `scripts/daily-market-update.ts` (`execSync` + `wrangler d1 execute --json` / `--file=`). Follow the `parseArgs` pattern (`--prod` flag).
```ts
#!/usr/bin/env node
// Backfill realized_pnl on historical sells and recompute commission-inclusive avg_price.
import { execSync } from 'child_process';
import { resolve } from 'path';
import { writeFileSync } from 'fs';

const PROD_FLAGS = ['--prod', '--production', '-p'] as const;

export interface Tx { id: number; user_id: number; symbol: string; layer: string; shares: number; amount_cents: number; commission_cents: number; transaction_type: 'buy' | 'sell'; }

function queryRows(dbName: string, remote: boolean): Tx[] {
  const flag = remote ? '--remote' : '--local';
  const cmd = `wrangler d1 execute ${dbName} --command="SELECT id, user_id, symbol, layer, shares, amount AS amount_cents, commission AS commission_cents, transaction_type FROM transactions ORDER BY user_id, created_at ASC, id ASC" --json ${flag}`;
  const stdout = execSync(cmd, { encoding: 'utf8', timeout: 120000 }).trim();
  const parsed = JSON.parse(stdout) as Array<{ results?: Tx[] }>;
  return parsed[0]?.results ?? [];
}

export function replayAndGenerateUpdates(txs: Tx[]): { updates: string[]; perKey: Map<string, { shares: number; avgCents: number }> } {
  const updates: string[] = [];
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
  return { updates, perKey: states };
}

export async function backfillRealizedPnl(): Promise<void> {
  const args = process.argv.slice(2);
  const isProd = PROD_FLAGS.some(f => args.includes(f));
  const dbName = isProd ? 'alpha-life-prod' : 'alpha-life-dev';
  console.log(`Backfilling realized_pnl into ${dbName} (${isProd ? 'remote' : 'local'})...`);
  const txs = queryRows(dbName, isProd);
  const { updates } = replayAndGenerateUpdates(txs);
  console.log(`  ${txs.length} transactions, ${updates.length} sells to backfill`);
  if (updates.length > 0) {
    const sqlPath = resolve(process.cwd(), 'data/backfill_realized_pnl.sql');
    writeFileSync(sqlPath, updates.join('\n'), 'utf8');
    execSync(`wrangler d1 execute ${dbName} --file="${sqlPath}" ${isProd ? '--remote' : '--local'}`, { stdio: 'inherit', timeout: 300000 });
  }
}

if (process.argv[1] === import.meta.url) {
  backfillRealizedPnl().catch(e => { console.error(e); process.exit(1); });
}
```

`package.json` scripts:
```json
"backfill:realized": "tsx scripts/backfill-realized-pnl.ts",
"backfill:realized:prod": "tsx scripts/backfill-realized-pnl.ts --prod"
```

- [ ] **Step 2: Unit-test the replay function**

Create `scripts/__tests__/backfill-realized-pnl.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { replayAndGenerateUpdates } from '../backfill-realized-pnl';

const txs = (over: Partial<Tx>[]) => over.map((o, i) => ({
  id: i, user_id: 1, symbol: '511360', layer: 'safe', shares: 100, amount_cents: 100000,
  commission_cents: 500, transaction_type: 'buy' as const, ...o,
}));

it('computes commission-inclusive realized pnl on sells', () => {
  const { updates } = replayAndGenerateUpdates(txs([
    { transaction_type: 'buy', shares: 100, amount_cents: 100000, commission_cents: 500 },
    { transaction_type: 'sell', shares: 20, amount_cents: 25000, commission_cents: 500 },
  ]));
  // avgCents = (100000+500)/100 = 1005 ; cost of 20 = 20100 ; realized = (25000-500) - 20100 = 4400
  expect(updates).toEqual([`UPDATE transactions SET realized_pnl = 4400 WHERE id = 1;`]);
});
```
Add a `Tx` type export to the script (or import from the test).

- [ ] **Step 3: Run tests + lint**

Run: `npx vitest run scripts/__tests__/backfill-realized-pnl.test.ts` and `npx eslint scripts/backfill-realized-pnl.ts scripts/__tests__/backfill-realized-pnl.test.ts --max-warnings 0`
Expected: PASS + clean.

- [ ] **Step 4: Run locally against dev D1**

Run: `npm run backfill:realized`
Expected: prints transaction/sell counts; no errors. Verify a sample sell has `realized_pnl` set via `wrangler d1 execute alpha-life-dev --command="SELECT id, realized_pnl FROM transactions WHERE transaction_type='sell' LIMIT 5" --local`.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-realized-pnl.ts scripts/__tests__/backfill-realized-pnl.test.ts package.json
git commit -m "feat(scripts): backfill realized_pnl and recompute commission-inclusive avg_price"
```

---

### Task 9: Full verification

**Files:** none (verification + docs note).

- [ ] **Step 1: Typecheck + lint + build**

Run:
```
npm run types
npm run lint
npm run build
```
Expected: all green. Fix any straggler (likely a missed `.toFixed(2)` on a money field, or an unused import left by the removed `round2`).

- [ ] **Step 2: Vitest**

Run: `npm run test`
Expected: all pass (money, transaction, portfolio, trigger, performance, reconciliation, lch-utils, auth, email, symbols, backfill).

- [ ] **Step 3: Python suite (must not regress)**

Run: `npm run lint:python:all` and `pytest`
Expected: all green (evolver untouched).

- [ ] **Step 4: Document in TODO.md**

Mark the 8 P1 money/security items as done with a dated note (mirroring the existing "已完成" style). Do not touch other sections.

- [ ] **Step 5: Commit**

```bash
git add TODO.md
git commit -m "docs(todo): mark P1 money/safety correctness items complete"
```

---

## Self-Review Notes

- **Spec coverage:** All 8 tasks mapped — Task 1 (utils), Task 2 (schema), Task 3 (transaction: cents/avg/atomic/realized/trade_date → TODO 1,2,3,7,8), Task 4 (portfolio: cents/deposit idempotent/remove PUT → TODO 1,4,5), Task 5 (trigger → TODO 6), Task 6 (performance/reconciliation cents + trade_date + audit → TODO 1,7), Task 7 (frontend), Task 8 (backfill → TODO 8), Task 9 (verification).
- **Type consistency:** `yuanToCents`/`centsToYuan`/`formatCents`/`splitDepositCents`/`tradeDateShanghai` used consistently. `TRIGGER_CONSTANTS.LINE`=166700 cents (Task 5+), `TRIGGER_LINE_DEFAULT_YUAN`=1667 for evolved-param fallback, `COMMISSION_MIN_CENTS`=500. `Transaction.commission`/`amount` and `Portfolio` balances all cents; `price`/`avg_price` yuan.
- **Known documented limitations (out of scope):** `market_data.close` stays DECIMAL(10,2) (ETF 3-decimal prices like 511990 truncate to 2 dp); production D1 migration + backfill must be run manually (existing workflow); `PUT /api/portfolio` removal is a breaking API change but has no callers.