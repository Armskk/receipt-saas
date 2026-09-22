/**
 * Manual regression check for AgentService's discountTotal handling
 * (Order 120.5). Calls the real Claude API against the fixtures in
 * fixtures/ and asserts sum(items) - discountTotal === total.
 *
 * Not part of CI (real API cost, like scripts/e2e). Run after touching the
 * RECORD_RECEIPT_TOOL schema or EXTRACTION_PROMPT in agent.service.ts:
 *
 *   npx ts-node --transpile-only scripts/agent-samples/check.ts
 *
 * Needs ANTHROPIC_API_KEY in backend/.env.
 */
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';
import { AgentService } from '../../src/agent/agent.service';

config({ path: path.join(__dirname, '../../.env') });

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const cases = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.jpg'))
  .sort();

async function main() {
  const agent = new AgentService();
  let failures = 0;

  for (const name of cases) {
    const base64 = fs.readFileSync(path.join(FIXTURES_DIR, name)).toString('base64');
    const { parsed } = await agent.extractReceipt([{ base64, mediaType: 'image/jpeg' }]);
    const itemsSum = parsed.items.reduce((sum, item) => sum + item.amount, 0);
    const reconciled = itemsSum - (parsed.discountTotal ?? 0);
    const ok = Math.abs(reconciled - parsed.total) <= 0.01;

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    console.log(
      `  items=${JSON.stringify(parsed.items.map((i) => i.amount))} sum=${itemsSum} ` +
        `discountTotal=${parsed.discountTotal ?? 'null'} total=${parsed.total} ` +
        `(itemsSum - discountTotal = ${reconciled})`,
    );
    if (!ok) failures += 1;
  }

  if (failures > 0) {
    console.error(`\n${failures}/${cases.length} case(s) failed reconciliation`);
    process.exit(1);
  }
  console.log(`\nAll ${cases.length} case(s) reconciled.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
