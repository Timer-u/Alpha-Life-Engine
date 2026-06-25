# Database Schema

Cloudflare D1 (SQLite) — 10 tables.

## Entity Relationship

```
users ──1:N── sessions
users ──1:1── portfolio
users ──1:N── positions
users ──1:N── transactions
users ──1:N── trigger_log
users ──1:N── strategy_reports
users ──1:N── reconciliations
email_whitelist (standalone)
otps (standalone)
config (standalone key-value store)
```

## Tables

### users

| Column | Type | Constraints |
| --- | --- | --- |
| id | `INTEGER` | PK AUTOINCREMENT |
| email | `TEXT` | UNIQUE NOT NULL |
| name | `TEXT` | |
| avatar_url | `TEXT` | |
| phone | `TEXT` | |
| preferences | `JSON` | |
| created_at | `DATETIME` | DEFAULT CURRENT_TIMESTAMP |
| updated_at | `DATETIME` | DEFAULT CURRENT_TIMESTAMP |

### email_whitelist

OTP authentication access control.

| Column | Type | Constraints |
| --- | --- | --- |
| id | `INTEGER` | PK AUTOINCREMENT |
| email | `TEXT` | UNIQUE NOT NULL |
| notes | `TEXT` | |
| created_at | `DATETIME` | DEFAULT CURRENT_TIMESTAMP |

### portfolio

Per-user portfolio summary.

| Column | Type | Constraints |
| --- | --- | --- |
| id | `INTEGER` | PK AUTOINCREMENT |
| user_id | `INTEGER` | FK → users(id) ON DELETE CASCADE |
| total_balance | `DECIMAL(15,2)` | DEFAULT 0.00 |
| safe_layer_balance | `DECIMAL(15,2)` | DEFAULT 0.00 |
| ambition_layer_balance | `DECIMAL(15,2)` | DEFAULT 0.00 |
| last_balance_update | `DATETIME` | |
| created_at | `DATETIME` | |
| updated_at | `DATETIME` | |

### positions

Per-user ETF holdings.

| Column | Type | Constraints |
| --- | --- | --- |
| id | `INTEGER` | PK AUTOINCREMENT |
| user_id | `INTEGER` | FK → users(id) ON DELETE CASCADE |
| symbol | `TEXT` | NOT NULL |
| name | `TEXT` | NOT NULL |
| shares | `DECIMAL(15,6)` | DEFAULT 0.000000 |
| avg_price | `DECIMAL(10,2)` | |
| current_price | `DECIMAL(10,2)` | |
| market_value | `DECIMAL(15,2)` | |
| layer | `TEXT` | CHECK ('safe', 'ambition') |
| UNIQUE(user_id, symbol, layer) | | |

### transactions

Trade records.

| Column | Type | Constraints |
| --- | --- | --- |
| id | `INTEGER` | PK AUTOINCREMENT |
| user_id | `INTEGER` | FK → users(id) ON DELETE CASCADE |
| symbol | `TEXT` | NOT NULL |
| shares | `DECIMAL(15,6)` | NOT NULL |
| price | `DECIMAL(10,2)` | NOT NULL |
| amount | `DECIMAL(15,2)` | NOT NULL |
| commission | `DECIMAL(10,2)` | NOT NULL |
| transaction_type | `TEXT` | CHECK ('buy', 'sell') |
| trigger_signal | `TEXT` | |
| layer | `TEXT` | CHECK ('safe', 'ambition') |
| created_at | `DATETIME` | |
| notes | `TEXT` | |

### market_data

ETF daily OHLCV data from BaoStock.

| Column | Type | Constraints |
| --- | --- | --- |
| id | `INTEGER` | PK AUTOINCREMENT |
| symbol | `TEXT` | NOT NULL |
| date | `TEXT` | NOT NULL |
| open | `DECIMAL(10,2)` | |
| high | `DECIMAL(10,2)` | |
| low | `DECIMAL(10,2)` | |
| close | `DECIMAL(10,2)` | |
| volume | `INTEGER` | |
| created_at | `DATETIME` | |
| UNIQUE(symbol, date) | | |

### trigger_log

Trigger engine decision records.

| Column | Type | Constraints |
| --- | --- | --- |
| id | `INTEGER` | PK AUTOINCREMENT |
| user_id | `INTEGER` | FK → users(id) ON DELETE CASCADE |
| balance | `DECIMAL(15,2)` | NOT NULL |
| trigger_decision | `TEXT` | CHECK ('DEFER', 'SKIP', 'EXECUTE') |
| signal_value | `DECIMAL(10,2)` | |
| executed_amount | `DECIMAL(15,2)` | |
| commission | `DECIMAL(10,2)` | |
| created_at | `DATETIME` | |

### strategy_reports

Strategy evolution reports from the Python evolver.

| Column | Type | Constraints |
| --- | --- | --- |
| id | `INTEGER` | PK AUTOINCREMENT |
| user_id | `INTEGER` | FK → users(id) ON DELETE CASCADE |
| report_data | `TEXT` | NOT NULL (JSON) |
| pbo_score | `DECIMAL(10,4)` | |
| dsr_ranking | `DECIMAL(10,4)` | |
| parameter_count | `INTEGER` | DEFAULT 0 |
| evolution_timestamp | `DATETIME` | |
| next_scheduled_evolution | `DATETIME` | |
| UNIQUE(user_id, evolution_timestamp) | | |

### reconciliations

Monthly broker vs system reconciliation.

| Column | Type | Constraints |
| --- | --- | --- |
| id | `INTEGER` | PK AUTOINCREMENT |
| user_id | `INTEGER` | FK → users(id) ON DELETE CASCADE |
| reconciliation_date | `TEXT` | NOT NULL |
| beginning_balance | `DECIMAL(15,2)` | NOT NULL |
| deposits / withdrawals / gains / fees / ending_balance | `DECIMAL(15,2)` | |
| variance | `DECIMAL(15,2)` | DEFAULT 0.00 |
| status | `TEXT` | CHECK ('PENDING', 'CONFIRMED', 'ARCHIVED') |
| UNIQUE(user_id, reconciliation_date) | | |

### config

System-wide key-value configuration.

| Column | Type | Constraints |
| --- | --- | --- |
| key | `TEXT` | PK |
| value | `TEXT` | |
| description | `TEXT` | |

Default keys: `trigger_line` (1667), `commission_rate` (0.0003), `commission_min` (5), `safe_layer_primary` (511360), `safe_layer_backup` (511880).

## Indexes

| Name | Table | Columns |
| --- | --- | --- |
| idx_users_email | users | email |
| idx_portfolio_user_id | portfolio | user_id |
| idx_positions_user_symbol_layer | positions | user_id, symbol, layer |
| idx_transactions_user_created | transactions | user_id, created_at |
| idx_market_data_symbol_date | market_data | symbol, date |
| idx_trigger_log_user_created | trigger_log | user_id, created_at |
| idx_sessions_token | sessions | token |
| idx_otps_email | otps | email |
| idx_email_whitelist_email | email_whitelist | email |

## Migration

```bash
# Local
npm run database:migrate

# Production
npm run database:migrate:prod
```

The migration executes `database/schema.sql` via `wrangler d1 execute`, which uses `CREATE TABLE IF NOT EXISTS` for idempotency.
