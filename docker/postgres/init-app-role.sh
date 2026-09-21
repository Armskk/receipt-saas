#!/bin/sh
# Runs once, on first boot of an empty Postgres volume. Creates the
# non-privileged role the API and worker connect as, so Row-Level Security
# actually applies (the POSTGRES_USER superuser bypasses it). The GRANTs and
# policies come from the `enable_rls` Prisma migration.
#
# Existing volume? This won't re-run — set the role up by hand instead:
#   docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
#     -c "CREATE ROLE receipts_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '<APP_DB_PASSWORD>'"
# (or `ALTER ROLE receipts_app PASSWORD ...` if a migration already created it).
set -e

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 -v pw="$APP_DB_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE receipts_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'receipts_app')
\gexec
SQL
