# Alpha-Life Engine Agent Guide

## Development Commands
- **Start Backend**: `npm run backend:dev` (Cloudflare Workers on :8787)
- **Start Frontend**: `npm run dev` (Vite on :3000)
- **Database Migration**:
  - Local: `npm run database:migrate`
  - Production: `npm run database:migrate:prod`
- **Market Data**:
  - Init (full history): `npm run market:init`
  - Daily Update: `npm run market:update`
  - Prod Update: `npm run market:update:prod`
- **Strategy Evolver**: `npm run evolve` (Python scripts in `scripts/local-evolver/`)
- **Build & Verify** (run in order):
  1. `npm run types` (TypeScript type check)
  2. `npm run lint` (ESLint – zero warnings required)
  3. `npm run build` (Vite build)
- **Deployment**: `npm run pages:deploy` (requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`)

## Critical Setup
- **Env Files**: Create `.dev.vars` with `RESEND_API_KEY` for real OTP emails; without it, OTP logs to `wrangler dev` console.
- **Whitelist**: First login requires adding email:
  `wrangler d1 execute alpha-life-dev --command="INSERT OR IGNORE INTO email_whitelist (email, notes) VALUES ('your@email.com', 'notes');" --local`
- **D1 Databases**: Dev uses `alpha-life-dev` (ID a491d7ba-...), prod uses `alpha-life-prod` (ID c79c0075-...).
- **Python Deps**: `pip install baostock pandas` (for market data) + `pip install -r scripts/local-evolver/requirements.txt` (for strategy evolver).

## Architecture
- **Frontend**: `src/` (React 19, React Router 7, Vite, React Query, ECharts, Tailwind 4, shadcn/ui)
- **Backend**: `functions/api/` (Hono on Cloudflare Workers) – routes: `/api/*`
- **Storage**: Cloudflare D1 (SQLite) – tables:
  - Auth: `users`, `sessions`, `otps`, `email_whitelist`
  - Portfolio: `portfolio`, `positions`, `transactions`
  - Market: `market_data`, `trigger_log`
  - Strategy: `strategy_reports`
  - System: `reconciliations`, `config`
- **Data Pipeline**: `scripts/` (TS/Python) → BaoStock → D1
  - `bao-stock-setup.ts`: full history download + SQL generation
  - `daily-market-update.ts`: incremental update (last 10 days)
- **Trigger Logic**: `src/lib/trigger-engine.ts` (1667 yuan trigger line)

## Verification Order (CI matches local)
1. `npm run types` (typecheck)
2. `npm run lint` (lint – must have zero warnings)
3. `npm run build` (Vite build)
4. Manual: open `http://localhost:3000`

## Key Files
- `wrangler.toml` – Workers config (D1 bindings, env vars, routes)
- `tsconfig.json` – strict mode, `noEmit`, path aliases (`@/*`)
- `eslint.config.js` – type-aware rules, perfectionist import sorting, `@typescript-eslint/no-explicit-any: error`
- `vite.config.ts` – Vite + Cloudflare Workers plugin
- `database/schema.sql` – full D1 schema (run via `database:migrate`)
- `scripts/local-evolver/config.yaml` – evolver parameters (costs, regimes, synthetic scenarios, drift detection, Sobol/bootstrap)

## Common Gotchas
- **Vite proxy**: Frontend proxies `/api` → `http://localhost:8787` (see `vite.config.ts`)
- **Cookie auth**: `session_token` HttpOnly cookie, 7-day expiry
- **BaoStock**: Free Chinese A-share data source; first full download takes 10-30 min
- **D1 local vs remote**: `--local` flag for dev, `--remote` for prod (handled by npm scripts)
- **Python execution**: Scripts try `python` then `python3`; ensure one works
- **Lint ignores**: `scripts/local-evolver/**`, `dist/**`, config files excluded from ESLint