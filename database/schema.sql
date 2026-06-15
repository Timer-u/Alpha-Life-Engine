-- Alpha-Life Engine 数据库架构定义
-- 用于 Cloudflare D1 数据库

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  phone TEXT,
  preferences JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Portfolio summary table
CREATE TABLE IF NOT EXISTS portfolio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  total_balance DECIMAL(15,2) DEFAULT 0.00,
  safe_layer_balance DECIMAL(15,2) DEFAULT 0.00,
  ambition_layer_balance DECIMAL(15,2) DEFAULT 0.00,
  last_balance_update DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Positions table for holding ETFs
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  shares DECIMAL(15,6) DEFAULT 0.000000,
  avg_price DECIMAL(10,2) DEFAULT 0.00,
  current_price DECIMAL(10,2) DEFAULT 0.00,
  market_value DECIMAL(15,2) DEFAULT 0.00,
  last_price_update DATETIME DEFAULT CURRENT_TIMESTAMP,
  layer TEXT NOT NULL CHECK (layer IN ('safe', 'ambition')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, symbol, layer)
);

-- Transactions table for recording trades
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  shares DECIMAL(15,6) NOT NULL,
  price DECIMAL(10,2) NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  commission DECIMAL(10,2) NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('buy', 'sell')),
  trigger_signal TEXT,
  layer TEXT NOT NULL CHECK (layer IN ('safe', 'ambition')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);

-- Market data table for historical prices
CREATE TABLE IF NOT EXISTS market_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  open DECIMAL(10,2),
  high DECIMAL(10,2),
  low DECIMAL(10,2),
  close DECIMAL(10,2),
  volume INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(symbol, date)
);

-- Trigger log table for decision engine
CREATE TABLE IF NOT EXISTS trigger_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  balance DECIMAL(15,2) NOT NULL,
  trigger_decision TEXT NOT NULL CHECK (trigger_decision IN ('DEFER', 'SKIP', 'EXECUTE')),
  signal_value DECIMAL(10,2),
  executed_amount DECIMAL(15,2),
  commission DECIMAL(10,2),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Strategy evolution reports table
CREATE TABLE IF NOT EXISTS strategy_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  report_data TEXT NOT NULL, -- JSON stored as text
  pbo_score DECIMAL(10,4),
  dsr_ranking DECIMAL(10,4),
  parameter_count INTEGER DEFAULT 0,
  evolution_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  next_scheduled_evolution DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 对账记录表（用于月度对账）
CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reconciliation_date TEXT NOT NULL,
  beginning_balance DECIMAL(15,2) NOT NULL,
  deposits DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  withdrawals DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  gains DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  fees DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  ending_balance DECIMAL(15,2) NOT NULL,
  variance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  notes TEXT,
  status TEXT CHECK(status IN ('PENDING', 'CONFIRMED', 'ARCHIVED')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, reconciliation_date)
);

-- System configuration
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT,
  description TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert initial configuration values
INSERT OR IGNORE INTO config (key, value, description) VALUES
('trigger_line', '1667', '1667 yuan trigger line'),
('commission_rate', '0.0003', '0.03% commission rate'),
('commission_min', '5', 'Minimum commission in yuan'),
('safe_layer_primary', '511360', 'Primary safe layer ETF symbol'),
('safe_layer_backup', '511880', 'Backup safe layer ETF symbol'),
('safe_layer_name_primary', '海富通短融ETF', 'Primary safe layer ETF name'),
('safe_layer_name_backup', '银华日利', 'Backup safe layer ETF name'),
('ambition_layer_name', '权益ETF', 'Ambition layer ETF name');

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_portfolio_user_id ON portfolio(user_id);
CREATE INDEX IF NOT EXISTS idx_positions_user_symbol_layer ON positions(user_id, symbol, layer);
CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_market_data_symbol_date ON market_data(symbol, date);
CREATE INDEX IF NOT EXISTS idx_trigger_log_user_created ON trigger_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_strategy_reports_user_id ON strategy_reports(user_id);

-- Create view for portfolio summary
CREATE VIEW IF NOT EXISTS portfolio_summary AS
SELECT 
  p.user_id,
  p.total_balance,
  p.safe_layer_balance,
  p.ambition_layer_balance,
  COUNT(CASE WHEN p.layer = 'safe' THEN 1 END) as safe_positions_count,
  COUNT(CASE WHEN p.layer = 'ambition' THEN 1 END) as ambition_positions_count,
  p.last_balance_update,
  p.created_at,
  p.updated_at
FROM portfolio p;

-- Create view for recent transactions
CREATE VIEW IF NOT EXISTS recent_transactions AS
SELECT 
  t.id,
  t.user_id,
  t.symbol,
  t.shares,
  t.price,
  t.amount,
  t.commission,
  t.transaction_type,
  t.trigger_signal,
  t.layer,
  t.created_at
FROM transactions t
ORDER BY t.created_at DESC
LIMIT 100;
