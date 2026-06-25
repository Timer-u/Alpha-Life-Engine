# Deployment Guide

## Prerequisites

- Cloudflare account with Workers and D1 enabled
- GitHub repository (for CI/CD)
- Domain name (optional, for production)

## Environment Variables

Required for production:

| Variable | Source | Description |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard | Account ID for wrangler |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard | API token with Workers & D1 permissions |
| `RESEND_API_KEY` | Resend.com | Optional, for email OTP delivery |

## Step-by-Step

### 1. Configure wrangler.toml

```toml
name = "alpha-life-engine"
main = "_worker.js"
compatibility_date = "2026-01-01"

[env.production]
name = "alpha-life-engine"
routes = [
  { pattern = "your-domain.com/*", zone_name = "your-domain.com" }
]
vars = { ENVIRONMENT = "production", LOG_LEVEL = "info", SESSION_DAYS = "7" }

[[env.production.d1_databases]]
binding = "DB"
database_name = "alpha-life-prod"
database_id = "<your-d1-database-id>"
```

### 2. Create Production D1 Database

```bash
wrangler d1 create alpha-life-prod
```

Copy the returned `database_id` into `wrangler.toml`.

### 3. Run Migrations

```bash
npm run database:migrate:prod
```

### 4. Initialize Market Data

```bash
npm run market:init:prod
```

### 5. Deploy

```bash
npm run build       # TypeScript check + Vite build
npm run pages:deploy  # Deploy to Cloudflare Pages
```

### 6. Configure Email Whitelist

```bash
wrangler d1 execute alpha-life-prod --command="INSERT OR IGNORE INTO email_whitelist (email, notes) VALUES ('admin@example.com', '管理员');" --remote
```

### 7. Set Up GitHub Actions

Two workflows are provided:

#### CI Verification (`.github/workflows/ci-verify.yml`)
Triggers on PRs modifying `package.json`, lockfile, or workflow files.

#### Daily Market Update (`.github/workflows/daily-market-update.yml`)
Runs at 08:00 CST on trading days. Requires:
- `CLOUDFLARE_API_TOKEN` secret
- `CLOUDFLARE_ACCOUNT_ID` secret

## Domain Setup

1. Add your domain to Cloudflare
2. Update DNS with Cloudflare nameservers
3. Configure route in wrangler.toml:
   ```
   routes = [{ pattern = "alpha-life.yourdomain.com/*", zone_name = "yourdomain.com" }]
   ```
4. Update CORS origin in `functions/api/[[route]].ts`

## Production Checklist

- [ ] D1 database created and migrated
- [ ] `CLOUDFLARE_API_TOKEN` with Workers, D1, and Pages permissions
- [ ] `RESEND_API_KEY` configured (or console log fallback for dev)
- [ ] Email whitelist populated
- [ ] Market data initialized
- [ ] GitHub Secrets configured
- [ ] CORS origins updated for production domain
- [ ] SSL enabled via Cloudflare
- [ ] `ENVIRONMENT` variable set to `production` in wrangler.toml

## Monitoring

- Workers logs: Cloudflare Dashboard → Workers → alpha-life-engine → Logs
- D1 queries: Cloudflare Dashboard → D1 → alpha-life-prod → Queries
- CI status: GitHub Actions tab
- Market data freshness: Dashboard strategy evolution status indicator
