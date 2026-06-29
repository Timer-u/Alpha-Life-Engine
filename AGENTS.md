# Alpha-Life Engine

Personal quantitative DCA system with dual-layer accounts (safe + ambition), 1667 yuan trigger line, and a Python strategy evolver.

## Dev Servers

| Command | What | Port |
|---|---|---|
| `npm run backend:dev` | Cloudflare Workers (Hono API) | `:8787` |
| `npm run dev` | Vite frontend (React 19) | `:3000` |

`wrangler pages dev` is an alternative backend start (used by `scripts/start-dev.bat`) — both work.

## Database

- **Schema**: `database/schema.sql` — D1 (SQLite on Cloudflare)
- **Migrate**: `npm run database:migrate` (local), `npm run database:migrate:prod` (prod)
- **Import market SQL**: `npm run database:import-market` (local), `npm run database:import-market:prod` (prod)
- Dev DB: `alpha-life-dev`, Prod DB: `alpha-life-prod` (IDs in `wrangler.toml`)

## Market Data Pipeline

| Command | What |
|---|---|
| `npm run market:init` | Full history download + schema migrate |
| `npm run market:update` | Incremental update (last 10 days, local D1) |
| `npm run market:update:prod` | Incremental update, prod D1 (`--prod` flag) |
| `npm run market:init:prod` | Full init for production |

Scripts in `scripts/` — TypeScript via `tsx`, fetches from BaoStock (free Chinese A-share data).

## Strategy Evolver

- **Entry**: `npm run evolve` → `python scripts/local_evolver/evolver.py`
- **Config**: `scripts/local_evolver/config.yaml`
- **Constants**: `scripts/local_evolver/constants.py` (all magic numbers centralized)
- **Python deps**: `pip install -e ".[dev]"` (installs from `pyproject.toml` — single source of truth)

## TS Verification (order matters, CI matches)

```
npm run types    # tsc --noEmit (strict mode, noEmit in tsconfig)
npm run lint     # eslint . --max-warnings 0
npm run build    # tsc && vite build (types + Vite build)
```

Note: `build` already runs `tsc`, so `types` is technically redundant but CI runs both.

## Python Verification

```
ruff check scripts/local_evolver/ data/           # lint (ALL rules, zero warns)
ruff format --check scripts/local_evolver/ data/   # format check
mypy --strict --no-site-packages scripts/local_evolver/ data/  # typecheck
bandit -r scripts/local_evolver/ data/ -c pyproject.toml       # security
```

Shortcut: `npm run lint:python:all`

Python tests: `pytest` (configured in `pyproject.toml`, tests at `scripts/local_evolver/tests/`)

Pre-commit: Python only (`ruff`, `mypy`, `bandit`). TS checks are CI-only (no pre-commit hook).

## Architecture

- **Frontend**: `src/` — React 19, React Router 7, Vite 8, TanStack React Query, ECharts 6, Tailwind 4
- **Backend**: `functions/api/[[route]].ts` — Hono on Cloudflare Workers, route file exports `onRequest = app.fetch`
- **Auth**: OTP via email (Resend), `session_token` HttpOnly cookie, 7-day expiry. Without `RESEND_API_KEY`, OTP logs to `wrangler dev` console.
- **Email whitelist**: First login requires `INSERT INTO email_whitelist ...`
- **D1 binding**: `DB` in `wrangler.toml`, typed via `wrangler types` → `worker-configuration.d.ts`
- **Vite proxy**: `/api` → `http://localhost:8787` (see `vite.config.ts`)
- **Path alias**: `@/*` → `./src/*` (tsconfig + vite)
- **Trigger engine**: `src/lib/trigger-engine.ts` — 1667 yuan default trigger line, BSM/DOUBLE/NORMAL/SKIP signal types
- **LCH allocation**: `src/lib/lch-constants.ts` — age-based safe/ambition ratio (AMBITION_MIN=0.20, AMBIATION_MAX=0.85)

## ESLint Quirks

- `@typescript-eslint/no-explicit-any: error`, `consistent-type-imports: error`, `perfectionist/sort-imports` (natural asc, type-first groups)
- `no-console: warn` (only `warn`, `error` allowed) — except `scripts/**` and `database/**` (unrestricted)
- Ignores: `dist/`, `.wrangler/`, `_worker.js`, `worker-configuration.d.ts`, `scripts/local_evolver/`, `vite.config.ts`, `postcss.config.js`, `tailwind.config.js`
- `--max-warnings 0` enforced

## Gotchas

- `npm run build` = `tsc && vite build` — types check then build; `build.sourcemap: true`
- `allowScripts` in package.json: esbuild, sharp, workerd need explicit permission
- BaoStock first download takes 5–15 min
- Python scripts try `python` then `python3`
- `scripts/local_evolver/` directory name uses underscore (not hyphen as in README)
- TypeScript 6.x (latest), `types: ["node"]` in tsconfig
- `wrangler types` regenerates `worker-configuration.d.ts`
