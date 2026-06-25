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

---

## Transactions

### GET /api/transactions?limit=100

List transactions (most recent first).

### POST /api/transactions

Create a new transaction record. Updates portfolio balance automatically on buy.

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
  "notes": "optional"
}
```

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

`sinal_type` enum: `BSM`, `DOUBLE`, `NORMAL`, `SKIP`

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
    "market_data": { "current_price_511360": 100.50, "current_price_511880": 100.00 }
  }
}
```

### GET /api/trigger/market-prices

Get latest prices for all tracked symbols.

---

## Market Data

### GET /api/market-data/history

Get full historical OHLCV data for all tracked symbols.

---

## Strategy

### PATCH /api/strategy/report

Push strategy evolution report from local evolver.

**Request:**
```json
{
  "report_data": "{...}",
  "pbo_score": 0.35,
  "dsr_ranking": 0.82,
  "parameter_count": 12,
  "next_scheduled_evolution": "2026-02-01T00:00:00.000Z"
}
```
