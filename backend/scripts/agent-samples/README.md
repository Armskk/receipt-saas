# Agent discount-handling regression check

Manually verifies `AgentService`'s `discountTotal` extraction against known tricky receipt
layouts (Order 120.5). Calls the real Claude API with synthetic data — like `scripts/e2e/`, it
has a small real cost and is **not part of CI**.

## Run

```bash
cd backend
npx ts-node --transpile-only scripts/agent-samples/check.ts
```

Needs `ANTHROPIC_API_KEY` in `backend/.env` (loaded automatically). Asserts
`sum(items[].amount) - discountTotal === total` for every fixture and exits non-zero if any
mismatch.

Run this after touching `RECORD_RECEIPT_TOOL` or `EXTRACTION_PROMPT` in
`src/agent/agent.service.ts`.

## Fixtures

- `a_explicit_discount.jpg` — a plain "Discount" line on top of the item prices. Sanity check.
- `b_markdown_pricing.jpg` — per-item "was / now" pricing with the original price struck
  through, no separate discount line anywhere. Before the discountTotal schema/prompt fix, the
  agent correctly used the sale prices for `items` but *also* reported the markdown itself as
  `discountTotal`, so `itemsSum - discountTotal` no longer matched `total` even though every
  individual number was "right" on its own. See `docs/decisions.md`.

Regenerate with `python3 make_fixtures.py` (needs Pillow).

## Not covered

The originally reported Order 120.5 symptom — a real receipt where item amounts summed to
almost double the total because the agent left `discountTotal` null — could not be reproduced
with clean synthetic renders across several attempts (explicit Thai/English discount lines,
percent-only discounts, discount buried in a long receipt, even a deliberately faded/low-contrast
discount line: the agent read all of these correctly). It likely needs a real messy photo
(glare, crumpled thermal paper, an odd angle) to trigger — revisit once a sample receipt is
available.
