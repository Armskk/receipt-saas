# Branches & environments

## Flow

```
feature/*  →  dev  →  stg  →  main (= production)
```

| Branch | Environment | Where it runs |
|---|---|---|
| `feature/*`, `chore/*`, `fix/*` | — | your machine |
| `dev` | dev | local `docker compose` (not deployed anywhere) |
| `stg` | staging | Oracle VM (planned, Step 3) |
| `main` | production | Oracle VM (planned, Step 4) |

`dev` is the repository default branch, so new PRs target it by default.

**Rules**
- Work on a branch cut from `dev` and open a PR into `dev` (squash or merge commit).
- Promote with PRs `dev → stg` and `stg → main`. **Use merge commits, never squash** — squashing makes the long-lived branches diverge. `dev` will lag by the promotion merge commits; the content is identical.
- Emergency fixes may go `hotfix/* → main`, then must be merged back into `stg` and `dev`.
- Never commit directly to `stg` or `main`.

**Enforcement.** The repo is private on GitHub Free, which does not offer branch protection, rulesets or environment required-reviewers, so nothing *forces* this. Instead `.github/workflows/ci.yml` runs on every PR/push to these branches: `flow-guard` (fails a PR in the wrong direction), `backend` (eslint, build, integration tests against Postgres) and `frontend` (lint, build). Merge only when green. Making the repo public or upgrading to Pro would let these become required checks (Step 5).

## Environment matrix

| | dev | stg | production |
|---|---|---|---|
| Runs on | laptop (compose) | Oracle VM, compose project `receipt-stg` | Oracle VM, compose project `receipt-prod` |
| Postgres / Redis / MinIO | local containers | own containers + volumes | own containers + volumes |
| `JWT_SECRET`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, MinIO creds | dev values | **different** values | **different** values |
| LINE / Telegram bot | test bot (optional) | **separate bot** — a webhook URL belongs to exactly one bot | real bot |
| Domain | localhost | e.g. `stg.` / `api-stg.` | real domain |
| Data | synthetic | synthetic | real — **never copy production data elsewhere** (personal financial data) |

Real env files (`.env`, `backend/.env`, `.env.stg`, `.env.production`, …) are gitignored; only `*.example` files are committed.

## Roadmap

Step 1 (branches, CI, these docs) is done. The rest is queued in this order.

### Step 2 — make the stack deployable
- [ ] Fix the two known bugs first: (a) ~~`ReceiptProcessingProcessor` is registered in `QueueModule`, which both `main.ts` and `worker.ts` load, so the API also consumes jobs and calls Claude — register it only in the worker process~~ **done** — it's now provided only by `WorkerModule`, the worker's root module; (b) API/worker race creating the MinIO bucket in `storage.service.ts#onModuleInit` — tolerate `BucketAlreadyOwnedByYou`.
- [ ] `docker-compose.prod.yml` override: drop the published ports for Postgres/Redis/MinIO (`5432/6379/9000/9001` are currently open on all interfaces); expose backend/frontend only to Caddy (or `127.0.0.1`); only Caddy publishes 80/443. Run each env as its own project (`docker compose -p receipt-stg …`, `-p receipt-prod …`); one Caddy routes by domain.
- [ ] Per-env env files (gitignored) with distinct secrets; consider a spend cap / cheaper model for `ANTHROPIC_API_KEY` on stg.
- [ ] Frontend build arg: `NEXT_PUBLIC_API_URL` is inlined at `next build` but compose only supplies it at runtime — add `ARG NEXT_PUBLIC_API_URL` to `frontend/Dockerfile`, pass it per environment, and check `.dockerignore` so `.env.local` isn't copied into images.
- [ ] Migrations in deploy: the production image has no Prisma CLI (`npm install --omit=dev`; `prisma` is a devDependency). Add a one-shot `migrate` service/stage running `prisma migrate deploy` with the **owner** `DATABASE_URL` before `backend`/`worker` start. `receipts_app` must exist first — `docker/postgres/init-app-role.sh` only runs on a fresh volume, so document the manual step for existing ones.
- [ ] Restrict CORS: `main.ts` calls `app.enableCors()` with no origin — limit it to `APP_DOMAIN` outside dev.
- [ ] Add `GET /health` (DB + Redis) for deploy smoke tests and uptime checks.
- [ ] Caddy: per-env `APP_DOMAIN` / `API_DOMAIN`; HTTPS is automatic.
- [ ] Oracle VM firewall (security list + iptables): open only 22/80/443.

### Step 3 — first deployment: stg
- [ ] Provision the Oracle Ampere (**ARM64**) VM, install Docker, create stg DNS records.
- [ ] Create a separate LINE channel and Telegram bot for stg and register the stg webhooks.
- [ ] GitHub Environment `stg` with the deploy secrets (SSH key/host). `.github/workflows/deploy-stg.yml` on push to `stg`: SSH → `git pull` → `docker compose -p receipt-stg -f … up -d --build` (build on the VM so images are natively ARM64) → run migrate → hit `/health`.
- [ ] Synthetic data only on stg.
- [ ] Run the end-to-end check against stg: signup → upload → parse → confirm → summary, and cross-tenant 404/403.

### Step 4 — production (`main`)
- [ ] GitHub Environment `production` + secrets. Required reviewers aren't available on private/Free, so trigger deploys with `workflow_dispatch` (manual) or a `v*` tag rather than on every push to `main`.
- [ ] `deploy-production.yml`: same as stg with the prod env file; deploy only from `main`.
- [ ] Backups: scheduled `pg_dump` (cron on the VM) to off-VM storage (e.g. OCI Object Storage free tier); test a restore; back up the MinIO receipt images too.
- [ ] Rollback procedure: redeploy the previous commit/tag. Migrations are forward-only, so document expand/contract for breaking schema changes.
- [ ] Monitoring: uptime check on `/health`, container-restart and disk-space alerts, periodic review of Claude spend via `usage_logs`.
- [ ] Register production LINE/Telegram webhooks; rotate any secret that was ever pasted into chat or logs.

### Step 5 — optional, when justified
- [ ] Make the repo public or upgrade to Pro: make `flow-guard`, `backend` and `frontend` required status checks, protect `stg`/`main`, enable environment required-reviewers.
