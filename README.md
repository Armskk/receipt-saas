# Receipt Expense SaaS — Project Scaffold

AI agent-powered receipt/expense tracking SaaS. Users send receipt photos via
web upload, LINE, or Telegram; a Claude-powered agent extracts structured
line items and stores them per-workspace (multi-tenant) in Postgres.

## Architecture

Modular monolith, not microservices — see `/areas/receipt-expense-saas.md`-style
reasoning: one deployable NestJS app with clearly bounded modules, plus a
BullMQ worker (same codebase, separate process) for the slow part (calling
Claude on an image). Split any module into its own service later only if a
real scaling need shows up.

```
receipt-saas/
├── backend/            NestJS API + BullMQ worker (TypeScript)
│   ├── prisma/          DB schema (Postgres)
│   └── src/
│       ├── auth/            login, JWT issuing/guarding
│       ├── workspaces/      multi-tenant workspace + membership
│       ├── receipts/        CRUD for receipts + line items
│       ├── agent/           calls Claude API, parses receipt images -> structured JSON
│       ├── ingestion/       entry points: web upload, LINE webhook, Telegram webhook
│       ├── queue/           BullMQ producer/processor wiring
│       ├── billing/         stub for Stripe/Omise (fill in later)
│       └── prisma/          PrismaService (DB client wrapper)
├── frontend/            Next.js dashboard (TypeScript, App Router)
├── docker-compose.yml   Postgres + Redis + MinIO + backend + frontend + Caddy
├── Caddyfile            reverse proxy / auto-HTTPS config
└── .env.example         all required environment variables, one place
```

## Why things are wired this way

- **Ingestion never does the slow work.** `ingestion/*.controller.ts` just
  validates the incoming image and enqueues a `receipt.process` job, then
  replies immediately (important for LINE/Telegram webhooks, which expect a
  fast 200 OK). `queue/receipt-processing.processor.ts` — a separate BullMQ
  worker — is what actually calls `agent/agent.service.ts` and writes to the
  DB. This keeps webhooks responsive even while Claude is "thinking".
- **`agent.service.ts` is the only place that talks to the Claude API.**
  Everything else deals with typed, already-validated data
  (`dto/parsed-receipt.dto.ts`), so a bad/partial model response can't reach
  the database — `class-validator` rejects it before `receipts.service.ts`
  ever sees it.
- **Every table that isn't global carries a `workspaceId`.** Postgres
  Row-Level Security policies (see `prisma/schema.prisma` comments) are the
  second line of defense — even a missed `WHERE workspaceId = ...` in
  application code can't leak another tenant's data.

## Getting this running (you'll need to do this outside this sandbox — it has no npm registry access)

```bash
# 1. Install dependencies
cd backend && npm install
cd ../frontend && npm install

# 2. Copy env files and fill in real values
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local
# You need at minimum: ANTHROPIC_API_KEY, DATABASE_URL, JWT_SECRET

# 3. Start infra (Postgres, Redis, MinIO)
docker compose up -d postgres redis minio

# 4. Run Prisma migration
cd backend && npx prisma migrate dev --name init

# 5. Run backend + frontend locally for development
cd backend && npm run start:dev
cd frontend && npm run dev
```

For production on your VPS: `docker compose up -d --build` brings up
everything including Caddy (which needs your real domain in `Caddyfile` and
DNS pointed at the VPS first, so it can issue a TLS cert automatically).

## What's stubbed vs. real

- `agent.service.ts` — **real** implementation: calls the Claude API
  (`@anthropic-ai/sdk`) with the receipt image and a JSON-schema-constrained
  prompt, matching the extraction pattern used manually earlier in this
  project (store name, date, line items, discounts, total).
- `billing/` — stub only. Wire up Stripe/Omise when you're ready to charge.
- `auth/` — real JWT issue/verify flow, but no signup/password-reset email
  flow yet (needs a transactional email provider — see earlier chat notes).
- LINE/Telegram controllers — real webhook signature verification and image
  fetch, but you still need to register a LINE Official Account (Messaging
  API channel) and a Telegram bot via @BotFather, and put the tokens in
  `.env`.

## Next steps

1. `npm install` in `backend/` and `frontend/`, fix any version drift (this
   scaffold was hand-written in a sandbox with no npm registry access, so
   dependency versions haven't been resolved/locked against the real
   registry yet — check `npm outdated` after install).
2. Fill in `.env` files.
3. Run the Prisma migration, confirm the schema matches what you want.
4. Get a LINE Official Account + Telegram bot token, drop into `.env`.
5. Test the whole pipeline with one real receipt photo end to end.
