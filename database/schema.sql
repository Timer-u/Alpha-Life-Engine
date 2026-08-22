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
  total_balance INTEGER NOT NULL DEFAULT 0,
  safe_layer_balance INTEGER NOT NULL DEFAULT 0,
  ambition_layer_balance INTEGER NOT NULL DEFAULT 0,
  last_balance_update DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_user_id ON portfolio(user_id);

-- Positions table for holding ETFs
CREATE TABLE IF NOT EXISTS positions (
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

-- Transactions table for recording trades
CREATE TABLE IF NOT EXISTS transactions (
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
  notes TEXT,
  idempotency_key TEXT,
  request_nonce TEXT
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
  balance INTEGER NOT NULL,
  trigger_decision TEXT NOT NULL CHECK (trigger_decision IN ('DEFER', 'SKIP', 'EXECUTE')),
  signal_value REAL,
  executed_amount INTEGER,
  commission INTEGER,
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

-- System configuration
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
  attempts INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

-- 通知发送记录表（策略过期/执行建议邮件去重）
CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 充值台账表（幂等键去重）
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, idempotency_key)
);

-- 分红/除权事件表（现金分红、拆股/送股；幂等键去重）
CREATE TABLE IF NOT EXISTS dividend_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  ex_date TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('cash', 'split')),
  amount_per_share DECIMAL(10,4),
  split_ratio DECIMAL(10,6),
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, symbol, ex_date, type)
);

-- 审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- config 表已删除（2026-08-22 审计）：播种后全代码无 FROM config 读取，
-- 改表内触发线/佣金零效果，纯误导；真实事实源是 TRIGGER_CONSTANTS / ETF_CONSTANTS（src/types/api.ts）。

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
-- 注: 新数据库在 CREATE TABLE 中包含 otps.attempts 列（OTP 验证尝试上限）
-- 已有数据库执行一次: database/migrations/001_otp_attempts.sql
CREATE INDEX IF NOT EXISTS idx_otps_email_created ON otps(email, created_at);
CREATE INDEX IF NOT EXISTS idx_email_whitelist_email ON email_whitelist(email);
CREATE INDEX IF NOT EXISTS idx_reconciliations_user_date ON reconciliations(user_id, reconciliation_date);
CREATE INDEX IF NOT EXISTS idx_notification_log_user_type ON notification_log(user_id, notification_type, sent_at);
CREATE INDEX IF NOT EXISTS idx_transactions_user_trade_date ON transactions(user_id, trade_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_user_idempotency
  ON transactions(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_dividend_events_user_id ON dividend_events(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
