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
- **Build & Verify**:
  - Type check: `npm run types`
  - Lint: `npm run lint`
  - Build: `npm run build` (creates `dist/`)
- **Deployment**: `npm run pages:deploy` (requires `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`)

## Critical Setup
- **Env Files**: Create `.dev.vars` with `RESEND_API_KEY` for real OTP emails; without it, OTP logs to `wrangler dev` console.
- **Whitelist**: First login requires adding email:
  `wrangler d1 execute alpha-life-dev --command="INSERT OR IGNORE INTO email_whitelist (email, notes) VALUES ('your@email.com', 'notes');" --local`
- **D1 Databases**: Dev uses `alpha-life-dev` (ID a491d7ba-...), prod uses `alpha-life-prod` (ID c79c0075-...).

## Architecture
- **Frontend**: `src/` (React 19, React Router 7, Vite, React Query, ECharts, Tailwind, shadcn/ui)
- **Backend**: `functions/api/` (Hono on Cloudflare Workers) – routes: `/api/*`
- **Storage**: Cloudflare D1 (SQLite) – tables: `users`, `sessions`, `otps`, `portfolio`, `transactions`, `market_data`, `trigger_log`, `strategy_reports`
- **Data Pipeline**: `scripts/` (TS/Python) → BaoStock → D1
- **Trigger Logic**: `src/lib/trigger-engine.ts` (1667 yuan trigger line)

## Verification Order
1. `npm run types` (typecheck)
2. `npm run lint` (lint – must have zero warnings)
3. Manual verification: open `http://localhost:3000`