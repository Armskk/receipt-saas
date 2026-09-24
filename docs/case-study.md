# Receipt SaaS: an AI agent that turns a photo into a bookkeeping entry

*Architecture case study — Order 140.*

## The problem

Tracking personal or small-business expenses from paper receipts is tedious enough that most
people don't do it. The product bet here: if capturing a receipt is as fast as photographing it
and sending it to a chat bot, people will actually keep doing it. The system has to turn an
arbitrary photo — good lighting or bad, Thai or English, a single item or thirty — into
structured, per-category spending data without a human re-typing anything.

## Why an LLM agent, not a traditional OCR pipeline

A classic approach (OCR engine → regex/layout heuristics → line-item parser) breaks down on
receipts because layout varies wildly between stores, discounts and markdowns are expressed a
dozen different ways, and Thai/English text can appear mixed on the same line. Claude's vision
input plus tool use replaces that whole pipeline with one call: the image goes in, a
schema-validated object comes out. The system prompt and tool schema encode receipt-domain
knowledge (how discounts relate to item totals, how to combine multiple photos of one long
receipt) that would otherwise live in brittle parsing code.

The extraction is forced into a fixed shape via Anthropic's `tool_choice`, not a "please respond
in JSON" instruction — `agent/agent.service.ts` calls Claude with a single `record_receipt` tool
and `tool_choice: { type: 'tool', name: 'record_receipt' }`, so the response is always
schema-shaped tool input rather than free text that might or might not parse. That output is
then validated again, independently, with `class-validator` against
`agent/dto/parsed-receipt.dto.ts` — a bad or partial model response can't reach the database no
matter how the model produced it. This is the only place in the codebase that talks to the
Claude API; everything downstream deals with typed, already-validated data.

## System design: keeping ingestion fast while the model "thinks"

LINE and Telegram webhooks expect a response within seconds, but a vision extraction call can
take much longer, especially on a long receipt. Splitting ingestion from processing solves this:

```
web upload / LINE / Telegram  →  enqueue job  →  BullMQ worker  →  Claude  →  Postgres
      (API process, fast)                          (separate process)
```

`ingestion/*.controller.ts` only validates the incoming image, uploads it to object storage, and
enqueues a job — then returns immediately. `queue/receipt-processing.processor.ts`, running in a
*separate worker process* (`worker.ts`, its own NestJS root module `WorkerModule`), is what
downloads the image back from storage, calls the agent, and writes the result. The two processes
share one codebase (a modular monolith) but the worker is the only place `ReceiptProcessingProcessor`
is registered — `queue/worker-module.spec.ts` enforces that the API process can never accidentally
consume a job and call Claude itself, which would defeat the whole point of the split.

One upload can carry multiple photos of the same receipt (a long receipt shot in sections, front
and back of a bill, a multi-page invoice) — all images for one receipt go to Claude in a single
call, with the prompt instructed to merge them into one result without double-counting line
items that appear in the overlap between photos.

## Multi-tenancy: two independent layers, not one

Every workspace holds one tenant's receipts. Trusting application code alone to always filter by
`workspaceId` is a single point of failure — a missed `WHERE` clause anywhere leaks another
tenant's data. So isolation is enforced twice:

- **Application layer:** `workspaces/workspace.guard.ts` checks the JWT user is a member of the
  `:workspaceId` route param before any handler runs.
- **Database layer:** Postgres Row-Level Security, gated on `current_setting('app.current_workspace_id')`,
  on every workspace-scoped table. Every query on those tables runs inside
  `PrismaService.withWorkspace(workspaceId, tx => ...)`, which sets that variable
  transaction-locally — outside it, RLS returns zero rows rather than another tenant's rows. The
  app connects to Postgres as a non-privileged role (`receipts_app`) that RLS actually applies
  to; `PrismaService` refuses to start in production if it detects a role that would bypass RLS.

If the first layer has a bug, the second still holds. RLS integration tests cover this directly
against a real Postgres instance (mocking RLS isn't meaningful — see the backend test setup in
`CLAUDE.md`).

## Handling a model that's sometimes wrong

An agent extracting from a photo will occasionally misread something, and the design assumes
that from the start rather than trusting the output blindly:

- **Structural validation is a hard gate.** `class-validator` rejects any response that doesn't
  match the expected shape before it can reach `receipts.service.ts` or the database.
- **A human confirms before it counts.** The receipt status machine is
  `PENDING → PROCESSING → PARSED → CONFIRMED` (or `FAILED`); only `PARSED`/`CONFIRMED` receipts
  count toward spend, and `PARSED` means "the agent extracted this, a person hasn't confirmed it
  yet" — the dashboard surfaces the parsed result for review rather than writing it straight into
  a spend total.
- **Arithmetic is cross-checked, not just trusted.** `sum(items[].amount) - discountTotal` should
  equal `total`; the service logs a warning (non-blocking) when it doesn't, which is a fast way to
  notice a systematic extraction problem without failing the request.
- **Uncertain fields are supposed to come back absent, not guessed.** The schema and prompt tell
  Claude to omit a field it isn't confident about (e.g. `purchaseDate` "if not visible") rather
  than invent a value, and the same standard was retrofitted onto every field found violating it:
  - `discountTotal` was ambiguous about whether a per-item markdown ("was $10, now $8") should
    also be reported as a discount, causing it to be double-counted against the total. The tool
    schema and prompt now state the invariant explicitly (`sum(items) - discountTotal === total`)
    and give a worked rule for markdown pricing vs. a separate discount line.
  - `merchantName` occasionally came back as the literal string `"<UNKNOWN>"` instead of being
    omitted when the store name wasn't legible, which then got stored and displayed verbatim on
    the dashboard. Fixed the same way — an explicit "omit, don't invent a placeholder" instruction
    in the schema — plus a defensive normalization step that strips an "unknown"-shaped value
    before validation, in case the instruction is ever misread again.

  Both were real production bugs, not hypothetical ones, found by testing against actual
  receipts rather than only synthetic fixtures — synthetic renders are clean by construction and
  don't reliably reproduce the messy real-world cases (glare, crumpled thermal paper, an odd
  angle) that trigger this kind of ambiguity. `backend/scripts/agent-samples/` documents one such
  case.

## Accuracy on real Thai receipts

*Pending — this section will report the actual measured accuracy once the 100-receipt labeled
set (Order 120) is built.* The measurement methodology is implemented and ready:
`backend/scripts/receipt-accuracy/` runs the real agent against a folder of labeled real receipt
photos and reports field-level accuracy (`merchantName`, `purchaseDate`, `total`,
`discountTotal`), line-item recall, the fully-correct-receipt rate, and the API cost of the run.
It intentionally works against real photos, not synthetic ones — see that script's README for
why, and its `ground-truth.example.json` for the label format. The photos themselves are never
committed (personal financial data, gitignored).

## Stack and deployment

NestJS (API) + BullMQ worker sharing one codebase, Next.js dashboard, Postgres, Redis, MinIO for
object storage, Claude API for extraction, all behind one shared Caddy instance per deployed
environment (stg/production are separate Docker Compose projects on the same VM, isolated by
network and by Postgres role, with independent secrets and independent LINE/Telegram bots — see
`docs/environments.md`).

## What's next

Deploy staging, replace this section's placeholder with a real accuracy number from 100 labeled
receipts, then open the beta to 5–10 real users on the web dashboard, LINE, and Telegram.
