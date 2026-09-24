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
1. `scripts/init-env.sh stg`, then fill in the values it leaves open: `ANTHROPIC_API_KEY` (a key of its own for this environment, with a spend limit set in the Anthropic Console; on stg you can pick a cheaper `ANTHROPIC_MODEL`), the two `https://` URLs that must match the environment's domains in `.env.edge` — `NEXT_PUBLIC_API_URL` in `.env.stg` (the API domain) and `CORS_ORIGINS` in `backend/.env.stg` (the app domain) — and the LINE/Telegram bot credentials (a **separate bot per environment** — a webhook URL belongs to exactly one bot). `NEXT_PUBLIC_*` values are baked into the frontend at build time, so changing one needs `up -d --build`; the API refuses to start in production without `CORS_ORIGINS`.
2. Start it:
   ```bash
   docker compose -p receipt-stg --env-file .env.stg -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```
   Order of events on `up`: Postgres/Redis/MinIO become healthy → the one-shot `migrate` service applies pending Prisma migrations (as the DB owner; the API and worker never hold that credential) → the API and worker start → the API reports `healthy` once `GET /health` answers. If `migrate` fails, the API and worker do not start: `docker compose -p receipt-stg logs migrate`.
3. Start (or reload) the edge — once, and again whenever you enable/disable an environment or change a domain:
   ```bash
   docker compose -p receipt-edge --env-file .env.edge -f docker-compose.edge.yml up -d
   ```
4. Smoke test: `curl -fsS https://<api domain>/health` → `{"status":"ok","checks":{"database":"up","redis":"up"}}` (503 with the failing dependency marked `down` otherwise), and `dc ps` (helper below) shows the API as `healthy`. `/health` is public and reports only up/down; it is also what an uptime monitor should poll.

**Migrations.** They run automatically on every `up` and are **forward-only** (`prisma migrate deploy` applies only what's pending; there is no automatic down). For a breaking schema change use expand/contract across two deploys. On a Postgres volume that already existed before the first `up`, create the `receipts_app` role by hand first — `docker/postgres/init-app-role.sh` only runs on a fresh volume (the command is in its header); the `enable_rls` migration creates the role without a password if it's missing, and the API then can't log in.

**Day 2** — nothing is published, so go through the containers. Every command needs the same project name, env file and compose files (without them compose loads only the base file and fails on the missing dev env files), so define a helper once per shell:
```bash
dc() { docker compose -p receipt-stg --env-file .env.stg -f docker-compose.yml -f docker-compose.prod.yml "$@"; }
dc ps                                        # states, incl. the API's health
dc logs -f backend worker                    # follow the app logs
dc logs migrate                              # what the last migration run did
dc exec postgres psql -U receipts receipts_saas
```
 Logs are rotated (10 MB × 3 per container). Keep the `caddy-data` volume (`receipt-edge_caddy-data`): it holds the certificates.

**Backups.** `scripts/backup.sh <stg|production>` dumps that environment's Postgres database (via `docker compose exec postgres pg_dump`, no separate credentials needed) and mirrors its MinIO receipt-images bucket, uploading both to off-VM storage through `rclone` — set once with `rclone config` (an OCI Object Storage bucket, S3-compatible, fits the free-tier hosting plan) and referenced by the `OFFSITE_RCLONE_REMOTE` env var the script requires. MinIO publishes no host port, so the bucket mirror runs as a one-off `rclone/rclone` container on the environment's own compose network rather than needing rclone reachable from the VM host directly. Schedule it on the VM, e.g. daily via cron:
```cron
0 3 * * * OFFSITE_RCLONE_REMOTE=oci-backup:receipt-backups /path/to/repo/scripts/backup.sh production >> /var/log/receipt-backup.log 2>&1
```
It prunes nothing — old off-VM backups accumulate until you decide on a retention policy — and it does not test a restore; do that by hand periodically (`gunzip -c <dump>.sql.gz | docker compose ... exec -T postgres psql -U receipts -d a_scratch_db`, against a throwaway database, never the live one). A failed cron run exits non-zero, so redirecting into a logged file that a monitoring check tails (see **Monitoring** below) is what actually surfaces a broken backup — cron's own default of emailing on non-zero exit only works if the VM can send mail, which a fresh box usually can't.

**Rollback.** Both `deploy-stg.yml` and `deploy-production.yml` deploy whatever commit SHA triggered them (`github.sha`), not always "the latest" — so rolling back is re-running the same workflow against an older ref: `gh workflow run deploy-production.yml --ref <previous tag or commit>` (or the stg equivalent), which SSHes in, checks out that SHA, and re-runs `docker compose up -d --build --wait` — the same path as a forward deploy, so there's nothing rollback-specific to get wrong. **Migrations are forward-only** (`prisma migrate deploy` never runs a down-migration), so a rollback after a schema change needs the migration itself to have been written expand/contract style: add new columns/tables as nullable or with defaults in one deploy (safe for the old code to ignore), switch the application code over in the next, and only drop the old column/table in a third deploy once nothing references it — that way the previous commit's code still works against the post-migration schema and a code-only rollback (without also reverting the DB) doesn't break. A rollback that must also reverse a completed migration has no automated path — restore from the backup above instead.

**Monitoring.** `/health` is the uptime check — point a free external monitor (e.g. UptimeRobot, Better Stack) at `https://<api domain>/health` on a 1–5 minute interval; it's public and reports only up/down, matching what's already used as the deploy smoke test. Container restarts: every service has `restart: unless-stopped`, so Docker itself recovers a crashed container, but repeated restarts indicate a real problem — `dc ps` shows each container's restart count, worth an occasional glance, or `docker events --filter event=restart` tailed into the same log a cron job checks. Disk space: `df -h` on the VM (Postgres/MinIO data and rotated logs are the only things that grow unbounded); a simple cron line (`df --output=pcent / | tail -1`) piped to the same alerting path as the backup log covers it without a separate tool. Claude spend: query `usage_logs` periodically (`SELECT date_trunc('day', "createdAt"), sum("estimatedCostUsd") FROM usage_logs GROUP BY 1 ORDER BY 1 DESC LIMIT 30;` via `dc exec postgres psql`) — there's no automated alert on this yet, and `estimatedCostUsd` is a rough placeholder rate (see `receipts.service.ts`), so treat it as a trend indicator, not a bill.

**Firewall (Oracle VM) — written down, not yet applied.** The VM doesn't exist until Step 3; apply this then and run the verification below.
- *Layer 1, the VCN security list (ingress):* TCP 22 (from your own IP if it's stable), TCP 80 and TCP 443 from anywhere — nothing else. UDP 443 stays closed (Caddy is only published on TCP, so no HTTP/3).
- *Layer 2, iptables on the VM:* check `sudo iptables -S INPUT`, allow 22/80/443 plus established/loopback, drop the rest, and persist it (e.g. `netfilter-persistent save`). **Caveat:** ports that Docker publishes are DNATed and filtered in the `FORWARD`/`DOCKER` chains, not `INPUT`, so INPUT rules do not protect published container ports. That is why the compose setup publishes *only* Caddy's 80/443 and nothing else — the firewall is the second line, not the first. If a container port ever has to be published, restrict it in the `DOCKER-USER` chain.
- *Verify (from outside):* `nmap -Pn -p- <vm-public-ip>` must show only 22, 80 and 443 open. *On the VM:* `docker ps --format '{{.Names}}\t{{.Ports}}'` shows ports only for `receipt-edge-caddy-1`.

**Still open** (Step 3): none of this has run on the Oracle VM yet — ARM64 images, real DNS/HTTPS certificates and the firewall are verified there. The deployed stack itself is complete: schema applied by `migrate`, the frontend built against the environment's API URL, CORS limited to the environment's app domain, and a `/health` endpoint to smoke-test with.

## Roadmap

Step 1 (branches, CI, these docs) and Step 2 (make the stack deployable) are done.

**Source of truth for what's next: [GitHub Issues](https://github.com/Armskk/receipt-saas/issues)**, labeled `area:*`/`priority:*`. Steps 3–4 below no longer carry live checkboxes for open work — only the already-shipped items, kept as a technical reference since they document what was built and why. Tracking issues: [#24](https://github.com/Armskk/receipt-saas/issues/24) (stg), [#25](https://github.com/Armskk/receipt-saas/issues/25) (production), [#23](https://github.com/Armskk/receipt-saas/issues/23) (accuracy test set), [#27](https://github.com/Armskk/receipt-saas/issues/27) (case study numbers), [#26](https://github.com/Armskk/receipt-saas/issues/26) (beta), [#28](https://github.com/Armskk/receipt-saas/issues/28) (AWS migration, deferred).

### Step 2 — make the stack deployable
- [x] Fix the two known bugs first: (a) ~~`ReceiptProcessingProcessor` is registered in `QueueModule`, which both `main.ts` and `worker.ts` load, so the API also consumes jobs and calls Claude — register it only in the worker process~~ **done** — it's now provided only by `WorkerModule`, the worker's root module; (b) ~~API/worker race creating the MinIO bucket in `storage.service.ts#onModuleInit` — tolerate `BucketAlreadyOwnedByYou`~~ **done** — `onModuleInit` now treats `BucketAlreadyOwnedByYou` from `makeBucket` as success (other errors, including `BucketAlreadyExists`, still throw).
- [x] `docker-compose.prod.yml` override — **done**: no environment publishes any host port (Postgres/Redis/MinIO/backend/frontend/worker are only on the project's private network; backend and frontend also join the shared `receipt-edge` network under per-environment aliases); the per-project Caddy is switched off; each env runs as its own project (`-p receipt-stg` / `-p receipt-prod`) and **one shared Caddy** (`docker-compose.edge.yml`, `deploy/edge/`) is the only thing publishing 80/443 and routes by domain. The dev stack now binds its ports to `127.0.0.1` only. See the runbook above; `scripts/check-compose.mjs` (CI job `compose`) enforces it.
- [x] Per-env env files — **done**: `scripts/init-env.sh <stg|production|edge>` writes the gitignored files with fresh random secrets per environment (and wires the compose hostnames; the DB *owner* URL is kept out of the API/worker env). `.gitignore` previously did **not** ignore `.env.stg`/`.env.production`; it now ignores every `.env.*` except `*.example`. Still to do by hand: a spend cap / cheaper model on stg is an Anthropic Console + `ANTHROPIC_MODEL` setting.
- [x] Frontend build arg — **done**: `frontend/Dockerfile` takes `NEXT_PUBLIC_API_URL` (and the optional `NEXT_PUBLIC_LINE_ADD_FRIEND_URL` / `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`) as build args, `docker-compose.prod.yml` passes them per environment from `.env.<env>`, and the frontend has no runtime env any more. There was no `.dockerignore` at all, so `COPY . .` baked `backend/.env` / `frontend/.env.local` (and on the VM `backend/.env.stg`) into the images; both now have one that excludes every env file.
- [x] Migrations in deploy — **done**: a `migrate` build stage (from the builder stage, which has the Prisma CLI) and a one-shot `migrate` service in `docker-compose.prod.yml` running `prisma migrate deploy` with `OWNER_DATABASE_URL`; the API and worker wait for it (`service_completed_successfully`). The manual step for an existing volume (create `receipts_app` first) is in the runbook.
- [x] Restrict CORS — **done**: `CORS_ORIGINS` (comma-separated bare origins) is the allow-list; unset in dev it defaults to `http://localhost:3000`, unset in production the API refuses to start, and `*` or malformed entries are rejected (`backend/src/common/cors.ts`).
- [x] `GET /health` — **done**: public, 200 when Postgres and Redis answer (2 s timeout each), 503 naming the failing one otherwise, no error text; the API's compose healthcheck uses it.
- [x] Caddy — **done**: per-env domains (`STG_APP_DOMAIN`, `STG_API_DOMAIN`, `PROD_APP_DOMAIN`, `PROD_API_DOMAIN` in `.env.edge`), enabled per environment; HTTPS is automatic (verified locally with `*.localhost` domains and Caddy's internal CA; public certificates need real DNS, Step 3).
- [x] Oracle VM firewall (security list + iptables): documented in the runbook above; open only 22/80/443. Applying and verifying it needs the VM itself — folded into [#24](https://github.com/Armskk/receipt-saas/issues/24) rather than tracked separately here. The compose side is already safe without it — nothing but Caddy publishes a port.

### Step 3 — first deployment: stg
Live tracking: [#24](https://github.com/Armskk/receipt-saas/issues/24). Step-by-step checklist for the parts that have to be done by hand (Oracle account, DNS, LINE/Telegram credentials, GitHub secrets): `docs/stg-provisioning-checklist.md`.
- [x] `.github/workflows/deploy-stg.yml` — **done**: on push to `stg` (or manual `workflow_dispatch`), SSHes to the VM, `git checkout`s the pushed commit, runs `docker compose -p receipt-stg -f … up -d --build --wait` (build on the VM so images are natively ARM64; `--wait` blocks on the `migrate` service and the API's healthcheck, so a failed migration fails the deploy), then curls `/health`. Needs the GitHub Environment `stg` with secrets `STG_SSH_HOST`/`STG_SSH_USER`/`STG_SSH_KEY` and variables `STG_DEPLOY_PATH`/`STG_API_DOMAIN` — not yet created (`docs/stg-provisioning-checklist.md`, item 9).

### Step 4 — production (`main`)
Live tracking: [#25](https://github.com/Armskk/receipt-saas/issues/25). Hand-provisioning checklist: `docs/production-provisioning-checklist.md`.
- [x] `.github/workflows/deploy-production.yml` — **done**: mirrors `deploy-stg.yml` (SSH in, checkout the triggering SHA, `docker compose -p receipt-prod … up -d --build --wait`, smoke-test `/health`) against the `receipt-prod` project and `.env.production`. Triggers only on a `v*` tag push or manual `workflow_dispatch`, never every push to `main` — a deliberate extra gate for production, kept even though the repo being public (Step 5) makes environment required-reviewers available too.
- [x] Backups — **done**: `scripts/backup.sh production` (see the "Backups" section above) dumps Postgres and mirrors the MinIO bucket to off-VM storage via `rclone`. Still to do by hand: configure the `rclone` remote (OCI Object Storage), schedule the cron job, and run one test restore.
- [x] Rollback procedure — **done**: documented in the "Rollback" section above (re-run the deploy workflow against an older ref; expand/contract for schema changes, since migrations are forward-only).
- [x] Monitoring — **done** (as documentation + one script): the "Monitoring" section above covers `/health` uptime checks, container-restart and disk-space alerting, and reviewing Claude spend via `usage_logs`. Still to do by hand: actually point an external uptime monitor at `/health`.

### Step 5 — optional, when justified
- [x] Make the repo public — **done**: [github.com/Armskk/receipt-saas](https://github.com/Armskk/receipt-saas) is public (git history was scanned for secrets first — see `docs/decisions.md`).
- [x] Make `flow-guard`, `backend` and `frontend` required status checks, protect `stg`/`main` — **done**: both branches require those 3 checks (up to date with the base before merging), block force-pushes and deletions, and `enforce_admins` is on (the rule applies even to the repo owner — pushing directly to `stg`/`main` was already forbidden by convention; this makes it forbidden in practice too). `compose` isn't required — it verifies deploy config, not app correctness, and isn't part of what blocks a promotion PR. Environment required-reviewers on `production` isn't set up yet: that Environment doesn't exist until Step 4 creates it (see `docs/production-provisioning-checklist.md`, item 10).
