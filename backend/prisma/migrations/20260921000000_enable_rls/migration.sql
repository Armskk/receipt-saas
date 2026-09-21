-- Row-Level Security for workspace-scoped tables (replaces the old manual rls.sql).
--
-- The app must connect as the non-privileged `receipts_app` role and run every
-- tenant query inside PrismaService.withWorkspace(), which sets
--   app.current_workspace_id  (transaction-local)
-- Postgres then filters every query on the tables below to that workspace. A
-- superuser / BYPASSRLS role skips all of this, hence the separate role.
--
-- Deliberately NOT under RLS: users, workspaces, workspace_members. They are
-- identity/registry tables that are read before a workspace is known (signup,
-- "my workspaces", LINE/Telegram channel-id lookup); WorkspaceGuard covers them.

-- The role's password is set out-of-band (docker/postgres/init-app-role.sh or
-- `ALTER ROLE receipts_app PASSWORD ...`) so no secret lives in a migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'receipts_app') THEN
    CREATE ROLE receipts_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

-- Clean up the earlier manual rls.sql, which also put a policy on workspaces.
DROP POLICY IF EXISTS workspace_isolation ON workspaces;
ALTER TABLE workspaces DISABLE ROW LEVEL SECURITY;

ALTER TABLE categories    ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_isolation ON categories;
CREATE POLICY workspace_isolation ON categories
  USING      ("workspaceId" = current_setting('app.current_workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.current_workspace_id', true));

DROP POLICY IF EXISTS workspace_isolation ON receipts;
CREATE POLICY workspace_isolation ON receipts
  USING      ("workspaceId" = current_setting('app.current_workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.current_workspace_id', true));

-- receipt_items has no workspaceId of its own — scope it via the parent receipt.
DROP POLICY IF EXISTS workspace_isolation ON receipt_items;
CREATE POLICY workspace_isolation ON receipt_items
  USING (
    "receiptId" IN (
      SELECT id FROM receipts
      WHERE "workspaceId" = current_setting('app.current_workspace_id', true)
    )
  )
  WITH CHECK (
    "receiptId" IN (
      SELECT id FROM receipts
      WHERE "workspaceId" = current_setting('app.current_workspace_id', true)
    )
  );

DROP POLICY IF EXISTS workspace_isolation ON usage_logs;
CREATE POLICY workspace_isolation ON usage_logs
  USING      ("workspaceId" = current_setting('app.current_workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('app.current_workspace_id', true));

-- Table privileges for the app role (RLS narrows rows; GRANT decides who may touch the table at all).
GRANT USAGE ON SCHEMA public TO receipts_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO receipts_app;
REVOKE ALL ON "_prisma_migrations" FROM receipts_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO receipts_app;
