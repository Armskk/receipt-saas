# Decisions

Short records of architectural decisions that aren't obvious from the code.
Newest first.

## 2026-09-21 — The receipt processor is registered only in the worker process

**Context.** `ReceiptProcessingProcessor` was a provider of `QueueModule`, which `AppModule` imports, and both `main.ts` and `worker.ts` booted `AppModule`. So the API process also started a BullMQ worker, competed for jobs and called Claude itself — the opposite of why the worker is a separate process (webhooks must get a fast 200 OK). Found in the first end-to-end run.

**Decisions.**

1. **`QueueModule` is queue plumbing only** (`BullModule.forRoot` + `registerQueue`), shared by both processes: the API enqueues through it, the worker consumes through it.
2. **`WorkerModule` (`queue/worker.module.ts`) is the worker's root module** and the only place `ReceiptProcessingProcessor` and `AgentModule` are registered. `worker.ts` boots it instead of `AppModule`.
3. **`AppModule` no longer imports `AgentModule`**, so the API has no path to the Claude client at all. `queue/worker-module.spec.ts` reads the Nest module metadata and fails if the processor or `AgentService` shows up in the API's module graph — no Redis or Postgres needed.

**Consequences.** A new job consumer goes in `WorkerModule`, not in a module the API imports. The API no longer needs `ANTHROPIC_API_KEY`; only the worker does.

## 2026-09-21 — Three long-lived branches: dev → stg → main (= production)

**Context.** One branch, no CI, never deployed. Wanted a dev/staging/production flow before the first deploy.

**Decisions.**

1. **`feature/* → dev → stg → main`**, with **`main` as production** (no separate `production` branch — keeps the existing default name and every reference to it).
2. **`dev` is the repository default branch** so PRs target it by default.
3. **Promotion PRs use merge commits, never squash**; squash is fine for `feature → dev`. Squashing promotions makes the long-lived branches diverge.
4. **Enforcement is CI + convention, not GitHub settings.** The repo is private on GitHub Free, where branch protection, rulesets and environment required-reviewers are unavailable. `.github/workflows/ci.yml` has an advisory `flow-guard` job that fails wrong-direction PRs, plus `backend` and `frontend` jobs. Revisit if the repo goes public or to Pro (Step 5 in `docs/environments.md`).
5. **`dev` is local-only; only stg and prod run on the (single, free) Oracle VM**, as separate compose projects with separate secrets, bots and data. Rollout is queued in `docs/environments.md`.
6. CI runs eslint directly (`--max-warnings 0`) instead of `npm run lint`, because the script uses `--fix` and would rewrite files and still pass.

## 2026-09-21 — Enforce tenant isolation with Postgres RLS

**Context.** Multi-tenancy was enforced only in application code (`WorkspaceGuard` +
`where: { workspaceId }`). `rls.sql` existed as a second line of defense but did
nothing: the app connected as the Postgres superuser (which bypasses RLS), no code
set `app.current_workspace_id`, and `ReceiptsController.get/confirm` looked receipts
up by id alone, so a member of workspace A could read or confirm workspace B's
receipt by id.

**Decisions.**

1. **Explicit `PrismaService.withWorkspace(workspaceId, fn)`** wraps every tenant
   query in a transaction that runs `set_config('app.current_workspace_id', $1, true)`
   (transaction-local, parameterized). Chosen over an AsyncLocalStorage +
   Prisma-client-extension approach: it works the same in the API and the BullMQ
   worker (no request context needed), and a forgotten wrap fails visibly (zero rows
   / RLS error) rather than leaking. Cost: BEGIN/COMMIT + one `set_config` round trip
   per call, acceptable at this scale.
2. **Two DB roles.** The owner role (`POSTGRES_USER`, `DATABASE_URL`) runs migrations
   only. The API and worker connect as `receipts_app` (`NOSUPERUSER NOBYPASSRLS`,
   `APP_DATABASE_URL`). `PrismaService` checks `rolsuper OR rolbypassrls` at startup
   and throws in production / warns elsewhere, so RLS can't silently be a no-op again.
   The role's password is set out-of-band (`docker/postgres/init-app-role.sh` on a
   fresh volume, manually on an existing one) so no secret lives in a migration.
3. **No RLS on `users`, `workspaces`, `workspace_members`.** They're identity/registry
   tables read *before* a workspace is known: signup creates a workspace, "my
   workspaces" lists by membership, and the LINE/Telegram webhooks resolve a workspace
   from `lineUserId` / `telegramChatId`. A `workspaces` policy keyed on the current
   workspace would break all three. `WorkspaceGuard` protects them at the app level.
   RLS covers the tables that hold tenant data: `categories`, `receipts`,
   `receipt_items` (via the parent receipt), `usage_logs`.
4. **RLS SQL lives in a Prisma migration** (`*_enable_rls`) instead of a manually-run
   `rls.sql`, so `prisma migrate deploy` applies it everywhere — dev, test DB, prod.
5. **Receipt lookups by id are workspace-scoped** (`get/confirm/markProcessing/
   markFailed` take `workspaceId`); a receipt outside the workspace is a 404.

**Consequences.** Any new tenant query must go through `withWorkspace`; outside it the
app role sees zero rows. Tests for tenant data are integration tests against a real
Postgres (`TEST_DATABASE_URL` = owner role, `TEST_APP_DATABASE_URL` = `receipts_app`,
pointing at a dedicated `*_test` database that `jest` creates and migrates itself).
