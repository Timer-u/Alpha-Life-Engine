-- 005: per-request nonce for transaction batch mutations (see BATCH_TXN_GUARD in transaction.ts)
ALTER TABLE transactions ADD COLUMN request_nonce TEXT;