-- 004: transaction idempotency key (dedupe retried buy/sell posts)
ALTER TABLE transactions ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_user_idempotency
  ON transactions(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
