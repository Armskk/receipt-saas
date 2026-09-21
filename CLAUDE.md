# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AI agent-powered receipt/expense tracking SaaS. Users send receipt photos via web upload, LINE, or Telegram; Claude extracts structured line items and stores them per-workspace (multi-tenant) in Postgres.

```
receipt-saas/
├── backend/    NestJS API + BullMQ worker (TypeScript)
│   └── prisma/   Postgres schema, migrations, rls.sql
└── frontend/   Next.js dashboard (TypeScript, App Router)
```

## Commands

Backend (`cd backend`):
- `npm run start:dev` — API server with watch mode (port from `PORT` env, default 3001)
- `npm run worker` — BullMQ worker process via ts-node (must run alongside the API; it's what actually calls Claude)
- `npm run build` — `nest build`; `npm run start:prod` runs the built API, `npm run worker:prod` runs the built worker
- `npm run lint` — eslint with `--fix` over `src`
- `npm test` — jest (in-band). The specs are integration tests against a real Postgres because RLS can't be mocked: set `TEST_DATABASE_URL` (owner role) and `TEST_APP_DATABASE_URL` (`receipts_app` role) to a dedicated `*_test` database — jest's global setup creates it if missing and runs `prisma migrate deploy`. Run a single file with `npx jest path/to/file.spec.ts`
- `npm run e2e` — full split API/worker check (`scripts/e2e/`, see its README): runs the *built* API and worker as separate processes against a throwaway DB + bucket and a **real Claude call (~7 requests)**. Needs `npm run build`, `docker compose up -d postgres redis minio` and an idle queue; not part of CI
- `npm run prisma:generate` — regenerate the Prisma client after editing `schema.prisma`
- `npm run prisma:migrate` — `prisma migrate dev`. RLS policies and the app role's grants live in the hand-written `*_enable_rls` migration, so migrating applies them — there is no separate SQL script to run. `DATABASE_URL` (owner role) is used by the Prisma CLI only; the API and worker connect as the non-privileged `receipts_app` role via `APP_DATABASE_URL`. On a fresh Postgres volume `docker/postgres/init-app-role.sh` creates that role from `APP_DB_PASSWORD`; on an existing volume create it once by hand (the script's header has the command)

Frontend (`cd frontend`): `npm run dev`, `npm run build`, `npm run lint`.

Infra: `docker compose up -d postgres redis minio` for local dev deps (their ports bind to `127.0.0.1` only); full dev stack including Caddy via `docker compose up -d --build` (see root `.env.example`, `backend/.env.example`, `frontend/.env.example` for required vars — `ANTHROPIC_API_KEY`, `DATABASE_URL`, `APP_DATABASE_URL`, `JWT_SECRET` are the minimum to run anything). **Deployed environments** (stg/production) are separate compose projects layered with `docker-compose.prod.yml` — they publish no host ports; one shared Caddy (`docker-compose.edge.yml`) is the only thing on 80/443. Create their env files with `scripts/init-env.sh` (never hand-copy secrets between environments); runbook in `docs/environments.md`. `node scripts/check-compose.mjs` (CI job `compose`) verifies the setup without starting containers.

## Architecture

**Modular monolith, not microservices.** One NestJS app (`backend/src/app.module.ts`) with bounded modules, plus a BullMQ worker that's the *same codebase* running as a separate process (`backend/src/worker.ts` vs `backend/src/main.ts`). The worker boots its own root module, `queue/worker.module.ts` (`WorkerModule`), not `AppModule`; that's the only place `ReceiptProcessingProcessor` and `AgentModule` are registered, so the API never consumes jobs or reaches Claude (`queue/worker-module.spec.ts` enforces it) — split a module into its own service only if a real scaling need shows up.

**Why there's a separate worker process:** ingestion controllers (`ingestion/*.controller.ts`) only validate the incoming image and enqueue a `process` job on the `RECEIPT_PROCESSING_QUEUE`, then return immediately — this matters because LINE/Telegram webhooks expect a fast 200 OK. `queue/receipt-processing.processor.ts`, running in the `worker` process, is what actually downloads the image from storage, calls `agent/agent.service.ts` (the Claude API), and writes results via `receipts/receipts.service.ts`. The API process must stay responsive even while Claude is "thinking" on a receipt.

**Ingestion → queue → agent → persistence pipeline**, in order:
1. `ingestion/web-upload.controller.ts` (JWT + `WorkspaceGuard`), `ingestion/line.controller.ts` (HMAC-SHA256 signature over the raw body — `main.ts` enables `rawBody: true` for exactly this), or `ingestion/telegram.controller.ts` (shared-secret header) each resolve a `Workspace`, upload image(s) to MinIO via `common/storage.service.ts`, and call `receipts.createPending()`.
2. A job `{ receiptId, workspaceId }` goes on the queue (`queue/receipt-processing.types.ts`).
3. `queue/receipt-processing.processor.ts` marks the receipt `PROCESSING`, fetches the image(s) back from storage as base64, and calls `agent.service.ts`.
4. `agent/agent.service.ts` is the **only** place that talks to the Claude API. It forces structured output via `tool_choice` on a single `record_receipt` tool (not a "please respond in JSON" prompt), then validates the result against `agent/dto/parsed-receipt.dto.ts` with `class-validator` before returning it — a bad/partial model response can't reach the database.
5. `receipts.service.ts#applyParsedResult` writes the receipt header, upserts `Category` rows by name within the workspace, creates `ReceiptItem` rows, and logs a `UsageLog` row (tokens + estimated cost) — all in one `$transaction`.

**One upload can carry multiple photos of the same receipt** (long receipt shot in sections, front/back, multi-page bill): `Receipt.imageKeys` is a string array, all images go to Claude in a single call, and the agent is prompted to merge them into one result without double-counting overlapping line items. LINE/Telegram messages always carry exactly one image.

**Receipt status machine:** `PENDING` → `PROCESSING` → `PARSED` (agent succeeded, awaiting user confirmation) → `CONFIRMED`, or `PROCESSING` → `FAILED` (with `failureReason`). Only `PARSED`/`CONFIRMED` receipts count toward spend in `receipts.service.ts#monthlySummary`.

**Multi-tenancy is enforced twice.** Every workspace-scoped table carries `workspaceId` (or, for `ReceiptItem`, scopes indirectly through its parent `Receipt`). Application-level: `workspaces/workspace.guard.ts` checks the JWT user is a member of the `:workspaceId` route param before any handler runs. Database-level: the `*_enable_rls` migration turns on Postgres Row-Level Security for `categories`, `receipts`, `receipt_items` (via the parent receipt) and `usage_logs`, gated on `current_setting('app.current_workspace_id')` — a second line of defense so a query that forgot its `WHERE workspaceId = ...` returns nothing instead of another tenant's rows. **Every query on those tables must run inside `PrismaService.withWorkspace(workspaceId, tx => ...)`, which sets the variable transaction-locally; outside it RLS returns zero rows.** `users`, `workspaces` and `workspace_members` are intentionally not under RLS (they're read before a workspace is known: signup, "my workspaces", webhook channel-id lookup). RLS only applies to a non-superuser role, so the app connects as `receipts_app` (`APP_DATABASE_URL`) and `PrismaService` refuses to start in production if it's connected as a role that bypasses RLS. Rationale in `docs/decisions.md`.

**LINE/Telegram → workspace linking:** the dashboard's *Connect chat* page (`frontend/app/connect/page.tsx`) calls `POST /workspaces/:id/channels/:channel/link-code` (owner/admin only, `workspaces/workspace-channels.controller.ts`) for a one-time code (`ABCD-2345`: 10 minutes, single use, only its SHA-256 is stored in `channel_link_codes`). The user sends the code to the bot (Telegram also accepts `/start <code>`); `ingestion/line.controller.ts` / `telegram.controller.ts` pass text messages to `workspaces/channel-link.service.ts#handleText`, which redeems the code and sets `Workspace.lineUserId` / `telegramChatId`, and the bot answers through `ingestion/channel-messenger.service.ts`. A photo from a chat that isn't linked gets a how-to reply and is dropped. `channel_link_codes` is deliberately **not** under RLS — the code is redeemed before the workspace is known (see `docs/decisions.md`).

**Auth:** `auth/auth.service.ts` issues JWTs (`@nestjs/jwt`, `passport-jwt` strategy in `auth/jwt.strategy.ts`) on signup/login. Sign-up always creates a brand-new `Workspace` with the user as `OWNER` — there's no "join an existing workspace" invite flow yet. Frontend stores the token in `localStorage` (`frontend/app/lib/api.ts`) and attaches it as a Bearer header via `apiFetch`; a 401 clears the token and bounces to `/login`.

**Frontend ↔ backend contract:** `frontend/app/lib/api.ts` is the only place that calls the backend — it mirrors the Prisma model shapes as TypeScript interfaces by hand (no generated client), so a schema change needs a matching manual update there. `useWorkspace.ts` is the shared hook (dashboard + summary page) that loads the workspace list and remembers the active one in `localStorage`.

**What's stubbed:** `billing/` is an empty module (wire up Stripe/Omise later). No signup/password-reset email flow. No seed data. Tests: the RLS/tenant-isolation and channel-linking integration specs (real Postgres), a few unit specs, and `npm run e2e` for the split API/worker (not in CI).

## Branches & environments
Flow: `feature/* → dev → stg → main` — **`main` is production**, `dev` is the default branch (PRs target it). Promote `dev → stg → main` with PRs using **merge commits, not squash**; never commit directly to `stg`/`main`. Branch protection isn't available (private repo, GitHub Free), so `.github/workflows/ci.yml` (`flow-guard`, `backend`, `frontend`, `compose`) is what enforces it — merge only when green. dev runs locally; stg/prod will be separate compose projects on the Oracle VM with separate secrets, bots and data. Details and the queued deployment roadmap: `docs/environments.md`.

## Project goals
- Working, demoable product in 4–6 weeks; this is also my main portfolio piece for job applications. Prefer shipping a complete end-to-end flow over polishing one module.
- Hosting plan: Oracle Cloud Always Free (Ampere VM), whole docker-compose on one VM. No paid tiers or free trials.
- Done: RLS wired end to end; the LINE/Telegram → workspace connect flow (see Architecture, `docs/decisions.md`). Next milestone: make the stack deployable (Step 2 in `docs/environments.md`), then stg.

## Rules
- Never commit or print values from .env files.
- Every query on tenant data must respect workspace isolation; add a test when touching tenant data.
- Keep the modular monolith; no new services without discussing first.
- Record important decisions in docs/decisions.md (create it if missing).