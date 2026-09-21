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

Real env files (`.env`, `backend/.env`, `.env.stg`, `.env.production`, `.env.edge`, `backend/.env.stg`, …) are gitignored (`.gitignore` ignores every `.env.*` except `*.example`); only `*.example` files are committed. Create the deployed ones with `scripts/init-env.sh <stg|production|edge>` — it generates fresh random secrets per environment so two environments can never share one.

## Deploying an environment (runbook)

The layout: **one compose project per environment** (`receipt-stg`, `receipt-prod`), each with its own containers, volumes, secrets and env files, plus **one shared Caddy** (project `receipt-edge`) that terminates HTTPS and routes by domain. Only that Caddy publishes host ports (80/443). Files: `docker-compose.yml` (base, also the dev stack) + `docker-compose.prod.yml` (override for stg/production), `docker-compose.edge.yml` + `deploy/edge/` (the Caddy), `scripts/init-env.sh` (env files), `scripts/check-compose.mjs` (checks all of this; runs in CI). Needs Docker Compose ≥ 2.24.

```
                       internet ──► :80/:443 ──► receipt-edge: caddy
                                                     │  (docker network "receipt-edge")
                          stg-frontend / stg-backend │ production-frontend / production-backend
                    ┌────────────────────────────────┴──────────┐
        receipt-stg: frontend, backend ── private net ── postgres, redis, minio, worker   (same for receipt-prod)
```

Postgres, Redis, MinIO and the worker are on the environment's private network only — Caddy can't even resolve them. Backend and frontend join the edge network under per-environment aliases (`<env>-backend`, `<env>-frontend`), so the two environments' services can't be mixed up.

**One-time, per VM**
1. DNS: A records for each environment's app and API domain → the VM's public IP (Caddy needs them to get certificates).
2. `docker network create receipt-edge`
3. `scripts/init-env.sh edge`, then in `.env.edge` set the four domains and enable the environment(s) you deploy by uncommenting `EDGE_STG_SITE` / `EDGE_PROD_SITE` (an environment that isn't enabled isn't served and no certificate is requested for it).
4. Firewall — see below.

**Per environment** (`stg` shown; `production` is the same with `-p receipt-prod`)
1. `scripts/init-env.sh stg`, then fill in the values it leaves open: `ANTHROPIC_API_KEY` (a key of its own for this environment, with a spend limit set in the Anthropic Console; on stg you can pick a cheaper `ANTHROPIC_MODEL`), `NEXT_PUBLIC_API_URL` (the environment's `https://` API URL), and the LINE/Telegram bot credentials (a **separate bot per environment** — a webhook URL belongs to exactly one bot).
2. Start it:
   ```bash
   docker compose -p receipt-stg --env-file .env.stg -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```
3. Start (or reload) the edge — once, and again whenever you enable/disable an environment or change a domain:
   ```bash
   docker compose -p receipt-edge --env-file .env.edge -f docker-compose.edge.yml up -d
   ```

**Day 2** — nothing is published, so go through the containers: `docker compose -p receipt-stg exec postgres psql -U receipts receipts_saas`, `docker compose -p receipt-stg logs -f backend worker`. Logs are rotated (10 MB × 3 per container). Keep the `caddy-data` volume (`receipt-edge_caddy-data`): it holds the certificates.

**Firewall (Oracle VM) — written down, not yet applied.** The VM doesn't exist until Step 3; apply this then and run the verification below.
- *Layer 1, the VCN security list (ingress):* TCP 22 (from your own IP if it's stable), TCP 80 and TCP 443 from anywhere — nothing else. UDP 443 stays closed (Caddy is only published on TCP, so no HTTP/3).
- *Layer 2, iptables on the VM:* check `sudo iptables -S INPUT`, allow 22/80/443 plus established/loopback, drop the rest, and persist it (e.g. `netfilter-persistent save`). **Caveat:** ports that Docker publishes are DNATed and filtered in the `FORWARD`/`DOCKER` chains, not `INPUT`, so INPUT rules do not protect published container ports. That is why the compose setup publishes *only* Caddy's 80/443 and nothing else — the firewall is the second line, not the first. If a container port ever has to be published, restrict it in the `DOCKER-USER` chain.
- *Verify (from outside):* `nmap -Pn -p- <vm-public-ip>` must show only 22, 80 and 443 open. *On the VM:* `docker ps --format '{{.Names}}\t{{.Ports}}'` shows ports only for `receipt-edge-caddy-1`.

**Known gaps until the rest of Step 2 lands** (so a first `up` of stg won't be a working app yet): the schema isn't applied (the production backend image has no Prisma CLI — "Migrations in deploy" below), `NEXT_PUBLIC_API_URL` isn't baked into the frontend build (build arg below), CORS is still open, and there's no `/health` endpoint to smoke-test.

## Roadmap

Step 1 (branches, CI, these docs) is done. The rest is queued in this order.

### Step 2 — make the stack deployable
- [x] Fix the two known bugs first: (a) ~~`ReceiptProcessingProcessor` is registered in `QueueModule`, which both `main.ts` and `worker.ts` load, so the API also consumes jobs and calls Claude — register it only in the worker process~~ **done** — it's now provided only by `WorkerModule`, the worker's root module; (b) ~~API/worker race creating the MinIO bucket in `storage.service.ts#onModuleInit` — tolerate `BucketAlreadyOwnedByYou`~~ **done** — `onModuleInit` now treats `BucketAlreadyOwnedByYou` from `makeBucket` as success (other errors, including `BucketAlreadyExists`, still throw).
- [x] `docker-compose.prod.yml` override — **done**: no environment publishes any host port (Postgres/Redis/MinIO/backend/frontend/worker are only on the project's private network; backend and frontend also join the shared `receipt-edge` network under per-environment aliases); the per-project Caddy is switched off; each env runs as its own project (`-p receipt-stg` / `-p receipt-prod`) and **one shared Caddy** (`docker-compose.edge.yml`, `deploy/edge/`) is the only thing publishing 80/443 and routes by domain. The dev stack now binds its ports to `127.0.0.1` only. See the runbook above; `scripts/check-compose.mjs` (CI job `compose`) enforces it.
- [x] Per-env env files — **done**: `scripts/init-env.sh <stg|production|edge>` writes the gitignored files with fresh random secrets per environment (and wires the compose hostnames; the DB *owner* URL is kept out of the API/worker env). `.gitignore` previously did **not** ignore `.env.stg`/`.env.production`; it now ignores every `.env.*` except `*.example`. Still to do by hand: a spend cap / cheaper model on stg is an Anthropic Console + `ANTHROPIC_MODEL` setting.
- [ ] Frontend build arg: `NEXT_PUBLIC_API_URL` is inlined at `next build` but compose only supplies it at runtime — add `ARG NEXT_PUBLIC_API_URL` to `frontend/Dockerfile`, pass it per environment, and check `.dockerignore` so `.env.local` isn't copied into images.
- [ ] Migrations in deploy: the production image has no Prisma CLI (`npm install --omit=dev`; `prisma` is a devDependency). Add a one-shot `migrate` service/stage running `prisma migrate deploy` with the **owner** `DATABASE_URL` before `backend`/`worker` start. `receipts_app` must exist first — `docker/postgres/init-app-role.sh` only runs on a fresh volume, so document the manual step for existing ones.
- [ ] Restrict CORS: `main.ts` calls `app.enableCors()` with no origin — limit it to `APP_DOMAIN` outside dev.
- [ ] Add `GET /health` (DB + Redis) for deploy smoke tests and uptime checks.
- [x] Caddy — **done**: per-env domains (`STG_APP_DOMAIN`, `STG_API_DOMAIN`, `PROD_APP_DOMAIN`, `PROD_API_DOMAIN` in `.env.edge`), enabled per environment; HTTPS is automatic (verified locally with `*.localhost` domains and Caddy's internal CA; public certificates need real DNS, Step 3).
- [ ] Oracle VM firewall (security list + iptables): open only 22/80/443. The procedure and how to verify it are in the runbook above; it can only be applied and checked once the VM exists (Step 3). The compose side is already safe without it — nothing but Caddy publishes a port.

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
