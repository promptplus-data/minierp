// Shared esbuild bundling for the two server editions.
// Used by build.cloud.mjs, build.onprem.mjs and scripts/check-onprem.mjs (--source).
//
// Output: apps/server/dist-<edition>/
//   server.mjs        single-file ESM bundle of src/main.ts (workspace packages inlined)
//   migrate.mjs       bundle of packages/db/src/migrate.ts, only if that file exists
//   migrations/       copy of packages/db/{drizzle,migrations}, only if one exists
//   package.json      lists the native modules left external; run `npm install --omit=dev`
//                     in this directory on the TARGET OS to fetch their prebuilt binaries
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SERVER_DIR, '../..');
export const ENTRY = path.join(SERVER_DIR, 'src/main.ts');
const MIGRATE_ENTRY = path.join(REPO_ROOT, 'packages/db/src/migrate.ts');
const MIGRATION_DIRS = ['drizzle', 'migrations'].map((d) => path.join(REPO_ROOT, 'packages/db', d));

export const EDITIONS = /** @type {const} */ (['cloud', 'onprem']);

/** Anything whose import specifier or resolved file path matches this is cloud-only (Prompt Plus). */
export const CLOUD_ONLY_MODULE = /promptplus/i;

/** Native / optional modules that cannot be inlined. Installed next to the bundle instead. */
const EXTERNAL_NATIVE = ['argon2', 'pg-native'];

// ESM output + CJS dependencies (fastify, pg, ...) need require/__dirname in scope.
const ESM_CJS_SHIM = [
  "import { createRequire as __erpCreateRequire } from 'node:module';",
  "import { fileURLToPath as __erpFileURLToPath } from 'node:url';",
  "import { dirname as __erpDirname } from 'node:path';",
  'const require = __erpCreateRequire(import.meta.url);',
  'const __filename = __erpFileURLToPath(import.meta.url);',
  'const __dirname = __erpDirname(__filename);',
].join('\n');

export class EntryMissingError extends Error {
  constructor(entry) {
    super(
      `Server entry point not found: ${path.relative(REPO_ROOT, entry)}\n` +
        'apps/server/src/main.ts has not been written yet, so there is nothing to bundle.',
    );
    this.name = 'EntryMissingError';
  }
}

/**
 * esbuild plugin (onprem only): every import whose specifier OR resolved path matches
 * CLOUD_ONLY_MODULE is replaced by an empty CommonJS module, so named imports evaluate
 * to `undefined`. Server code must still guard cloud-only calls with
 * `process.env.EDITION === 'cloud'` (constant-folded by `define`), otherwise the
 * call site itself stays in the bundle and check-onprem fails on the identifier name.
 *
 * The stub's virtual path deliberately contains no "promptplus" text, because esbuild
 * writes module paths into the bundle as comments.
 */
export function excludeCloudOnlyModules(excluded = []) {
  let n = 0;
  const stub = (from, importer) => {
    excluded.push({ from, importer: importer ? path.relative(REPO_ROOT, importer) : '' });
    return { path: `excluded-${++n}`, namespace: 'edition-excluded', sideEffects: false };
  };
  return {
    name: 'exclude-cloud-only-modules',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.skipExclusionCheck) return undefined;
        if (args.kind === 'entry-point') return undefined;
        if (CLOUD_ONLY_MODULE.test(args.path)) return stub(args.path, args.importer);
        const r = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          namespace: args.namespace,
          with: args.with,
          pluginData: { skipExclusionCheck: true },
        });
        if (r.errors.length > 0) return { errors: r.errors, warnings: r.warnings };
        if (!r.external && CLOUD_ONLY_MODULE.test(r.path)) return stub(r.path, args.importer);
        return {
          path: r.path,
          namespace: r.namespace,
          external: r.external,
          sideEffects: r.sideEffects,
          suffix: r.suffix,
          pluginData: r.pluginData,
          warnings: r.warnings,
        };
      });
      build.onLoad({ filter: /.*/, namespace: 'edition-excluded' }, () => ({
        contents: 'module.exports = {};',
        loader: 'js',
      }));
    },
  };
}

function esbuildOptions(edition, entry, outfile, write, excluded) {
  return {
    entryPoints: [entry],
    outfile,
    write,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    metafile: true,
    // minifySyntax folds `process.env.EDITION === 'cloud'` and drops dead branches;
    // whitespace and names stay readable for support on customer machines.
    minifySyntax: true,
    sourcemap: write ? 'linked' : false,
    // Do not ship original sources inside on-prem sourcemaps.
    sourcesContent: edition !== 'onprem',
    external: EXTERNAL_NATIVE,
    define: { 'process.env.EDITION': JSON.stringify(edition) },
    banner: { js: ESM_CJS_SHIM },
    plugins: edition === 'onprem' ? [excludeCloudOnlyModules(excluded)] : [],
    logLevel: 'warning',
  };
}

/**
 * Bundle the server for one edition.
 * @param {{ edition: 'cloud' | 'onprem', write?: boolean }} opts
 *   write=false bundles in memory (used by check-onprem --source).
 * @returns {Promise<{ outDir: string, result: import('esbuild').BuildResult, excluded: {from: string, importer: string}[] }>}
 */
export async function bundleServer({ edition, write = true }) {
  if (!EDITIONS.includes(edition)) throw new Error(`Unknown edition "${edition}" (expected ${EDITIONS.join(' | ')})`);
  if (!existsSync(ENTRY)) throw new EntryMissingError(ENTRY);

  const esbuild = await import('esbuild');
  const outDir = path.join(SERVER_DIR, `dist-${edition}`);
  const excluded = [];

  if (write) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
  }

  const result = await esbuild.build(esbuildOptions(edition, ENTRY, path.join(outDir, 'server.mjs'), write, excluded));

  if (write) {
    if (existsSync(MIGRATE_ENTRY)) {
      await esbuild.build(esbuildOptions(edition, MIGRATE_ENTRY, path.join(outDir, 'migrate.mjs'), true, excluded));
    }
    const migrationsDir = MIGRATION_DIRS.find((d) => existsSync(d));
    if (migrationsDir) cpSync(migrationsDir, path.join(outDir, 'migrations'), { recursive: true });
    writeRuntimePackageJson(outDir, edition);
  }

  return { outDir, result, excluded };
}

function writeRuntimePackageJson(outDir, edition) {
  const req = createRequire(path.join(SERVER_DIR, 'package.json'));
  const dependencies = {};
  for (const name of EXTERNAL_NATIVE) {
    try {
      dependencies[name] = req(`${name}/package.json`).version;
    } catch {
      // optional native module not installed (e.g. pg-native): leave it out
    }
  }
  const pkg = {
    name: `scg-shop-erp-server-${edition}`,
    private: true,
    type: 'module',
    main: 'server.mjs',
    scripts: { start: 'node server.mjs' },
    dependencies,
  };
  writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

/** CLI wrapper shared by build.cloud.mjs / build.onprem.mjs. */
export async function runCli(edition) {
  try {
    const { outDir, result, excluded } = await bundleServer({ edition });
    const out = Object.entries(result.metafile.outputs).filter(([f]) => f.endsWith('.mjs'));
    for (const [file, meta] of out) {
      console.log(`  ${path.relative(REPO_ROOT, path.resolve(process.cwd(), file))}  ${(meta.bytes / 1024).toFixed(1)} KiB`);
    }
    if (excluded.length > 0) {
      console.log(`  replaced ${excluded.length} cloud-only import(s) with empty stubs:`);
      for (const e of excluded) console.log(`    ${e.from}  (from ${e.importer})`);
    }
    console.log(`[bundle:${edition}] done -> ${path.relative(REPO_ROOT, outDir)}`);
  } catch (err) {
    if (err instanceof EntryMissingError) {
      console.error(`[bundle:${edition}] ${err.message}`);
      process.exit(1);
    }
    // esbuild already printed its diagnostics for build failures
    console.error(`[bundle:${edition}] failed: ${err.message.split('\n')[0]}`);
    process.exit(1);
  }
}
