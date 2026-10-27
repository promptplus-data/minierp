#!/usr/bin/env node
// Vercel build for the CLOUD edition (docs/VERCEL.md). Writes the Build Output API v3 layout, which Vercel deploys
// as-is when the build command leaves a .vercel/output directory:
//
//   .vercel/output/config.json                     routes: static files, /api/* + /healthz -> function, SPA fallback
//   .vercel/output/static/                         apps/web built with VITE_EDITION=cloud
//   .vercel/output/functions/api.func/index.mjs    apps/server/src/vercel.ts bundled (EDITION=cloud baked in)
//   .vercel/output/functions/api.func/node_modules argon2 (+ deps) with its prebuilt linux-x64 binary
//
// Then, when a database URL is set, it applies the migrations and (SEED_DEMO=1) seeds the demo shop once.
// Migrations prefer the direct (non-pooled) URL: DATABASE_URL_UNPOOLED / POSTGRES_URL_NON_POOLING.
//
// Local: node scripts/vercel-build.mjs [--skip-db]   then   node scripts/vercel-local.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleEntry, copyNativeModules, REPO_ROOT } from '../apps/server/build.lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (ROOT !== REPO_ROOT) throw new Error('unexpected layout');
const OUT = path.join(ROOT, '.vercel/output');
const FUNC = path.join(OUT, 'functions/api.func');
const env = process.env;
const NODE_RUNTIME = env.VERCEL_NODE_RUNTIME ?? 'nodejs22.x';

function run(cmd, args, extraEnv = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...env, ...extraEnv } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(FUNC, { recursive: true });

// 1. web (cloud) -> static/
run('pnpm', ['--filter', '@erp/web', 'exec', 'vite', 'build', '--outDir', 'dist'], { VITE_EDITION: 'cloud' });
cpSync(path.join(ROOT, 'apps/web/dist'), path.join(OUT, 'static'), { recursive: true });

// 2. API function
await bundleEntry({ edition: 'cloud', entry: path.join(ROOT, 'apps/server/src/vercel.ts'), outfile: path.join(FUNC, 'index.mjs') });
const natives = copyNativeModules(path.join(FUNC, 'node_modules'));
writeFileSync(path.join(FUNC, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n');
writeFileSync(
  path.join(FUNC, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: NODE_RUNTIME,
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: false,
      maxDuration: Number(env.VERCEL_MAX_DURATION ?? 30),
      environment: { NODE_ENV: 'production', EDITION: 'cloud' },
    },
    null,
    2,
  ) + '\n',
);
console.log(`[vercel-build] function api.func (${NODE_RUNTIME}), native modules: ${natives.join(', ') || 'none'}`);

// 3. routing
const config = {
  version: 3,
  routes: [
    { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
    { src: '^/(api(?:/.*)?|healthz)$', dest: '/api' },
    { handle: 'filesystem' },
    // SPA fallback: client-side routes get index.html (the API never reaches this point).
    { src: '^/(.*)$', dest: '/index.html', headers: { 'cache-control': 'no-cache' } },
  ],
};
writeFileSync(path.join(OUT, 'config.json'), JSON.stringify(config, null, 2) + '\n');

// 4. database: migrations + optional demo seed
const migrateUrl = env.DATABASE_URL_UNPOOLED ?? env.POSTGRES_URL_NON_POOLING ?? env.DATABASE_URL ?? env.POSTGRES_URL;
if (process.argv.includes('--skip-db') || env.SKIP_DB_BOOTSTRAP === '1') {
  console.log('[vercel-build] database bootstrap skipped');
} else if (!migrateUrl) {
  console.warn('[vercel-build] no DATABASE_URL at build time: migrations NOT applied (see docs/VERCEL.md)');
} else {
  const tsx = path.join(ROOT, 'node_modules/.bin/tsx');
  run(existsSync(tsx) ? tsx : 'tsx', ['packages/db/src/bootstrap.ts'], {
    DATABASE_URL: migrateUrl,
    MIGRATIONS_DIR: path.join(ROOT, 'packages/db/migrations'),
  });
}
console.log('[vercel-build] done -> .vercel/output');
