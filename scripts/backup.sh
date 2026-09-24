#!/usr/bin/env bash
# Backs up one deployed environment's Postgres database and MinIO receipt images to off-VM
# storage. Meant to run on the VM via cron, from the repo checkout — NOT in CI.
#
#   scripts/backup.sh <stg|production>
#
# Needs, exported before running (e.g. in the crontab line or a wrapper the cron job sources):
#   OFFSITE_RCLONE_REMOTE  an rclone remote:path for off-VM storage, e.g. an OCI Object Storage
#                          bucket configured once with `rclone config` (S3-compatible). See
#                          docs/production-provisioning-checklist.md for the one-time setup.
#
# Reads the environment's own .env.<name> / backend/.env.<name> for DB and MinIO credentials —
# never prints them. Uploads:
#   $OFFSITE_RCLONE_REMOTE/<name>/postgres/<name>-<UTC timestamp>.sql.gz
#   $OFFSITE_RCLONE_REMOTE/<name>/minio/...                         (mirrors the receipt-images bucket)
#
# Exits non-zero on any failure, so cron's own mail-on-error (or redirecting stdout/stderr to a
# log a monitoring check tails) surfaces a failed backup — see the "Monitoring" section of
# docs/environments.md. Does NOT prune old off-VM backups or test a restore; both are manual
# (see docs/production-provisioning-checklist.md and CLAUDE.md — never copy production data
# anywhere except this documented backup target).
set -euo pipefail

usage() { echo "usage: $0 <stg|production>" >&2; exit 2; }
[ $# -eq 1 ] || usage
name="$1"
[[ "$name" =~ ^(stg|production)$ ]] || usage
: "${OFFSITE_RCLONE_REMOTE:?OFFSITE_RCLONE_REMOTE must be set (see docs/production-provisioning-checklist.md)}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/.env.$name"
backend_env_file="$root/backend/.env.$name"
for f in "$env_file" "$backend_env_file"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
done

# Only what this script needs, not the whole file (never echoed).
pg_user="$(grep -m1 '^POSTGRES_USER=' "$env_file" | cut -d= -f2-)"
pg_db="$(grep -m1 '^POSTGRES_DB=' "$env_file" | cut -d= -f2-)"
s3_access_key="$(grep -m1 '^S3_ACCESS_KEY=' "$backend_env_file" | cut -d= -f2-)"
s3_secret_key="$(grep -m1 '^S3_SECRET_KEY=' "$backend_env_file" | cut -d= -f2-)"
s3_bucket="$(grep -m1 '^S3_BUCKET=' "$backend_env_file" | cut -d= -f2-)"
: "${pg_user:?POSTGRES_USER not found in $env_file}"
: "${pg_db:?POSTGRES_DB not found in $env_file}"
: "${s3_access_key:?S3_ACCESS_KEY not found in $backend_env_file}"
: "${s3_secret_key:?S3_SECRET_KEY not found in $backend_env_file}"
: "${s3_bucket:?S3_BUCKET not found in $backend_env_file}"

command -v rclone >/dev/null || { echo "rclone is required (see docs/production-provisioning-checklist.md)" >&2; exit 1; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_file="$(mktemp -t "${name}-XXXXXX.sql.gz")"
trap 'rm -f "$dump_file"' EXIT

echo "[$stamp] dumping ${name}'s database ($pg_db)..."
docker compose -p "receipt-$name" --env-file "$env_file" \
  -f "$root/docker-compose.yml" -f "$root/docker-compose.prod.yml" \
  exec -T postgres pg_dump -U "$pg_user" "$pg_db" | gzip > "$dump_file"

echo "[$stamp] uploading database dump..."
rclone copyto "$dump_file" "$OFFSITE_RCLONE_REMOTE/$name/postgres/$name-$stamp.sql.gz"

echo "[$stamp] mirroring receipt-images bucket ($s3_bucket)..."
# MinIO publishes no host port (docker-compose.prod.yml) — only reachable from inside the
# environment's own compose network, by its service name. Run rclone itself as a one-off
# container on that network instead of installing rclone on the VM host for this half of the
# job. The MinIO side is defined purely via RCLONE_CONFIG_* env vars (no file, so those
# credentials never touch disk); the destination side reuses the host's real rclone config
# (mounted read-only) so $OFFSITE_RCLONE_REMOTE resolves the same as it did for the dump above.
net="receipt-${name}_default"
docker network inspect "$net" >/dev/null 2>&1 || {
  echo "docker network '$net' not found — compose's default network naming may differ; check" \
    "with 'docker network ls | grep receipt-$name' and adjust this script" >&2
  exit 1
}
rclone_conf="$(rclone config file 2>/dev/null | tail -n1)"
[ -f "$rclone_conf" ] || { echo "could not locate rclone's config file (rclone config file)" >&2; exit 1; }
docker run --rm --network "$net" \
  -v "$rclone_conf:/config/rclone/rclone.conf:ro" \
  -e RCLONE_CONFIG_MINIOTMP_TYPE=s3 \
  -e RCLONE_CONFIG_MINIOTMP_PROVIDER=Minio \
  -e RCLONE_CONFIG_MINIOTMP_ENDPOINT="http://minio:9000" \
  -e RCLONE_CONFIG_MINIOTMP_ACCESS_KEY_ID="$s3_access_key" \
  -e RCLONE_CONFIG_MINIOTMP_SECRET_ACCESS_KEY="$s3_secret_key" \
  rclone/rclone:latest sync "miniotmp:$s3_bucket" "$OFFSITE_RCLONE_REMOTE/$name/minio/$s3_bucket"

echo "[$stamp] backup of $name complete."
