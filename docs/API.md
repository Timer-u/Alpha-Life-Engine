# API Reference

Base URL: `http://localhost:8787` (dev) / `https://alpha-life.yourdomain.com` (prod)

All responses follow a standard envelope:

```json
{
  "success": true,
  "data": { ... },
  "message": "...",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

Error responses:

```json
{
  "success": false,
  "error": "ErrorType",
  "message": "Human-readable description",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

---

## Authentication

### POST /api/auth/otp/request

Request a 6-digit OTP code sent to the email.

**Request:**
```json
{ "email": "user@example.com" }
```

**Response:** `200`
```json
{
  "data": { "message": "验证码已发送", "expires_in": 600 }
}
```

**Errors:** `403` — Email not whitelisted

### POST /api/auth/otp/verify

Verify OTP and create session.

**Request:**
```json
{ "email": "user@example.com", "otp": "123456" }
```

**Response:** `200`
```json
{
  "data": {
    "token": "abcdef...",
    "user": { "id": 1, "email": "user@example.com", "name": "user" },
    "expires_at": "2026-01-08T00:00:00.000Z"
  }
}
```

**Cookie:** `session_token=...; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`

**Errors:** `401` — Invalid or expired OTP

### POST /api/auth/logout

Delete session and clear cookie.

### GET /api/auth/me

Get current user info from session cookie.

**Response:** `200`
```json
{
  "data": { "user": { "id": 1, "email": "user@example.com", "name": "user" } }
}
```

---

## Portfolio

All portfolio endpoints require session cookie.

### GET /api/portfolio

Get complete dashboard data.

**Response:** `200`
```json
{
  "data": {
    "portfolio": {
      "id": 1, "user_id": 1,
      "total_balance": 5000.00,
      "safe_layer_balance": 3000.00,
      "ambition_layer_balance": 2000.00
    },
    "positions": [
      {
        "id": 1, "symbol": "511360", "name": "海富通短融ETF",
        "shares": 100, "avg_price": 100.00, "current_price": 100.50,
        "market_value": 10050.00, "layer": "safe"
      }
    ],
    "recent_transactions": [...],
    "trigger_status": {
      "current_balance": 5000.00,
      "trigger_line": 1667,
      "status": "triggerable",
      "last_decision": "EXECUTE",
      "last_decision_time": "2026-01-01T00:00:00.000Z"
    },
    "strategy_evolution": {
      "last_evolution": "2026-01-01T00:00:00.000Z",
      "days_since_evolution": 5,
      "pbo_score": 0.35,
      "status_color": "green"
    }
  }
}
```

### PUT /api/portfolio

Update portfolio balance fields.

**Request:**
```json
{
  "total_balance": 6000.00,
  "safe_layer_balance": 3500.00,
  "ambition_layer_balance": 2500.00
}
```

Allowed fields: `total_balance`, `safe_layer_balance`, `ambition_layer_balance`

### POST /api/portfolio/deposit

Recharge the fund pool. The amount is automatically split into safe/ambition layers using the active allocation (evolved strategy params, or LCH age-based fallback). Idempotent via `idempotency_key` (min 8, max 64 chars); a repeated key returns `duplicate: true` and does not credit the pool again.

**Request:**
```json
{ "amount_cents": 200000, "idempotency_key": "deposit-key-20260101" }
```

**Response:** `200` (first attempt)
```json
{
  "data": {
    "duplicate": false,
    "amount_cents": 200000,
    "safe_added_cents": 120000,
    "ambition_added_cents": 80000,
    "safe_ratio": 0.6,
    "ambition_ratio": 0.4,
    "allocation_source": "lch",
    "portfolio": { "total_balance": 200000, "safe_layer_balance": 120000, "ambition_layer_balance": 80000 }
  }
}
```

**Response:** `200` (duplicate `idempotency_key` → `duplicate: true`, no re-credit)
```json
{
  "data": { "duplicate": true, "amount_cents": 200000, "safe_added_cents": 0, "ambition_added_cents": 0, "safe_ratio": 0.6, "ambition_ratio": 0.4, "allocation_source": "lch", "portfolio": {} }
}
```

### GET /api/portfolio/layer-performance

Daily cumulative-return series per layer, built by replaying transactions against `market_data` closes.

**Response:** `200`
```json
{
  "data": {
    "safe": [{ "date": "2026-01-05", "market_value": 1010.00, "invested": 1005.00, "cumulative_gain": 5.00 }],
    "ambition": [...]
  }
}
```

---

## Transactions

### GET /api/transactions?limit=100

List transactions (most recent first).

### POST /api/transactions

Create a new transaction record. Atomically updates positions and the fund pool:

- **buy** — rejects with `400` if the layer's cash balance is insufficient; deducts `amount + commission` from the layer, upserts the position (weighted-average cost)
- **sell** — rejects with `400` if held shares are insufficient; credits `amount - commission` back to the layer, reduces/removes the position
- **idempotency_key** is REQUIRED (min 8, max 64 chars). Repeating a key that already exists returns `200` with `duplicate: true` and the previously recorded transaction instead of creating a new one.

**Request:**
```json
{
  "symbol": "511360",
  "shares": 10,
  "price": 100.50,
  "commission": 5.00,
  "transaction_type": "buy",
  "layer": "safe",
  "trigger_signal": "NORMAL",
  "notes": "optional",
  "idempotency_key": "tx-20260101-001"
}
```

**Response:** `201` (new transaction)
```json
{ "data": { "id": 42, "success": true, "symbol": "511360", "shares": 10, "price": 100.5, "amount": 100500, "commission": 500, "transaction_type": "buy", "layer": "safe", "idempotency_key": "tx-20260101-001" } }
```

**Response:** `200` (duplicate `idempotency_key` → `duplicate: true`)
```json
{ "data": { "id": 42, "success": true, "symbol": "511360" }, "duplicate": true, "message": "该笔交易已记录（重复请求已忽略）" }
```

**Errors:** `400` — missing/too-short `idempotency_key`, insufficient funds, insufficient shares, sell proceeds below commission

### POST /api/transactions/calculate-commission

Calculate commission for a given amount.

**Request:** `{ "amount": 10000 }`

**Response:** `200`
```json
{
  "data": { "amount": 10000, "commission": 5.00, "commission_rate": 0.0003, "commission_min": 5 }
}
```

---

## Trigger

### POST /api/trigger

Execute trigger decision engine.

**Request:**
```json
{
  "current_balance": 2000.00,
  "signal_value": 1.5,
  "signal_type": "BSM"
}
```

`signal_type` enum: `BSM`, `DOUBLE`, `NORMAL`, `SKIP`

On `EXECUTE` decisions an execution-suggestion email is sent asynchronously (Resend; logged to console when `RESEND_API_KEY` is unset).

**Response:** `200`
```json
{
  "data": {
    "decision": "EXECUTE",
    "executed_amount": 1667,
    "commission": 5.00,
    "layer_allocation": { "safe_amount": 1000.20, "ambition_amount": 666.80 },
    "message": "恐慌入场信号 (BSM >= 1.4)，执行买入 1667 元",
    "next_safe_etf": "511360",
    "next_ambition_etf": "510300",
    "market_data": { "511360": 100.50, "510300": 1.550 }
  }
}
```

`market_data` is a dynamic `Record<string, number>` keyed by the chosen ETFs (the current `next_safe_etf` and `next_ambition_etf` prices in yuan), not fixed keys.

### GET /api/trigger/market-prices

Get latest prices for all tracked symbols.

---

## Market Data

### GET /api/market-data/history

Get full historical OHLCV data for all tracked symbols.

---

## Strategy

### GET /api/strategy/latest-params

Get the active allocation parameters: latest evolved report (if PBO <= 0.5), otherwise the LCH age-based fallback. When the fallback is caused by PBO rejection, `meta.fallback = "pbo_rejected"` is included.

### POST /api/strategy/reports

Push strategy evolution report from local evolver.

**Request:**
```json
{
  "report_data": "{...}",
  "pbo_score": 0.35,
  "dsr_ranking": 0.82,
  "parameter_count": 12,
  "evolution_timestamp": "2026-01-01T00:00:00.000Z",
  "next_scheduled_evolution": "2026-02-01T00:00:00.000Z"
}
```

---

## Reconciliation

### GET /api/reconciliation

List reconciliation records (most recent 24 months).

### POST /api/reconciliation

Monthly reconciliation: compare broker-reported total assets against the system view (fund pool cash + holdings valued at latest closes). Variance <= 1% auto-confirms; > 1% is stored as `PENDING` awaiting calibration. Upserts by `(user, month)`.

Note: `deposits`/`withdrawals`/`gains`/`fees` are informational only (user-entered monthly flows) and do not affect the variance computation. The stored `beginning_balance` is the system-side total assets at reconciliation time (cash + holdings), not the month's opening balance.

**Request:**
```json
{
  "reconciliation_date": "2026-07",
  "broker_balance": 12345.67,
  "deposits": 2000,
  "withdrawals": 0,
  "fees": 5,
  "notes": "optional"
}
```

**Response:** `200`
```json
{
  "data": {
    "reconciliation": { "id": 1, "status": "PENDING", "variance": -250.00, ... },
    "comparison": {
      "system_cash": 5000.00,
      "system_holdings_value": 7595.67,
      "system_total": 12595.67,
      "broker_balance": 12345.67,
      "variance": -250.00,
      "variance_pct": 1.98,
      "needs_calibration": true
    }
  }
}
```

### POST /api/reconciliation/:id/calibrate

One-click calibration for a `PENDING` record: sets fund-pool cash to `broker_balance - holdings_value` (floored at 0), re-splits layer cash proportionally (layer ratio clamped to [0,1]; LCH/evolved ratios when the pool was empty), and marks the record `CONFIRMED`.

By definition calibration absorbs the whole discrepancy into pool cash, so the response carries a `warnings` array reminding the user to verify holdings-level mismatches; holdings composition may no longer match the broker reality after calibrating.

---

## Audit Logs

### GET /api/audit-logs?limit=100

List the user's audit trail (most recent first). `limit` is clamped to `[1, 200]`, default `100`.

**Response:** `200`
```json
{
  "data": [
    { "id": 7, "user_id": 1, "action": "transaction", "entity": "transactions", "old_value": null, "new_value": "{\"symbol\":\"511360\",...}", "created_at": "2026-01-01T00:00:00.000Z" },
    { "id": 6, "user_id": 1, "action": "deposit", "entity": "portfolio", "old_value": null, "new_value": "{\"amount_cents\":200000,...}", "created_at": "2026-01-01T00:00:00.000Z" }
  ]
}
```

Audit rows are written transactionally with the operation they describe: a `transaction` action only when the trade is actually recorded, a `deposit` action only when the pool is actually credited. Guard-rejected or duplicate operations write no audit row.

---

## Dividends

### POST /api/dividends

Record a cash dividend or split (送股/拆股) event and atomically apply it to the user's current positions in the same symbol. Deduplicated by `(user_id, symbol, ex_date, type)` — a repeated event returns `200` with `duplicate: true` and is not applied twice.

`type` enum: `cash` (requires `amount_per_share`, the per-share cash dividend in yuan) or `split` (requires `split_ratio`).

**Request:**
```json
{
  "symbol": "511360",
  "ex_date": "2026-01-05",
  "type": "cash",
  "amount_per_share": 0.05,
  "notes": "optional"
}
```

**Response:** `201` (new event)
```json
{ "data": { "duplicate": false, "symbol": "511360", "ex_date": "2026-01-05", "type": "cash", "amount_per_share": 0.05, "split_ratio": null, "applied_positions": 1 } }
```

**Response:** `200` (duplicate event → `duplicate: true`)
```json
{ "data": { "duplicate": true, "symbol": "511360", "ex_date": "2026-01-05", "type": "cash", "amount_per_share": 0.05, "split_ratio": null } }
```

Effects: `cash` credits each holding's layer balance with `shares × amount_per_share`; `split` multiplies holding shares by `split_ratio` and divides the average cost price accordingly.

### GET /api/dividends

List dividend/除权 events (most recent 100, ordered by `ex_date` desc).

---

## Export

### GET /api/export

Download the user's complete bookkeeping data as a JSON attachment (`Content-Disposition: attachment; filename="alpha-life-export-<trade date>.json"`).

The payload contains `portfolio`, `positions`, `transactions`, `reconciliations`, `dividend_events`, and `audit_logs`.
