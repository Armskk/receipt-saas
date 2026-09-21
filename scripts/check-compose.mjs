#!/usr/bin/env node
// Static checks of the deployment compose setup — no containers, no network. Runs in CI and
// locally (`node scripts/check-compose.mjs`, needs Docker Compose >= 2.24).
//
// It works in a temp copy of the compose files with freshly generated env files, so it never
// touches your real .env files, and it proves the properties this setup exists for:
//   - an environment (stg/production) publishes NO host ports; only the shared edge Caddy does (80/443)
//   - Postgres/Redis/MinIO/worker are only on the environment's private network
//   - two environments get different secrets and different edge aliases (so they can't collide)
//   - only the one-shot `migrate` service gets the database OWNER credentials, and the API waits for it
//   - the frontend's NEXT_PUBLIC_* values are build args; images don't contain .env files
//   - the dev stack only binds its ports to localhost
// Secrets are never printed, only the names of the checks.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'compose-check-'));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
};

function compose(projectArgs, extra = []) {
  const out = execFileSync('docker', ['compose', ...projectArgs, 'config', '--format', 'json', ...extra], {
    cwd: tmp,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}
const envProject = (n) => [
  '-p', `receipt-${n}`, '--env-file', `.env.${n}`,
  '-f', 'docker-compose.yml', '-f', 'docker-compose.prod.yml',
];
const published = (svc) => (svc.ports ?? []).map((p) => `${p.host_ip ?? '*'}:${p.published}->${p.target}`);
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

try {
  // Temp copy: compose files + what they mount, plus empty stand-ins for the dev-only env files
  // the base file references, so `config` works on a clean checkout (as in CI).
  for (const f of ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.edge.yml', 'Caddyfile']) {
    cpSync(path.join(repo, f), path.join(tmp, f));
  }
  cpSync(path.join(repo, 'deploy'), path.join(tmp, 'deploy'), { recursive: true });
  mkdirSync(path.join(tmp, 'backend'));
  mkdirSync(path.join(tmp, 'frontend'));
  for (const f of ['.env', 'backend/.env', 'frontend/.env.local']) writeFileSync(path.join(tmp, f), '');

  const gen = (name) =>
    execFileSync('bash', [path.join(repo, 'scripts/init-env.sh'), name], {
      env: { ...process.env, INIT_ENV_ROOT: tmp }, stdio: 'ignore',
    });
  // Two throwaway environments; the real names (stg/production) are checked via the site files below.
  gen('cia');
  gen('cib');

  const envs = {};
  for (const n of ['cia', 'cib']) {
    console.log(`\n## environment "${n}" (docker-compose.yml + docker-compose.prod.yml)`);
    const c = compose(envProject(n));
    envs[n] = c;
    const names = Object.keys(c.services);
    check('runs exactly postgres, redis, minio, migrate, backend, worker, frontend (no per-project Caddy)',
      sameSet(names, ['postgres', 'redis', 'minio', 'migrate', 'backend', 'worker', 'frontend']), names.join(','));
    const withPorts = Object.entries(c.services).filter(([, s]) => published(s).length).map(([k]) => k);
    check('publishes no host port on any service', withPorts.length === 0, `published: ${withPorts.join(',')}`);
    for (const s of ['backend', 'frontend']) {
      const nets = c.services[s].networks ?? {};
      check(`${s} is on default + edge with alias ${n}-${s}`,
        'default' in nets && (nets.edge?.aliases ?? []).includes(`${n}-${s}`), JSON.stringify(Object.keys(nets)));
    }
    for (const s of ['postgres', 'redis', 'minio', 'worker', 'migrate']) {
      check(`${s} is only on the private network`, sameSet(Object.keys(c.services[s].networks ?? {}), ['default']),
        Object.keys(c.services[s].networks ?? {}).join(','));
    }
    check('edge network is the shared external receipt-edge', c.networks.edge?.external === true && c.networks.edge?.name === 'receipt-edge');
    const be = c.services.backend.environment ?? {};
    check('backend runs in production mode', be.NODE_ENV === 'production');
    check('backend reaches its dependencies by compose service name',
      /@postgres:5432\//.test(be.APP_DATABASE_URL ?? '') && be.REDIS_HOST === 'redis' && be.S3_ENDPOINT === 'minio');
    check('backend uses the non-privileged DB role', /^postgresql:\/\/receipts_app:/.test(be.APP_DATABASE_URL ?? ''));
    check('API/worker do NOT receive the DB owner credentials', !('DATABASE_URL' in be) && !('OWNER_DATABASE_URL' in be));
    check('worker gets the same env as the backend', JSON.stringify(c.services.worker.environment) === JSON.stringify(be));
    check('backend has CORS_ORIGINS set to an https:// origin (required in production)', /^https:\/\//.test(be.CORS_ORIGINS ?? ''), be.CORS_ORIGINS ?? '(unset)');

    // schema migrations run before the app starts, with the owner role — and only there
    const mg = c.services.migrate;
    check('migrate builds the migrate target and runs once (restart: no)', mg.build?.target === 'migrate' && mg.restart === 'no');
    check('migrate is the ONLY service holding the DB owner URL',
      /^postgresql:\/\/receipts:/.test(mg.environment?.DATABASE_URL ?? '')
      && Object.entries(c.services).every(([k, v]) => k === 'migrate' || !('DATABASE_URL' in (v.environment ?? {}))));
    for (const s of ['backend', 'worker']) {
      check(`${s} waits for migrate to complete successfully`,
        c.services[s].depends_on?.migrate?.condition === 'service_completed_successfully');
    }
    check('migrate waits for a healthy postgres', mg.depends_on?.postgres?.condition === 'service_healthy');
    check('backend healthcheck calls /health', JSON.stringify(c.services.backend.healthcheck?.test ?? []).includes('/health'));

    // frontend: NEXT_PUBLIC_* are build args (inlined at build time), and no runtime env file leaks in
    const fe = c.services.frontend;
    check('frontend gets NEXT_PUBLIC_API_URL as a build arg (https://)', /^https:\/\//.test(fe.build?.args?.NEXT_PUBLIC_API_URL ?? ''), fe.build?.args?.NEXT_PUBLIC_API_URL ?? '(unset)');
    check('frontend has no runtime environment (dev .env.local not carried over)', Object.keys(fe.environment ?? {}).length === 0);
    check('generated secrets are set (not placeholders)', !!be.JWT_SECRET && !/CHANGE_ME/.test(be.JWT_SECRET));
  }

  console.log('\n## two environments do not share secrets');
  const a = envs.cia.services, b = envs.cib.services;
  const pairs = {
    JWT_SECRET: [a.backend.environment.JWT_SECRET, b.backend.environment.JWT_SECRET],
    'APP_DATABASE_URL (role password)': [a.backend.environment.APP_DATABASE_URL, b.backend.environment.APP_DATABASE_URL],
    S3_SECRET_KEY: [a.backend.environment.S3_SECRET_KEY, b.backend.environment.S3_SECRET_KEY],
    TELEGRAM_WEBHOOK_SECRET: [a.backend.environment.TELEGRAM_WEBHOOK_SECRET, b.backend.environment.TELEGRAM_WEBHOOK_SECRET],
    POSTGRES_PASSWORD: [a.postgres.environment.POSTGRES_PASSWORD, b.postgres.environment.POSTGRES_PASSWORD],
    APP_DB_PASSWORD: [a.postgres.environment.APP_DB_PASSWORD, b.postgres.environment.APP_DB_PASSWORD],
    MINIO_ROOT_PASSWORD: [a.minio.environment.MINIO_ROOT_PASSWORD, b.minio.environment.MINIO_ROOT_PASSWORD],
  };
  for (const [k, [x, y]] of Object.entries(pairs)) check(`${k} differs`, !!x && !!y && x !== y);

  console.log('\n## shared edge (docker-compose.edge.yml)');
  const edgeEnv = (extra) => {
    writeFileSync(path.join(tmp, '.env.edge'), `STG_APP_DOMAIN=a.example\nSTG_API_DOMAIN=b.example\nPROD_APP_DOMAIN=c.example\nPROD_API_DOMAIN=d.example\n${extra}`);
    return ['-p', 'receipt-edge', '--env-file', '.env.edge', '-f', 'docker-compose.edge.yml'];
  };
  const none = compose(edgeEnv(''));
  check('only Caddy runs', sameSet(Object.keys(none.services), ['caddy']));
  check('publishes exactly TCP 80 and 443', sameSet(published(none.services.caddy).map((p) => p.split('->')[1]), ['80', '443'])
    && (none.services.caddy.ports ?? []).every((p) => p.protocol === 'tcp'), published(none.services.caddy).join(','));
  check('is on the shared external edge network', none.networks.edge?.external === true && none.networks.edge?.name === 'receipt-edge');
  const siteSources = (c) => (c.services.caddy.volumes ?? []).filter((v) => v.target.startsWith('/etc/caddy/sites/')).map((v) => `${path.basename(v.target)}<-${path.basename(v.source)}`);
  check('with nothing enabled, both sites are the empty disabled.caddy',
    sameSet(siteSources(none), ['stg.caddy<-disabled.caddy', 'production.caddy<-disabled.caddy']), siteSources(none).join(','));
  const both = compose(edgeEnv('EDGE_STG_SITE=./deploy/edge/sites/stg.caddy\nEDGE_PROD_SITE=./deploy/edge/sites/production.caddy\n'));
  check('enabling an environment mounts its site file',
    sameSet(siteSources(both), ['stg.caddy<-stg.caddy', 'production.caddy<-production.caddy']), siteSources(both).join(','));
  for (const [env, prefix] of [['stg', 'STG'], ['production', 'PROD']]) {
    const site = readFileSync(path.join(repo, `deploy/edge/sites/${env}.caddy`), 'utf8');
    check(`${env}.caddy routes ${prefix}_APP_DOMAIN -> ${env}-frontend:3000 and ${prefix}_API_DOMAIN -> ${env}-backend:3001`,
      site.includes(`{$${prefix}_APP_DOMAIN}`) && site.includes(`reverse_proxy ${env}-frontend:3000`)
      && site.includes(`{$${prefix}_API_DOMAIN}`) && site.includes(`reverse_proxy ${env}-backend:3001`));
  }

  console.log('\n## images (Dockerfiles and .dockerignore)');
  const read = (f) => readFileSync(path.join(repo, f), 'utf8');
  for (const dir of ['backend', 'frontend']) {
    const ignore = read(`${dir}/.dockerignore`).split('\n').map((l) => l.trim());
    check(`${dir}/.dockerignore keeps env files (secrets) out of the image`,
      ignore.includes('.env') && ignore.includes('.env.*') && ignore.includes('!.env.example') && ignore.includes('node_modules'));
  }
  const beDocker = read('backend/Dockerfile');
  const stages = [...beDocker.matchAll(/^FROM\s+\S+(?:\s+AS\s+(\S+))?/gim)].map((m) => m[1] ?? '(unnamed)');
  check('backend Dockerfile has a migrate stage and the runtime image is still the last stage',
    stages.includes('migrate') && stages[stages.length - 1] === '(unnamed)', stages.join(' > '));
  check('migrate stage runs `prisma migrate deploy`', /FROM builder AS migrate\s+CMD \["npx", "prisma", "migrate", "deploy"\]/.test(beDocker));
  const feDocker = read('frontend/Dockerfile');
  check('frontend Dockerfile declares the NEXT_PUBLIC_* build args before `next build`',
    ['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_LINE_ADD_FRIEND_URL', 'NEXT_PUBLIC_TELEGRAM_BOT_USERNAME'].every((v) => {
      const arg = feDocker.indexOf(`ARG ${v}`);
      return arg !== -1 && arg < feDocker.indexOf('RUN npm run build');
    }));
  check('the local full-stack build keeps a working default API URL', /ARG NEXT_PUBLIC_API_URL=http:\/\/localhost:3001/.test(feDocker));

  console.log('\n## dev stack (docker-compose.yml alone)');
  const dev = compose(['-f', 'docker-compose.yml']);
  for (const s of ['postgres', 'redis', 'minio', 'backend', 'frontend']) {
    const ports = dev.services[s].ports ?? [];
    check(`${s} binds only to 127.0.0.1`, ports.length > 0 && ports.every((p) => p.host_ip === '127.0.0.1'), published(dev.services[s]).join(','));
  }
} catch (err) {
  failed++;
  console.log(`\nERROR: ${(err.stderr?.toString() || err.message || String(err)).trim().split('\n').slice(0, 8).join('\n')}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`);
process.exit(failed ? 1 : 0);
