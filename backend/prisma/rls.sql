-- Row-Level Security for workspace-scoped tables.
-- Run this once after your first `prisma migrate dev`/`deploy`.
--
-- How it works: every DB connection the app makes must first run
--   SET app.current_workspace_id = '<workspace id>';
-- (do this once per request, e.g. in a Prisma middleware / interceptor,
-- right after the WorkspaceGuard resolves which workspace the request
-- belongs to). Postgres then silently filters every query on the tables
-- below to that workspace — even a query the application code forgot to
-- filter itself returns nothing instead of another tenant's rows.
--
-- The app's own DB role still needs BYPASSRLS off (default) for this to
-- have any effect — don't run migrations with the same role in production,
-- or use a superuser connection string for the app.

ALTER TABLE workspaces         ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories         ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs         ENABLE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON workspaces
  USING (id = current_setting('app.current_workspace_id', true));

CREATE POLICY workspace_isolation ON categories
  USING ("workspaceId" = current_setting('app.current_workspace_id', true));

CREATE POLICY workspace_isolation ON receipts
  USING ("workspaceId" = current_setting('app.current_workspace_id', true));

-- receipt_items and usage_logs don't carry workspaceId directly — scope via
-- their parent receipt/workspace instead.
CREATE POLICY workspace_isolation ON receipt_items
  USING (
    "receiptId" IN (
      SELECT id FROM receipts
      WHERE "workspaceId" = current_setting('app.current_workspace_id', true)
    )
  );

CREATE POLICY workspace_isolation ON usage_logs
  USING ("workspaceId" = current_setting('app.current_workspace_id', true));
