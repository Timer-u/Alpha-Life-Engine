-- Alpha-Life Engine 数据库架构定义
-- 用于 Cloudflare D1 数据库

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  avatar_url TEXT,
  phone TEXT,
  preferences JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 邮箱白名单表（用于 OTP 认证准入控制）
CREATE TABLE IF NOT EXISTS email_whitelist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  report_data TEXT NOT NULL,
  pbo_score DECIMAL(10,4),
  dsr_ranking DECIMAL(10,4),
  parameter_count INTEGER DEFAULT 0,
  evolution_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  next_scheduled_evolution DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, evolution_timestamp)
);

-- 对账记录表
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

-- Sessions table for user sessions
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  last_active DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- OTP codes table
CREATE TABLE IF NOT EXISTS otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
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
-- 注: 新数据库在 CREATE TABLE 中包含 UNIQUE(user_id, evolution_timestamp)
-- 已有数据库需手动迁移: CREATE UNIQUE INDEX IF NOT EXISTS idx_sr_user_evo ON strategy_reports(user_id, evolution_timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email);
CREATE INDEX IF NOT EXISTS idx_email_whitelist_email ON email_whitelist(email);
