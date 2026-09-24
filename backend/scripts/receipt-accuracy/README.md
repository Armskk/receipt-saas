# Receipt extraction accuracy check (Order 120)

Measures `AgentService`'s field-level accuracy against a labeled set of real receipt photos.
Calls the real Claude API — like `scripts/e2e/` and `scripts/agent-samples/`, it has a small
real cost and is **not part of CI**.

## Why this needs real photos, not synthetic ones

`scripts/agent-samples/README.md` documents a case where clean synthetic renders didn't
reproduce a bug that a real messy photo did (glare, crumpled thermal paper, odd angles, printer
fade). An accuracy number meant to go in a case study (Order 140) has to reflect what the model
actually does on real Thai receipts, not idealized ones — so this script is built to run against
`samples/`, a folder of real photos, gitignored because receipt photos are personal financial
data (see `CLAUDE.md`'s environment matrix: synthetic data only in git, real data never
committed).

## Setup

1. For each receipt, add a photo and a matching ground-truth file with the **same base name**
   to `samples/` (created automatically on first run if missing):
   - `01.jpg` (or `.jpeg`/`.png`)
   - `01.json` — see `ground-truth.example.json` for the shape:
     ```json
     {
       "merchantName": "7-Eleven",
       "purchaseDate": "2026-09-20",
       "items": [{ "description": "Water 600ml", "amount": 10 }],
       "discountTotal": 0,
       "total": 35
     }
     ```
   - `merchantName` / `purchaseDate`: set to `null` (not omitted) if the photo genuinely doesn't
     show it — that case is excluded from that field's accuracy instead of counted as a miss.
   - `discountTotal`: `0` if there's no discount (not `null`) — it's always checked.
   - `items`: only `description` (for your own reference) and `amount` are compared; amount
     matching is what counts as "found this line item", not the exact wording.
2. `ANTHROPIC_API_KEY` set in `backend/.env`.

## Run

```bash
cd backend
npx ts-node --transpile-only scripts/receipt-accuracy/run.ts
```

Prints a per-receipt line plus a summary: `merchantName`/`purchaseDate`/`total`/`discountTotal`
accuracy, line-item recall (and any unexpected extra items — a sign of hallucinated or
double-counted lines), the fully-correct-receipt rate, and an estimated API cost for the run.

## Target

The project's outcome (see the Notion project page) is a real accuracy number from 100 Thai
receipts before opening the beta. Build the set gradually — the script works with any number of
labeled receipts, so there's no need to label all 100 before running it the first time.
