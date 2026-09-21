// End-to-end check of the split API / worker setup. Synthetic data only.
// Runs the BUILT API (dist/main.js) and worker (dist/worker.js) as separate
// processes against throwaway resources: DB `receipts_e2e`, a fresh MinIO
// bucket, and the shared local Redis (the queue must be idle). It calls the
// real Claude API (~7 requests). Prints step results; never prints env values.
// See README.md in this folder for prerequisites and how to run it.
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..', '..');
const REPO = path.resolve(BACKEND, '..');
const FIX = path.join(HERE, 'fixtures');
const LOGS = mkdtempSync(path.join(os.tmpdir(), 'receipt-e2e-')); // API/worker logs, kept for debugging

const TS = Date.now();
const E2E_DB = 'receipts_e2e';
const BUCKET = `e2e-${TS}`;
const API_PORT = 3999;
const BASE = `http://localhost:${API_PORT}`;
const RUN = `e2e-${TS}`;

// ---------- env (values are never printed) ----------
function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const fileEnv = loadEnv(path.join(BACKEND, '.env'));
const swapDb = (url, db) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const childEnv = (extra = {}) => ({
  ...process.env, ...fileEnv,
  DATABASE_URL: swapDb(fileEnv.DATABASE_URL, E2E_DB),
  APP_DATABASE_URL: swapDb(fileEnv.APP_DATABASE_URL, E2E_DB),
  S3_BUCKET: BUCKET, PORT: String(API_PORT), ...extra,
});

// ---------- tiny test harness ----------
const results = [];
let currentGroup = '';
const group = (name) => { currentGroup = name; console.log(`\n## ${name}`); };
function check(name, ok, detail = '') {
  results.push({ group: currentGroup, name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 60000, interval = 500 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return null;
}

// ---------- infra helpers ----------
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
const psql = (db, sql) =>
  sh(`docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d ${db} -At -v ON_ERROR_STOP=1'`, { input: sql }).trim();
const redis = (...args) => sh(`docker compose exec -T redis redis-cli ${args.join(' ')}`).trim();

const procs = {};
function start(name, script, extraEnv = {}) {
  const logFile = path.join(LOGS, `${name}.log`);
  writeFileSync(logFile, '');
  const p = spawn('node', [script], { cwd: BACKEND, env: childEnv(extraEnv) });
  const append = (d) => writeFileSync(logFile, d, { flag: 'a' });
  p.stdout.on('data', append); p.stderr.on('data', append);
  procs[name] = { p, logFile };
  return procs[name];
}
const logText = (name) => (existsSync(procs[name]?.logFile ?? '') ? readFileSync(procs[name].logFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '') : '');
async function stop(name, signal = 'SIGTERM') {
  const x = procs[name]; if (!x || x.p.exitCode !== null) return;
  x.p.kill(signal); await sleep(800);
}

// ---------- API helpers ----------
async function api(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : form });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
function upload(token, wsId, files) {
  const form = new FormData();
  for (const f of files) {
    const type = f.endsWith('.jpg') ? 'image/jpeg' : f.endsWith('.png') ? 'image/png' : 'text/plain';
    form.append('files', new Blob([readFileSync(path.join(FIX, f))], { type }), f);
  }
  return api('POST', `/workspaces/${wsId}/receipts/upload`, { token, form });
}
const getReceipt = (token, ws, id) => api('GET', `/workspaces/${ws}/receipts/${id}`, { token });
async function waitStatus(token, ws, id, statuses, timeout = 120000) {
  return waitFor(async () => {
    const r = await getReceipt(token, ws, id);
    return statuses.includes(r.json?.status) ? r.json : null;
  }, { timeout, interval: 1000 });
}
const sumItems = (r) => r.items.reduce((s, i) => s + Number(i.amount), 0);
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

// Fail early, with an actionable message, instead of a raw exec error halfway in.
function preflight() {
  const problems = [];
  for (const f of ['dist/main.js', 'dist/worker.js']) {
    if (!existsSync(path.join(BACKEND, f))) problems.push(`${f} is missing — run \`npm run build\` in backend/`);
  }
  for (const k of ['DATABASE_URL', 'APP_DATABASE_URL']) {
    if (!fileEnv[k]) problems.push(`${k} is not set in backend/.env`);
  }
  if (!fileEnv.ANTHROPIC_API_KEY) problems.push('ANTHROPIC_API_KEY is not set in backend/.env (the worker calls Claude)');
  let running = [];
  try { running = sh("docker compose ps --status running --format '{{.Service}}'").split('\n'); } catch { /* docker not available */ }
  for (const s of ['postgres', 'redis', 'minio']) {
    if (!running.includes(s)) problems.push(`${s} is not running — run \`docker compose up -d postgres redis minio\` in the repo root`);
  }
  if (!problems.length) {
    // A leftover job would be picked up by OUR worker against the e2e DB and fail confusingly.
    const busy = ['wait', 'active'].some((k) => redis('LLEN', `bull:receipt-processing:${k}`) !== '0');
    if (busy) problems.push('the local Redis queue has waiting/active jobs — stop any running worker and let it drain first');
  }
  if (problems.length) throw new Error(`preflight failed:\n  - ${problems.join('\n  - ')}`);
  check('preflight: build present, infra up, queue idle', true);
}

async function main() {
  // ===== 0. setup =====
  group('0. Setup (throwaway DB + bucket)');
  preflight();
  createdResources = true;
  psql('postgres', `DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE);`);
  psql('postgres', `CREATE DATABASE ${E2E_DB};`);
  execSync('npx prisma migrate deploy', { cwd: BACKEND, env: childEnv({ DATABASE_URL: swapDb(fileEnv.DATABASE_URL, E2E_DB) }), stdio: 'pipe' });
  check(`created ${E2E_DB} and applied migrations`, true);
  const failedBefore = Number(redis('ZCARD', 'bull:receipt-processing:failed'));

  // ===== 1. API alone =====
  group('1. API alone (no worker running)');
  start('api', 'dist/main.js');
  const apiUp = await waitFor(() => logText('api').includes('Backend listening'), { timeout: 40000 });
  check('API boots', !!apiUp);
  if (!apiUp) throw new Error(`API did not start:\n${logText('api').slice(-1500)}`);
  const clients = redis('CLIENT', 'LIST');
  check('API has no BullMQ worker connection in Redis', !/name=bull:/.test(clients));

  const pw = 'e2e-Passw0rd!';
  const a = await api('POST', '/auth/signup', { body: { email: `${RUN}-a@example.test`, password: pw, name: 'E2E A', workspaceName: 'E2E Workspace A' } });
  const b = await api('POST', '/auth/signup', { body: { email: `${RUN}-b@example.test`, password: pw, name: 'E2E B', workspaceName: 'E2E Workspace B' } });
  check('signup A and B return a token', !!a.json?.accessToken && !!b.json?.accessToken, `status ${a.status}/${b.status}`);
  const tokA = a.json.accessToken, tokB = b.json.accessToken;
  const wsA = (await api('GET', '/workspaces', { token: tokA })).json?.[0]?.id;
  const wsB = (await api('GET', '/workspaces', { token: tokB })).json?.[0]?.id;
  check('each user has their own workspace', !!wsA && !!wsB && wsA !== wsB);

  const rej = await upload(tokA, wsA, ['notes.txt']);
  check('non-image-only upload is rejected (400)', rej.status === 400, `status ${rej.status}`);

  const t0 = Date.now();
  const up1 = await upload(tokA, wsA, ['a_mart.jpg']);
  check('upload returns fast with PENDING', (up1.status === 201 || up1.status === 200) && up1.json?.status === 'PENDING', `status ${up1.status}, ${Date.now() - t0}ms`);
  const idA = up1.json.receiptId;
  await sleep(8000);
  const still = await getReceipt(tokA, wsA, idA);
  check('receipt stays PENDING after 8s (API does not consume the job)', still.json?.status === 'PENDING', `status=${still.json?.status}`);
  check('API log has no "Processing receipt"', !logText('api').includes('Processing receipt'));
  check('job is waiting in the queue (LLEN wait = 1)', redis('LLEN', 'bull:receipt-processing:wait') === '1', `wait=${redis('LLEN', 'bull:receipt-processing:wait')}`);

  // ===== 2. start worker =====
  group('2. Worker picks the job up');
  start('worker', 'dist/worker.js');
  check('worker boots', !!(await waitFor(() => logText('worker').includes('worker started'), { timeout: 40000 })));
  const parsed = await waitStatus(tokA, wsA, idA, ['PARSED', 'FAILED']);
  check('receipt reaches PARSED', parsed?.status === 'PARSED', `status=${parsed?.status} ${parsed?.failureReason ?? ''}`);
  check('worker log shows "Processing receipt <id>"', logText('worker').includes(`Processing receipt ${idA}`));
  check('API log still has no "Processing receipt"', !logText('api').includes('Processing receipt'));
  if (parsed?.status === 'PARSED') {
    check('extracted total = 214.50', near(parsed.total, 214.5), `total=${parsed.total}`);
    check('3 line items summing to 214.50', parsed.items.length === 3 && near(sumItems(parsed), 214.5), `items=${parsed.items.length}, sum=${sumItems(parsed).toFixed(2)}`);
    const u = psql(E2E_DB, `select count(*), coalesce(max("inputTokens"),0) from usage_logs where "receiptId"='${idA}'`);
    const [n, inTok] = u.split('|').map(Number);
    check('usage_logs row written with token counts', n === 1 && inTok > 0, `rows=${n}, inputTokens=${inTok}`);
  }

  // ===== 3. confirm + summary =====
  group('3. Confirm and monthly summary');
  const conf = await api('PATCH', `/workspaces/${wsA}/receipts/${idA}/confirm`, { token: tokA });
  check('confirm -> CONFIRMED', conf.json?.status === 'CONFIRMED', `status ${conf.status} ${conf.json?.status}`);

  // ===== 4. concurrent + multi-image =====
  group('4. Concurrent uploads, Thai receipt, multi-image');
  const [ub, ud, uc] = await Promise.all([
    upload(tokA, wsA, ['b_thai.jpg']), upload(tokA, wsA, ['d_pharmacy.jpg']),
    upload(tokA, wsA, ['c_cafe_1.jpg', 'c_cafe_2.jpg', 'notes.txt']),
  ]);
  check('3 concurrent uploads accepted', [ub, ud, uc].every((r) => r.json?.receiptId), `${ub.status}/${ud.status}/${uc.status}`);
  check('multi-image upload: imageCount 2, txt rejected', uc.json?.imageCount === 2 && uc.json?.rejected?.length === 1, JSON.stringify({ n: uc.json?.imageCount, rej: uc.json?.rejected?.length }));
  const [rb, rd, rc] = await Promise.all([
    waitStatus(tokA, wsA, ub.json.receiptId, ['PARSED', 'FAILED'], 180000),
    waitStatus(tokA, wsA, ud.json.receiptId, ['PARSED', 'FAILED'], 180000),
    waitStatus(tokA, wsA, uc.json.receiptId, ['PARSED', 'FAILED'], 180000),
  ]);
  check('all 3 reach PARSED', [rb, rd, rc].every((r) => r?.status === 'PARSED'), [rb, rd, rc].map((r) => r?.status).join('/'));
  if (rb?.status === 'PARSED') check('Thai receipt total = 70.00', near(rb.total, 70), `total=${rb.total}, items=${rb.items.map((i) => i.description).join(', ')}`);
  if (rd?.status === 'PARSED') check('pharmacy total = 150.00', near(rd.total, 150), `total=${rd.total}`);
  if (rc?.status === 'PARSED') {
    check('multi-image stored both image keys', rc.imageKeys.length === 2, `imageKeys=${rc.imageKeys.length}`);
    check('multi-image merged: 6 items, no double count (total 465.00)', rc.items.length === 6 && near(rc.total, 465) && near(sumItems(rc), 465),
      `items=${rc.items.length}, total=${rc.total}, sum=${sumItems(rc).toFixed(2)}`);
  }
  const summary = (await api('GET', `/workspaces/${wsA}/receipts/summary?month=2026-09`, { token: tokA })).json;
  check('monthly summary counts the 4 parsed/confirmed receipts, total 899.50', summary?.receiptCount === 4 && near(summary?.total, 899.5), `count=${summary?.receiptCount}, total=${summary?.total}`);

  // ===== 5. tenant isolation =====
  group('5. Tenant isolation over HTTP');
  const x1 = await getReceipt(tokB, wsA, idA);
  check("B can't read A's receipt via A's workspace (403/404)", [403, 404].includes(x1.status), `status ${x1.status}`);
  const x2 = await api('GET', `/workspaces/${wsA}/receipts`, { token: tokB });
  check("B can't list A's receipts (403/404)", [403, 404].includes(x2.status), `status ${x2.status}`);
  const x3 = await getReceipt(tokB, wsB, idA);
  check("A's receipt id via B's own workspace -> 404", x3.status === 404, `status ${x3.status}`);
  const x4 = await api('GET', `/workspaces/${wsB}/receipts`, { token: tokB });
  check("B's own list is empty", Array.isArray(x4.json) && x4.json.length === 0, `len=${x4.json?.length}`);
  const x5 = await getReceipt(undefined, wsA, idA);
  check('no token -> 401', x5.status === 401, `status ${x5.status}`);

  // ===== 6. failure path =====
  group('6. Bad image -> retries -> FAILED');
  const ubad = await upload(tokA, wsA, ['bad.png']);
  const badId = ubad.json?.receiptId;
  const exhausted = await waitFor(() => Number(redis('ZCARD', 'bull:receipt-processing:failed')) === failedBefore + 1, { timeout: 90000, interval: 1000 });
  check('job exhausts its retries (moves to BullMQ failed set)', !!exhausted);
  const bad = await getReceipt(tokA, wsA, badId);
  check('receipt is FAILED with a failureReason', bad.json?.status === 'FAILED' && !!bad.json?.failureReason, `status=${bad.json?.status}, reason="${(bad.json?.failureReason ?? '').slice(0, 80)}"`);
  const attempts = (logText('worker').match(new RegExp(`Receipt ${badId} failed`, 'g')) ?? []).length;
  check('worker attempted it 3 times (queue policy)', attempts === 3, `attempts=${attempts}`);

  // ===== 7. worker killed mid-job =====
  group('7. Worker killed mid-job, then restarted');
  const ue = await upload(tokA, wsA, ['e_kiosk.jpg']);
  const eId = ue.json?.receiptId;
  const inflight = await waitFor(async () => (await getReceipt(tokA, wsA, eId)).json?.status === 'PROCESSING', { timeout: 30000, interval: 150 });
  const killedBefore = (await getReceipt(tokA, wsA, eId)).json?.status;
  await stop('worker', 'SIGKILL');
  if (inflight && killedBefore === 'PROCESSING') {
    check('killed the worker while the receipt was PROCESSING', true);
    await sleep(3000);
    const after = (await getReceipt(tokA, wsA, eId)).json?.status;
    check('receipt is not lost: still PROCESSING right after the kill', after === 'PROCESSING', `status=${after}`);
    start('worker', 'dist/worker.js');
    const rec = await waitStatus(tokA, wsA, eId, ['PARSED', 'FAILED'], 180000);
    check('restarted worker recovers the stalled job -> PARSED', rec?.status === 'PARSED', `status=${rec?.status}`);
    if (rec?.status === 'PARSED') check('kiosk total = 100.00', near(rec.total, 100), `total=${rec.total}`);
  } else {
    check('killed the worker while the receipt was PROCESSING', false, `inconclusive: status was ${killedBefore} (job finished before the kill)`);
    start('worker', 'dist/worker.js');
  }

  // ===== 8. API without ANTHROPIC_API_KEY =====
  group('8. API without ANTHROPIC_API_KEY');
  await stop('api');
  start('api', 'dist/main.js', { ANTHROPIC_API_KEY: '' });
  const up2 = await waitFor(() => logText('api').includes('Backend listening'), { timeout: 40000 });
  check('API boots with ANTHROPIC_API_KEY empty', !!up2, up2 ? '' : logText('api').slice(-400));
  const lg = await api('POST', '/auth/login', { body: { email: `${RUN}-a@example.test`, password: pw } });
  check('login works', !!lg.json?.accessToken, `status ${lg.status}`);
  const uf = await upload(lg.json?.accessToken, wsA, ['d_pharmacy.jpg']);
  check('upload still enqueues (PENDING)', uf.json?.status === 'PENDING', `status ${uf.status}`);
  const rf = await waitStatus(lg.json?.accessToken, wsA, uf.json?.receiptId, ['PARSED', 'FAILED'], 120000);
  check('worker (with the key) parses it -> PARSED', rf?.status === 'PARSED', `status=${rf?.status}`);
}

let createdResources = false; // set once preflight passed and we start creating the DB/bucket

async function cleanup() {
  for (const n of Object.keys(procs)) { try { procs[n].p.kill('SIGKILL'); } catch { /* gone */ } }
  if (!createdResources) return; // aborted in preflight: nothing to clean up
  console.log('\n## Cleanup');
  await sleep(500);
  try { psql('postgres', `DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE);`); console.log(`  dropped ${E2E_DB}`); } catch (e) { console.log('  DB drop failed:', e.message.split('\n')[0]); }
  try {
    const { Client } = createRequire(path.join(BACKEND, 'package.json'))('minio');
    const c = new Client({ endPoint: fileEnv.S3_ENDPOINT ?? 'localhost', port: Number(fileEnv.S3_PORT ?? 9000), useSSL: fileEnv.S3_USE_SSL === 'true', accessKey: fileEnv.S3_ACCESS_KEY, secretKey: fileEnv.S3_SECRET_KEY });
    const keys = [];
    for await (const o of c.listObjectsV2(BUCKET, '', true)) keys.push(o.name);
    if (keys.length) await c.removeObjects(BUCKET, keys);
    await c.removeBucket(BUCKET);
    console.log(`  removed bucket ${BUCKET} (${keys.length} objects)`);
  } catch (e) { console.log('  bucket cleanup:', e.message); }
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.log(`\nABORTED: ${e.message}`); }
await cleanup();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed${crashed ? ' (run aborted early)' : ''} ===`);
failed.forEach((f) => console.log(`  FAILED: [${f.group}] ${f.name}`));
if (failed.length || crashed) console.log(`API/worker logs: ${LOGS}`);
process.exit(failed.length || crashed ? 1 : 0);
