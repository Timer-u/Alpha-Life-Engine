# Architecture

## Overview

Alpha-Life Engine follows a three-tier architecture:

```
Browser → Cloudflare Workers (Hono API) → D1 Database
            ↕
        BaoStock (Data Pipeline)
            ↕
    Local Strategy Evolver (Python)
```

## Frontend Layer (`src/`)

React 19 single-page application built with Vite 8.

### Key Libraries
- **React Router 7** — Client-side routing with `BrowserRouter`
- **TanStack React Query** — Server state management, caching, mutations
- **ECharts 6** — Charts and data visualization
- **Tailwind CSS 4** — Utility-first styling

### Page Flow
```
/login   → OTP authentication (email → code → session)
/        → Dashboard (auth-guarded)
*        → Redirect to /
```

### State Management
- **Auth state**: React Query with `['auth', 'me']` key, `staleTime: Infinity`
- **Portfolio data**: React Query with `['portfolio', 'dashboard']` key, auto-refetch
- **Mutations**: `useMutation` for OTP request/verify, logout, transaction creation
- **Session**: HttpOnly cookie (`session_token`), 7-day expiry

### Component Tree
```
App
├── Login (public)
└── AuthGuard
    └── Dashboard
        ├── StrategyEvolutionBar
        ├── TriggerProgress
        ├── PositionsList
        ├── TransactionForm
        └── RecentTransactions
```

## Backend Layer (`functions/api/`)

Hono-based API running on Cloudflare Workers.

### Route Structure

| Router | File | Prefix | Endpoints |
| --- | --- | --- | --- |
| `authRouter` | `auth.ts` | `/auth` | `/otp/request`, `/otp/verify`, `/logout`, `/me` |
| `portfolioRouter` | `portfolio.ts` | `/portfolio` | `GET /`, `PUT /` |
| `transactionRouter` | `transaction.ts` | `/transactions` | `GET /`, `POST /`, `POST /calculate-commission` |
| `triggerRouter` | `trigger.ts` | `/trigger` | `POST /`, `GET /market-prices` |
| `strategyRouter` | `strategy.ts` | `/strategy` | `PATCH /report` |
| `marketDataRouter` | `market-data.ts` | `/market-data` | `GET /history` |

### Middleware
- **CORS**: Configured for `localhost:3000` and production domain
- **Session**: JWT-less session via `sessionMiddleware` (cookie-based token lookup in D1)
- **Error handling**: Global `onError` handler with environment-aware messages

### Auth Flow
```
1. POST /api/auth/otp/request
   → Validate email against whitelist
   → Generate 6-digit OTP, store in D1 (10 min expiry)
   → Send via Resend API (or log to console in dev)

2. POST /api/auth/otp/verify
   → Validate OTP against D1
   → Upsert user + portfolio records
   → Generate session token (32 bytes hex)
   → Set HttpOnly cookie, return session data

3. GET /api/auth/me (session cookie)
   → Lookup session token in D1
   → Return user info or 401
```

### Trigger Decision Engine

Located in `src/lib/trigger-engine.ts`:

```
current_balance < 1667     → DEFER (stay in safe layer)
current_balance >= 1667
  + signal_type = SKIP     → SKIP
  + signal_type = BSM
    + signal_value >= 1.4  → EXECUTE (panic buy)
    + signal_value < 1.4   → DEFER
  + signal_type = DOUBLE
    or NORMAL              → EXECUTE (standard buy)
```

## Data Layer (D1 Database)

Cloudflare D1 is a serverless SQLite database.

### Connection
- **Dev**: Local D1 via `wrangler dev` (`alpha-life-dev`)
- **Prod**: Remote D1 via Cloudflare API (`alpha-life-prod`)
- **Binding**: Exposed as `DB` environment variable in Workers

### Key Design Decisions
- `DECIMAL(15,2)` for monetary values (balance, amounts)
- `DECIMAL(15,6)` for share quantities (ETF fractional shares)
- `UNIQUE` constraints for idempotent inserts
- Indexes on frequently queried columns (user_id, symbol+date, token)

## Data Pipeline (`scripts/`)

### Flow
```
BaoStock (A股数据源)
    ↓ Python (baostock + pandas)
CSV files in data/market_data/
    ↓ TypeScript script
SQL INSERT statements
    ↓ wrangler d1 execute
D1 market_data table
```

### Scripts
- `bao-stock-setup.ts` — Full history download (1990-present), called by `npm run market:init`
- `daily-market-update.ts` — Incremental update (last 5 trading days), called by GitHub Actions

## Strategy Evolver (`scripts/local-evolver/`)

Python-based strategy backtesting and optimization system.

### Pipeline
```
Market Data (CSV)
    ↓
CPCV (Combinatorial Purged Cross-Validation)
    ↓
Walk-Forward Optimization
    ↓
DSR (Deflated Sharpe Ratio) Ranking
    ↓
PBO (Probability of Backtest Overfitting) Filter
    ↓
Monte Carlo Stress Testing
    ↓
Strategy Report → PATCH /api/strategy/report
```
