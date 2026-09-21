# Split API / worker end-to-end check

Runs the **built** API (`dist/main.js`) and worker (`dist/worker.js`) as two separate processes and drives the whole receipt flow over HTTP. It exists because the unit/integration specs can't show that the API only enqueues while the worker does the Claude call.

**It calls the real Claude API (about 7 requests, so a small but real cost) and uses synthetic data only.** It is not part of CI.

## Run

```bash
docker compose up -d postgres redis minio   # repo root
cd backend
npm run build
npm run e2e
```

Prerequisites (checked up front, with a fix hint if one is missing): `dist/` built, `backend/.env` with `DATABASE_URL`, `APP_DATABASE_URL` and `ANTHROPIC_API_KEY`, postgres/redis/minio running, and no waiting/active jobs in the local Redis queue (stop any running worker first — the script starts its own).

It creates throwaway resources and removes them at the end: database `receipts_e2e` (migrated with `prisma migrate deploy`), a fresh MinIO bucket `e2e-<timestamp>`, and two users with their own workspaces. API and worker logs go to a temp directory whose path is printed if anything fails. Env values are never printed. Exit code is 0 only if every check passes.

## What it checks

| # | Group | Asserts |
|---|---|---|
| 1 | API alone | no BullMQ worker connection in Redis; non-image upload → 400; upload returns `PENDING` fast; still `PENDING` after 8s; API log has no "Processing receipt"; job sits in the queue |
| 2 | Worker starts | job is consumed → `PARSED`; totals/items match; `usage_logs` row with token counts; only the worker logs "Processing receipt" |
| 3 | Confirm | `PARSED` → `CONFIRMED` |
| 4 | Concurrent uploads | Thai receipt, single receipt, and one receipt made of 2 photos with overlapping lines (merged to 6 items, total 465.00 — double counting would give 575), a stray `.txt` is rejected; monthly summary totals |
| 5 | Tenant isolation | other user gets 403/404 on reads and lists, 404 on the id via their own workspace, 401 without a token |
| 6 | Bad image | Claude 400 → 3 attempts → BullMQ failed set → receipt `FAILED` with `failureReason` |
| 7 | Worker killed mid-job | `SIGKILL` while the receipt is `PROCESSING`; receipt isn't lost; a restarted worker recovers the stalled job (takes up to ~60s) → `PARSED` |
| 8 | API without `ANTHROPIC_API_KEY` | API still boots, logs in and enqueues; the worker parses it |

Step 7 is timing-dependent: if the job finishes before the kill lands, that check fails as "inconclusive" — just re-run.

## Fixtures

`fixtures/` holds the synthetic receipts (committed, ~160 KB) so nothing extra is needed at run time. To regenerate them: `python3 make_fixtures.py` (needs Pillow; the fonts are macOS paths with a default-font fallback, so Thai text needs a Thai font).

## Not covered

The dashboard UI (Choose Files button), LINE and Telegram ingestion, and running against a deployed environment — it always starts its own local processes, so it can't be pointed at stg as is.
