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
- `npm test` — jest. Run a single file with `npx jest path/to/file.spec.ts`; there are no spec files yet, this is wired but unused
- `npm run prisma:generate` — regenerate the Prisma client after editing `schema.prisma`
- `npm run prisma:migrate` — `prisma migrate dev`; after the *first* migration on a fresh database, also run `prisma/rls.sql` once directly against Postgres (Prisma can't apply RLS policies itself — see the comment block at the top of `schema.prisma`)

Frontend (`cd frontend`): `npm run dev`, `npm run build`, `npm run lint`.

Infra: `docker compose up -d postgres redis minio` for local dev deps; full stack including Caddy via `docker compose up -d --build` (see root `.env.example`, `backend/.env.example`, `frontend/.env.example` for required vars — `ANTHROPIC_API_KEY`, `DATABASE_URL`, `JWT_SECRET` are the minimum to run anything).

## Architecture

**Modular monolith, not microservices.** One NestJS app (`backend/src/app.module.ts`) with bounded modules, plus a BullMQ worker that's the *same codebase* running as a separate process (`backend/src/worker.ts` vs `backend/src/main.ts`) — split a module into its own service only if a real scaling need shows up.

**Why there's a separate worker process:** ingestion controllers (`ingestion/*.controller.ts`) only validate the incoming image and enqueue a `process` job on the `RECEIPT_PROCESSING_QUEUE`, then return immediately — this matters because LINE/Telegram webhooks expect a fast 200 OK. `queue/receipt-processing.processor.ts`, running in the `worker` process, is what actually downloads the image from storage, calls `agent/agent.service.ts` (the Claude API), and writes results via `receipts/receipts.service.ts`. The API process must stay responsive even while Claude is "thinking" on a receipt.

**Ingestion → queue → agent → persistence pipeline**, in order:
1. `ingestion/web-upload.controller.ts` (JWT + `WorkspaceGuard`), `ingestion/line.controller.ts` (HMAC-SHA256 signature over the raw body — `main.ts` enables `rawBody: true` for exactly this), or `ingestion/telegram.controller.ts` (shared-secret header) each resolve a `Workspace`, upload image(s) to MinIO via `common/storage.service.ts`, and call `receipts.createPending()`.
2. A job `{ receiptId, workspaceId }` goes on the queue (`queue/receipt-processing.types.ts`).
3. `queue/receipt-processing.processor.ts` marks the receipt `PROCESSING`, fetches the image(s) back from storage as base64, and calls `agent.service.ts`.
4. `agent/agent.service.ts` is the **only** place that talks to the Claude API. It forces structured output via `tool_choice` on a single `record_receipt` tool (not a "please respond in JSON" prompt), then validates the result against `agent/dto/parsed-receipt.dto.ts` with `class-validator` before returning it — a bad/partial model response can't reach the database.
5. `receipts.service.ts#applyParsedResult` writes the receipt header, upserts `Category` rows by name within the workspace, creates `ReceiptItem` rows, and logs a `UsageLog` row (tokens + estimated cost) — all in one `$transaction`.

**One upload can carry multiple photos of the same receipt** (long receipt shot in sections, front/back, multi-page bill): `Receipt.imageKeys` is a string array, all images go to Claude in a single call, and the agent is prompted to merge them into one result without double-counting overlapping line items. LINE/Telegram messages always carry exactly one image.

**Receipt status machine:** `PENDING` → `PROCESSING` → `PARSED` (agent succeeded, awaiting user confirmation) → `CONFIRMED`, or `PROCESSING` → `FAILED` (with `failureReason`). Only `PARSED`/`CONFIRMED` receipts count toward spend in `receipts.service.ts#monthlySummary`.

**Multi-tenancy is enforced twice.** Every workspace-scoped table carries `workspaceId` (or, for `ReceiptItem`, scopes indirectly through its parent `Receipt`). Application-level: `workspaces/workspace.guard.ts` checks the JWT user is a member of the `:workspaceId` route param before any handler runs. Database-level: `prisma/rls.sql` enables Postgres Row-Level Security on the same tables, gated on `current_setting('app.current_workspace_id')` — this is a second line of defense so a query that forgot its `WHERE workspaceId = ...` returns nothing instead of another tenant's rows. **This means any code path that runs raw/Prisma queries against these tables must `SET app.current_workspace_id` on the connection first, or RLS will silently return zero rows** — not yet wired into a Prisma middleware/interceptor.

**LINE/Telegram → workspace linking isn't built yet.** `Workspace.lineUserId` / `telegramChatId` are meant to be set via a "connect" flow in the dashboard (a one-time code the user sends to the bot), but that handler doesn't exist — currently webhook events from an unrecognized `lineUserId`/`chatId` are just logged and dropped.

**Auth:** `auth/auth.service.ts` issues JWTs (`@nestjs/jwt`, `passport-jwt` strategy in `auth/jwt.strategy.ts`) on signup/login. Sign-up always creates a brand-new `Workspace` with the user as `OWNER` — there's no "join an existing workspace" invite flow yet. Frontend stores the token in `localStorage` (`frontend/app/lib/api.ts`) and attaches it as a Bearer header via `apiFetch`; a 401 clears the token and bounces to `/login`.

**Frontend ↔ backend contract:** `frontend/app/lib/api.ts` is the only place that calls the backend — it mirrors the Prisma model shapes as TypeScript interfaces by hand (no generated client), so a schema change needs a matching manual update there. `useWorkspace.ts` is the shared hook (dashboard + summary page) that loads the workspace list and remembers the active one in `localStorage`.

**What's stubbed:** `billing/` is an empty module (wire up Stripe/Omise later). No signup/password-reset email flow. No seed data. No tests written yet despite jest being configured.

## Project goals
- Working, demoable product in 4–6 weeks; this is also my main portfolio piece for job applications. Prefer shipping a complete end-to-end flow over polishing one module.
- Hosting plan: Oracle Cloud Always Free (Ampere VM), whole docker-compose on one VM. No paid tiers or free trials.
- Next milestone: wire `SET app.current_workspace_id` so RLS actually enforces isolation (currently not wired, see Architecture).

## Rules
- Never commit or print values from .env files.
- Every query on tenant data must respect workspace isolation; add a test when touching tenant data.
- Keep the modular monolith; no new services without discussing first.
- Record important decisions in docs/decisions.md (create it if missing).