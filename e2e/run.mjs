#!/usr/bin/env node
// End-to-end runner: for each edition (EDITION=cloud|onprem, default both)
//   1. migrate + reset-seed the e2e database (DATABASE_URL, default postgres://erp:erp@localhost:5432/erp_e2e)
//   2. build apps/web for that edition (dist/ or dist-onprem/; on-prem build is checked by scripts/check-onprem.mjs)
//   3. start the API server with WEB_DIST_DIR pointing at the build
//   4. run the Playwright browser flows in e2e/ against it
// Usage: pnpm e2e  |  EDITION=onprem pnpm e2e  |  pnpm e2e -- --grep returns
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_e2e';
const editions = process.env.EDITION ? [process.env.EDITION] : ['onprem', 'cloud'];
const extraArgs = process.argv.slice(2).filter((a) => a !== '--');
const env = { ...process.env, DATABASE_URL };

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...env, ...opts.env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

/** Creates the e2e database when it is missing (local dev; CI's postgres service creates it). */
function ensureDatabase() {
  const name = new URL(DATABASE_URL).pathname.slice(1);
  const probe = spawnSync('psql', [DATABASE_URL, '-tAc', 'select 1'], { encoding: 'utf8' });
  if (probe.status === 0) return;
  if (!/does not exist/.test(probe.stderr ?? '')) {
    if (probe.error) console.warn('[e2e] psql not available; assuming the database exists');
    return;
  }
  console.log(`[e2e] creating database ${name}`);
  const owner = new URL(DATABASE_URL).username || 'erp';
  const r = spawnSync('su', ['postgres', '-c', `createdb -O ${owner} ${name}`], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`could not create database ${name}`);
}

async function waitFor(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function runEdition(edition, port) {
  console.log(`\n================ e2e: ${edition} ================`);
  run('pnpm', ['db:migrate']);
  run('pnpm', ['--filter', '@erp/db', 'exec', 'tsx', 'src/seed.ts', '--reset']);
  const outDir = edition === 'onprem' ? 'dist-onprem' : 'dist';
  run('pnpm', ['--filter', '@erp/web', 'exec', 'vite', 'build', '--outDir', outDir], { env: { VITE_EDITION: edition } });
  if (edition === 'onprem') run('node', ['scripts/check-onprem.mjs', `apps/web/${outDir}`]);

  const server = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), ['src/main.ts'], {
    cwd: path.join(ROOT, 'apps/server'),
    env: { ...env, EDITION: edition, PORT: String(port), HOST: '127.0.0.1', JWT_SECRET: 'e2e-secret', WEB_DIST_DIR: path.join(ROOT, 'apps/web', outDir), MDNS_SERVICE_TYPE: 'off', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  const stop = () => { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ } };
  process.once('exit', stop);
  try {
    await waitFor(`http://127.0.0.1:${port}/healthz`);
    run('pnpm', ['exec', 'playwright', 'test', '-c', 'e2e/playwright.config.ts', ...extraArgs], {
      env: { BASE_URL: `http://127.0.0.1:${port}`, EDITION: edition },
    });
  } finally {
    stop();
    await new Promise((res) => setTimeout(res, 500));
  }
}

ensureDatabase();
let port = 3310;
const failed = [];
for (const ed of editions) {
  try {
    await runEdition(ed, port++);
  } catch (err) {
    console.error(`[e2e] ${ed} FAILED: ${err.message}`);
    failed.push(ed);
  }
}
if (failed.length) {
  console.error(`\n[e2e] failed editions: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n[e2e] all editions passed: ${editions.join(', ')}`);
