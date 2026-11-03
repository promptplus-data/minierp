#!/usr/bin/env node
// SCG team CLI for on-prem license keys (REQ-M19-11, OQ-A8). Same format the server verifies offline:
//   SCG1.<base64url(JSON payload)>.<base64url(Ed25519 signature over "SCG1.<payload>")>
//
// Issue a key (private key from LICENSE_SIGNING_KEY = PKCS#8 PEM or base64 of it, or --key-file):
//   node scripts/license-gen.mjs --shop "ร้านวัสดุเจริญชัย" --tax 0505561004321 --expires 2027-12-31
//   node scripts/license-gen.mjs --shop "ร้านวัสดุเจริญชัย" --tax 0505561004321 --lifetime --key-file ~/secure/scg-license.pem
// Create a new production keypair (private key written OUTSIDE the repository; public key printed for
// apps/server/src/modules/admin/license-pubkey.ts):
//   node scripts/license-gen.mjs --keygen --out ~/secure/scg-license.pem
// Check a key against the public key embedded in the server:
//   node scripts/license-gen.mjs --verify SCG1....
//
// The private key is never read from or written into this repository (except the test-only dev key with --dev).
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBKEY_FILE = path.join(ROOT, 'apps/server/src/modules/admin/license-pubkey.ts');

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (['lifetime', 'keygen', 'dev', 'json', 'help'].includes(k)) o[k] = true;
    else {
      const v = argv[++i];
      if (v === undefined) fail(`--${k} needs a value`);
      o[k] = v;
    }
  }
  return o;
}

function fail(msg) {
  console.error(`license-gen: ${msg}\nRun with --help for usage.`);
  process.exit(2);
}

const expand = (p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
const insideRepo = (p) => !path.relative(ROOT, p).startsWith('..') && !path.isAbsolute(path.relative(ROOT, p));

function privateKey(o) {
  if (o['key-file']) {
    const p = expand(o['key-file']);
    if (insideRepo(p) && !o.dev) fail(`refusing to use a private key inside the repository (${p}); keep it outside, or pass --dev for the test key`);
    return createPrivateKey(readFileSync(p, 'utf8'));
  }
  const raw = process.env.LICENSE_SIGNING_KEY?.trim();
  if (!raw) fail('no private key: set LICENSE_SIGNING_KEY or pass --key-file');
  return createPrivateKey(raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
}

function embeddedPublicKey() {
  const src = readFileSync(PUBKEY_FILE, 'utf8');
  const b64 = /LICENSE_PUBLIC_KEY_SPKI_B64\s*=\s*'([^']+)'/.exec(src)?.[1];
  if (!b64) fail(`cannot find LICENSE_PUBLIC_KEY_SPKI_B64 in ${PUBKEY_FILE}`);
  return createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
}

function parse(key, pub) {
  const parts = key.trim().replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== 'SCG1') throw new Error('not an SCG1 key');
  const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pub, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('signature does not match the embedded public key');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

const o = args(process.argv.slice(2));
if (o.help || process.argv.length <= 2) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

if (o.keygen) {
  if (!o.out) fail('--keygen needs --out <file outside the repository>');
  const out = expand(o.out);
  if (insideRepo(out)) fail(`refusing to write a private key inside the repository (${out})`);
  if (existsSync(out)) fail(`${out} exists; not overwriting`);
  const { privateKey: priv, publicKey: pub } = generateKeyPairSync('ed25519');
  writeFileSync(out, priv.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(`private key written to ${out} (mode 600). Store it in the cloud secret store as LICENSE_SIGNING_KEY.`);
  console.log(`public key for license-pubkey.ts (LICENSE_PUBLIC_KEY_SPKI_B64):\n${pub.export({ type: 'spki', format: 'der' }).toString('base64')}`);
  process.exit(0);
}

if (o.verify) {
  try {
    const p = parse(o.verify, embeddedPublicKey());
    console.log(JSON.stringify(p, null, 2));
    if (p.expiresAt) {
      const days = Math.round((Date.parse(`${p.expiresAt}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86400000);
      console.log(days < 0 ? `EXPIRED ${-days} day(s) ago` : `valid, ${days} day(s) left`);
    } else console.log('valid, lifetime');
  } catch (err) {
    console.error(`INVALID: ${err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const shop = o.shop?.normalize('NFC').replace(/\s+/g, ' ').trim();
const tax = o.tax?.replace(/\D/g, '');
if (!shop) fail('--shop "<shop name exactly as set up in the shop>" is required');
if (!/^\d{13}$/.test(tax ?? '')) fail('--tax must be the 13-digit tax id');
if (!!o.lifetime === !!o.expires) fail('give exactly one of --expires YYYY-MM-DD or --lifetime');
if (o.expires && (!/^\d{4}-\d{2}-\d{2}$/.test(o.expires) || Number.isNaN(Date.parse(o.expires)))) fail('--expires must be YYYY-MM-DD');
if (o.expires && o.expires <= new Date().toISOString().slice(0, 10)) fail('--expires must be in the future');
const edition = o.edition ?? 'onprem';
if (!['onprem', 'cloud'].includes(edition)) fail('--edition is onprem or cloud');

const now = new Date();
const payload = {
  v: 1, licenseId: o.id ?? `LIC-${now.toISOString().slice(0, 7).replace('-', '')}-${randomBytes(4).toString('hex').toUpperCase()}`,
  shopName: shop, taxId: tax, edition, type: o.lifetime ? 'lifetime' : 'expiring', expiresAt: o.lifetime ? null : o.expires, issuedAt: now.toISOString(),
};
const body = `SCG1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
const key = `${body}.${sign(null, Buffer.from(body), privateKey(o)).toString('base64url')}`;
// Self-check: the key must verify with the public key the server embeds, or the shop will reject it.
try {
  parse(key, embeddedPublicKey());
} catch {
  console.error('warning: this key does NOT verify with the public key embedded in license-pubkey.ts (different keypair)');
}
if (o.json) console.log(JSON.stringify({ ...payload, key }, null, 2));
else console.log(key);
