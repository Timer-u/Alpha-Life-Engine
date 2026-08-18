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
