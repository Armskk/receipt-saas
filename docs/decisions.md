# Decisions

Short records of architectural decisions that aren't obvious from the code.
Newest first.

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
