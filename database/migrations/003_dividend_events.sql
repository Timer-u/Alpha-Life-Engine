-- 003: dividend events (cash dividend / split) with position adjustment
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
CREATE INDEX IF NOT EXISTS idx_dividend_events_user_id ON dividend_events(user_id);
