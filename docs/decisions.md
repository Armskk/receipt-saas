# Decisions

Short records of architectural decisions that aren't obvious from the code.
Newest first.

## 2026-09-22 — Deployed environments: private compose projects behind one shared Caddy

**Context.** Before the first deploy the compose file published Postgres, Redis, MinIO, the API and the frontend on every host interface (`5432/6379/9000/9001/3001/3000`), had a Caddy per stack (two projects on one VM can't both bind 80/443), read fixed `backend/.env` / `frontend/.env.local` paths, and `.gitignore` did not cover `.env.stg` / `.env.production` even though the docs said it did.

**Decisions.**

1. **One compose project per environment, layered with `docker-compose.prod.yml`.** The override strips every host port (`ports: !reset []`, hence Compose ≥ 2.24), points each service at that environment's env files, switches the per-project Caddy off behind a profile, and rotates container logs. The base file stays the dev stack.
2. **One shared Caddy in its own project (`docker-compose.edge.yml`)**, the only thing publishing ports, and only TCP 80/443 (no HTTP/3, matching the 22/80/443 firewall rule). It joins the external network `receipt-edge` (created once per VM). Backend and frontend join that network under **per-environment aliases** (`<env>-backend`, `<env>-frontend`), because compose otherwise gives every project's `backend` the plain name `backend` on a shared network. Postgres/Redis/MinIO/worker stay off it, so the edge can't even resolve them.
3. **An environment is enabled by mounting its site file** (`EDGE_STG_SITE` / `EDGE_PROD_SITE` in `.env.edge`); a disabled one gets an empty file, so Caddy never requests certificates for domains that aren't set up. The edge is its own project so an environment can be rebuilt or torn down without touching TLS or the other environment (checked: tearing down stg leaves production and the edge serving).
4. **Secrets are generated, never copied** (`scripts/init-env.sh`): fresh random values per environment for the DB passwords, MinIO credentials, JWT secret and webhook secret. The **DB owner URL is not in the API/worker env** (only in the root env file, for the migration step). In dev `backend/.env` does carry it, for the Prisma CLI; the running API/worker only need `APP_DATABASE_URL`, so the deployed containers get no more than that (verified: the API boots in production mode without it, and PrismaService refuses to run in production as a role that bypasses RLS).
5. **`.gitignore` now ignores every `.env.*` except `*.example`.**
6. **Dev ports bind to `127.0.0.1`** so a laptop on public Wi-Fi doesn't expose Postgres/Redis/MinIO.
7. **`scripts/check-compose.mjs`, run in CI (`compose` job),** asserts the properties above on the rendered config (no host ports outside the edge, private services only on the private network, distinct secrets/aliases, no owner credentials in the app env, dev on loopback) without starting containers.

**Consequences.** Adding a service that needs to be reachable from outside means routing it through the edge, not publishing a port. A new environment needs a new site file and its own `ENV_NAME`-prefixed aliases. The firewall (VCN security list + iptables) is documented but can only be applied and verified once the VM exists; Docker-published ports bypass `INPUT` rules, which is why the compose layer is the primary defence.

## 2026-09-22 — Linking a LINE/Telegram chat to a workspace with one-time codes

**Context.** The webhooks looked up `Workspace.lineUserId` / `telegramChatId`, but nothing ever set them, so a message from any real user was logged and dropped. The bot can't know which workspace a stranger's chat belongs to, and asking them to log in inside LINE/Telegram isn't an option.

**Decisions.**

1. **The dashboard issues a code, the user sends it to the bot.** `POST /workspaces/:id/channels/:channel/link-code` returns `ABCD-2345` (8 symbols from a 32-char alphabet without 0/O/1/I, ≈40 bits, from `crypto.randomInt`). It's valid for 10 minutes, once, for that channel only; a new code replaces any earlier unused one. Telegram also accepts the `/start <code>` deep link (`t.me/<bot>?start=<code>`).
2. **Only a SHA-256 of the code is stored** (`channel_link_codes.codeHash`), so a database leak doesn't hand out live codes.
3. **`channel_link_codes` is not under RLS**, like `workspaces`: the bot redeems the code *before* it knows the workspace, so there's no `app.current_workspace_id` to set. The tenant boundary is instead the code itself — it can only ever link the workspace it was issued for (covered by `channel-link.service.spec.ts`). Issuing/unlinking goes through `JwtAuthGuard` + `WorkspaceGuard` and additionally requires OWNER/ADMIN, because whoever controls the chat can add receipts to the workspace.
4. **Redeeming is atomic and doesn't burn the code on failure.** One transaction checks the code (exists, right channel, unused, unexpired), refuses if the chat already belongs to a *different* workspace, then spends the code with a conditional `updateMany` (so two simultaneous redemptions can't both win) and writes the link. A unique-constraint race on `lineUserId`/`telegramChatId` rolls back and reports "already linked". Re-linking a workspace to a new chat replaces the old link.
5. **The bot answers**: confirmation on success; "invalid or expired" / "already linked to another workspace" on failure; a how-to for an unlinked chat that sends other text, a photo, or follows the LINE bot. A linked chat's other text is ignored. Replies are best-effort (`ChannelMessenger` only logs failures) and are skipped when the channel token isn't configured.
6. **The API only exposes booleans** (`GET .../channels` → `{ line, telegram }`), never the LINE user id or chat id.

**Known limits.** No throttling of guesses through the bot (the code space and 10-minute single-use window are the defence). Used codes are only purged when the workspace next issues one. Telegram group chats and LINE groups/rooms aren't specially handled (LINE uses `source.userId`; a Telegram group's chat id links like any other chat). Unlinking is by channel, not per chat.

**Consequences.** A workspace has at most one LINE chat and one Telegram chat. Anything new that must run before the workspace is known follows the same pattern as here: not under RLS, and covered by a test that shows the tenant boundary.

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
