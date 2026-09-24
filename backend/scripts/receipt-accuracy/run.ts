/**
 * Accuracy measurement for AgentService against a labeled set of real
 * receipt photos (Order 120). Calls the real Claude API — not part of CI,
 * like scripts/e2e/ and scripts/agent-samples/.
 *
 * Drop `<id>.jpg` (or .jpeg/.png) + `<id>.json` (ground truth — see
 * ground-truth.example.json) pairs into samples/. That directory is
 * gitignored: receipt photos are personal financial data, and CLAUDE.md's
 * environment matrix is explicit that this kind of data is never committed.
 *
 * Run:
 *   cd backend
 *   npx ts-node --transpile-only scripts/receipt-accuracy/run.ts
 *
 * Needs ANTHROPIC_API_KEY in backend/.env (loaded automatically).
 */
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';
import { AgentService } from '../../src/agent/agent.service';

config({ path: path.join(__dirname, '../../.env') });

const SAMPLES_DIR = path.join(__dirname, 'samples');
const AMOUNT_EPSILON = 0.01;

interface GroundTruthItem {
  description: string;
  amount: number;
}

interface GroundTruth {
  merchantName?: string | null;
  purchaseDate?: string | null;
  items: GroundTruthItem[];
  discountTotal?: number | null;
  total: number;
}

interface CaseResult {
  name: string;
  merchantNameMatch: boolean | 'n/a';
  purchaseDateMatch: boolean | 'n/a';
  totalMatch: boolean;
  discountTotalMatch: boolean;
  itemsMatched: number;
  itemsExpected: number;
  itemsExtra: number;
  inputTokens: number;
  outputTokens: number;
}

function normalizeText(s: string): string {
  return s.trim().toLowerCase();
}

function amountsClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= AMOUNT_EPSILON;
}

// Greedy match: each expected item claims the first unclaimed parsed item
// with the same amount (within epsilon). Description wording legitimately
// varies between runs (e.g. abbreviations, language), so amount + presence
// is what "did the model find this line item" means here, not exact text.
function matchItems(
  expected: GroundTruthItem[],
  parsed: Array<{ amount: number }>,
): { matched: number; extra: number } {
  const remaining = [...parsed];
  let matched = 0;
  for (const item of expected) {
    const idx = remaining.findIndex((p) => amountsClose(p.amount, item.amount));
    if (idx >= 0) {
      remaining.splice(idx, 1);
      matched += 1;
    }
  }
  return { matched, extra: remaining.length };
}

async function main() {
  if (!fs.existsSync(SAMPLES_DIR)) {
    fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  }

  const jsonFiles = fs
    .readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (jsonFiles.length === 0) {
    console.log(
      `No ground-truth files in ${SAMPLES_DIR} yet. Drop <id>.jpg + <id>.json pairs there ` +
        '(see README.md and ground-truth.example.json) and re-run.',
    );
    return;
  }

  const agent = new AgentService();
  const results: CaseResult[] = [];

  for (const jsonFile of jsonFiles) {
    const id = jsonFile.replace(/\.json$/, '');
    const imagePath = ['.jpg', '.jpeg', '.png']
      .map((ext) => path.join(SAMPLES_DIR, id + ext))
      .find((p) => fs.existsSync(p));

    if (!imagePath) {
      console.warn(`SKIP  ${id} — no matching image (.jpg/.jpeg/.png)`);
      continue;
    }

    const groundTruth: GroundTruth = JSON.parse(
      fs.readFileSync(path.join(SAMPLES_DIR, jsonFile), 'utf-8'),
    );
    const mediaType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const base64 = fs.readFileSync(imagePath).toString('base64');

    const { parsed, inputTokens, outputTokens } = await agent.extractReceipt([
      { base64, mediaType },
    ]);

    const merchantNameMatch: boolean | 'n/a' =
      groundTruth.merchantName == null
        ? 'n/a'
        : normalizeText(parsed.merchantName ?? '') === normalizeText(groundTruth.merchantName);

    const purchaseDateMatch: boolean | 'n/a' =
      groundTruth.purchaseDate == null ? 'n/a' : parsed.purchaseDate === groundTruth.purchaseDate;

    const totalMatch = amountsClose(parsed.total, groundTruth.total);
    const discountTotalMatch = amountsClose(
      parsed.discountTotal ?? 0,
      groundTruth.discountTotal ?? 0,
    );
    const { matched, extra } = matchItems(groundTruth.items, parsed.items);

    results.push({
      name: id,
      merchantNameMatch,
      purchaseDateMatch,
      totalMatch,
      discountTotalMatch,
      itemsMatched: matched,
      itemsExpected: groundTruth.items.length,
      itemsExtra: extra,
      inputTokens,
      outputTokens,
    });

    console.log(
      `${id}: merchant=${merchantNameMatch} date=${purchaseDateMatch} total=${totalMatch} ` +
        `discount=${discountTotalMatch} items=${matched}/${groundTruth.items.length}` +
        `${extra > 0 ? ` (+${extra} unexpected)` : ''}`,
    );
  }

  if (results.length === 0) {
    console.log('No cases had a matching image — nothing measured.');
    return;
  }

  report(results);
}

function report(results: CaseResult[]): void {
  const pct = (num: number, den: number) => (den === 0 ? 100 : (100 * num) / den);

  const withMerchant = results.filter((r) => r.merchantNameMatch !== 'n/a');
  const withDate = results.filter((r) => r.purchaseDateMatch !== 'n/a');
  const merchantAcc = pct(
    withMerchant.filter((r) => r.merchantNameMatch === true).length,
    withMerchant.length,
  );
  const dateAcc = pct(withDate.filter((r) => r.purchaseDateMatch === true).length, withDate.length);
  const totalAcc = pct(results.filter((r) => r.totalMatch).length, results.length);
  const discountAcc = pct(results.filter((r) => r.discountTotalMatch).length, results.length);
  const itemsExpectedSum = results.reduce((s, r) => s + r.itemsExpected, 0);
  const itemsMatchedSum = results.reduce((s, r) => s + r.itemsMatched, 0);
  const itemsExtraSum = results.reduce((s, r) => s + r.itemsExtra, 0);
  const itemRecall = pct(itemsMatchedSum, itemsExpectedSum);

  const fullyCorrect = results.filter(
    (r) =>
      r.merchantNameMatch !== false &&
      r.purchaseDateMatch !== false &&
      r.totalMatch &&
      r.discountTotalMatch &&
      r.itemsMatched === r.itemsExpected &&
      r.itemsExtra === 0,
  ).length;

  // Same placeholder Claude Sonnet rate used in receipts.service.ts's
  // UsageLog.estimatedCostUsd — only for gauging this run's own cost.
  const totalCostUsd = results.reduce(
    (s, r) => s + (r.inputTokens / 1_000_000) * 3 + (r.outputTokens / 1_000_000) * 15,
    0,
  );

  console.log('\n--- Summary ---');
  console.log(`Receipts measured: ${results.length}`);
  console.log(`merchantName accuracy: ${merchantAcc.toFixed(1)}% (${withMerchant.length} labeled)`);
  console.log(`purchaseDate accuracy: ${dateAcc.toFixed(1)}% (${withDate.length} labeled)`);
  console.log(`total accuracy: ${totalAcc.toFixed(1)}%`);
  console.log(`discountTotal accuracy: ${discountAcc.toFixed(1)}%`);
  console.log(
    `line-item recall: ${itemRecall.toFixed(1)}% (${itemsMatchedSum}/${itemsExpectedSum} expected ` +
      `items found, ${itemsExtraSum} unexpected extra items across all receipts)`,
  );
  console.log(
    `fully correct receipts: ${fullyCorrect}/${results.length} ` +
      `(${pct(fullyCorrect, results.length).toFixed(1)}%)`,
  );
  console.log(`estimated Claude API cost for this run: $${totalCostUsd.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
