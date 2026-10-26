#!/usr/bin/env node
// Guard: the on-premise edition must not contain Prompt Plus order/delivery code,
// URLs, credentials or PROMPTPLUS_* env names.
//
// Usage
//   node scripts/check-onprem.mjs <dir> [<dir> ...] [--pattern <regex>]...
//       Bundle mode. Recursively scans a built on-prem payload (for example
//       apps/server/dist-onprem, apps/web/dist-onprem, or the staged installer
//       payload). Fails if any file PATH or any file CONTENT matches a forbidden
//       pattern. Every file is scanned, including sourcemaps and node_modules.
//
//   node scripts/check-onprem.mjs --source [--pattern <regex>]...
//       Source mode. Bundles apps/server/src/main.ts in memory exactly like
//       build.onprem.mjs does (EDITION=onprem define + cloud-only import stubbing),
//       then fails if any module in the resulting import graph has a forbidden
//       path, or if the emitted code contains a forbidden string (for example an
//       unguarded `registerPromptPlus()` call outside an EDITION === 'cloud' branch).
//       If main.ts does not exist yet, prints a notice and exits 0.
//
// Extra --pattern values (JS regex source, case-insensitive) let CI add hostnames
// of the Prompt Plus API once they are known, e.g. --pattern 'api\.promptplus\.example'.
//
// Exit codes: 0 clean, 1 forbidden content found, 2 usage error or analysis failed.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** /promptplus/i also covers PROMPTPLUS_* env names; listed separately for clearer reports. */
const BASE_PATTERNS = [
  { name: 'Prompt Plus module/identifier', re: /promptplus/i },
  { name: 'Prompt Plus env var', re: /PROMPTPLUS_[A-Z0-9_]*/ },
  { name: 'Prompt Plus (spaced/dashed)', re: /prompt[\s_-]plus/i },
];

function parseArgs(argv) {
  const opts = { source: false, dirs: [], patterns: [...BASE_PATTERNS] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') opts.source = true;
    else if (a === '--pattern') {
      const src = argv[++i];
      if (!src) usage('--pattern needs a value');
      opts.patterns.push({ name: `custom /${src}/i`, re: new RegExp(src, 'i') });
    } else if (a === '-h' || a === '--help') usage();
    else if (a.startsWith('-')) usage(`unknown option ${a}`);
    else opts.dirs.push(a);
  }
  if (!opts.source && opts.dirs.length === 0) usage('give a bundle directory or --source');
  return opts;
}

function usage(msg) {
  if (msg) console.error(`check-onprem: ${msg}`);
  console.error('usage: node scripts/check-onprem.mjs <dir>... | --source  [--pattern <regex>]...');
  process.exit(2);
}

/** Returns [{ line, pattern, excerpt }] for every match in text (first 5 per pattern). */
function findInText(text, patterns) {
  const hits = [];
  for (const { name, re } of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    let count = 0;
    while ((m = g.exec(text)) !== null && count < 5) {
      count++;
      const line = text.slice(0, m.index).split('\n').length;
      const start = Math.max(0, m.index - 40);
      const excerpt = text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ');
      hits.push({ line, pattern: name, excerpt });
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  return hits;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() || entry.isSymbolicLink()) yield full;
  }
}

function scanBundleDirs(dirs, patterns) {
  const violations = [];
  let files = 0;
  for (const dir of dirs) {
    const abs = path.resolve(dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      console.error(`check-onprem: not a directory: ${dir}`);
      process.exit(2);
    }
    for (const file of walk(abs)) {
      files++;
      const rel = path.relative(process.cwd(), file);
      if (patterns.some(({ re }) => re.test(path.relative(abs, file)))) {
        violations.push(`${rel}: forbidden file path`);
      }
      let text;
      try {
        // latin1 keeps byte offsets 1:1 so ASCII needles are found in binaries too
        text = readFileSync(file).toString('latin1');
      } catch (e) {
        violations.push(`${rel}: unreadable (${e.code ?? e.message})`);
        continue;
      }
      for (const h of findInText(text, patterns)) {
        violations.push(`${rel}:${h.line}: ${h.pattern}: …${h.excerpt}…`);
      }
    }
  }
  return { violations, files };
}

async function scanSource(patterns) {
  const lib = path.join(REPO_ROOT, 'apps/server/build.lib.mjs');
  const { bundleServer, EntryMissingError, ENTRY } = await import(lib);
  let bundled;
  try {
    bundled = await bundleServer({ edition: 'onprem', write: false });
  } catch (err) {
    if (err instanceof EntryMissingError) {
      const srcDir = path.dirname(ENTRY);
      const present = existsSync(srcDir) ? [...walk(srcDir)].map((f) => path.relative(REPO_ROOT, f)) : [];
      console.log(`check-onprem --source: ${err.message.split('\n')[0]}`);
      console.log(`  apps/server/src currently has ${present.length} file(s); nothing to trace yet. Treating as clean.`);
      const cloudOnly = present.filter((f) => /promptplus/i.test(f));
      if (cloudOnly.length) console.log(`  cloud-only files present (will be stubbed for onprem): ${cloudOnly.join(', ')}`);
      return { violations: [], files: 0, skipped: true };
    }
    console.error(`check-onprem --source: could not bundle the onprem graph: ${err.message}`);
    process.exit(2);
  }

  const { result, excluded } = bundled;
  const violations = [];
  const inputs = Object.keys(result.metafile.inputs);
  for (const input of inputs) {
    if (input.startsWith('edition-excluded:')) continue;
    if (patterns.some(({ re }) => re.test(input))) violations.push(`${input}: forbidden module in onprem import graph`);
  }
  for (const out of result.outputFiles ?? []) {
    for (const h of findInText(out.text, patterns)) {
      violations.push(`<onprem bundle>:${h.line}: ${h.pattern}: …${h.excerpt}…`);
    }
  }
  if (excluded.length) {
    console.log(`check-onprem --source: ${excluded.length} cloud-only import(s) stubbed:`);
    for (const e of excluded) console.log(`  ${e.from}  (imported by ${e.importer || '?'})`);
  }
  return { violations, files: inputs.length };
}

const opts = parseArgs(process.argv.slice(2));
const report = opts.source ? await scanSource(opts.patterns) : scanBundleDirs(opts.dirs, opts.patterns);

if (report.violations.length > 0) {
  console.error(`check-onprem: FAILED, ${report.violations.length} forbidden match(es):`);
  for (const v of report.violations) console.error(`  ${v}`);
  console.error('Cloud-only (Prompt Plus) code must live in packages/adapters/promptplus* or files named');
  console.error("*promptplus*, and every call site must sit inside `if (process.env.EDITION === 'cloud')`.");
  process.exit(1);
}
if (!report.skipped) {
  console.log(`check-onprem: OK (${report.files} ${opts.source ? 'modules in onprem graph' : 'files'} scanned, no Prompt Plus references)`);
}
