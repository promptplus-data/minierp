/**
 * Passphrase-encrypted container for shop exports (M19-07) and cloud backups (M19-09):
 * gzip(JSON) encrypted with AES-256-GCM; the key is scrypt(passphrase, salt). The header (kind, meta, kdf, iv) is
 * the GCM additional data, so any change to the header or the ciphertext fails authentication on open.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { E } from '../../lib/errors';

export const BOX_FORMAT = 'scg-erp-box' as const;
const KDF = { alg: 'scrypt', N: 16384, r: 8, p: 1 } as const;

export interface BoxMeta { shopName: string; taxId: string; createdAt: string; [k: string]: unknown }
export interface BoxKey { key: Buffer; salt: string }

interface BoxFile {
  format: typeof BOX_FORMAT; v: 1; kind: string; meta: BoxMeta;
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; salt: string };
  iv: string; tag: string; data: string;
}

export function deriveKey(passphrase: string, salt: string = randomBytes(16).toString('base64')): BoxKey {
  const key = scryptSync(passphrase.normalize('NFC'), Buffer.from(salt, 'base64'), 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
  return { key, salt };
}

const aad = (f: Pick<BoxFile, 'format' | 'v' | 'kind' | 'meta' | 'kdf' | 'iv'>) =>
  Buffer.from(JSON.stringify([f.format, f.v, f.kind, f.meta, f.kdf, f.iv]));

export function sealBox(kind: string, meta: BoxMeta, payload: unknown, k: BoxKey): string {
  const iv = randomBytes(12);
  const head = { format: BOX_FORMAT, v: 1 as const, kind, meta, kdf: { ...KDF, salt: k.salt }, iv: iv.toString('base64') };
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  c.setAAD(aad(head));
  const data = Buffer.concat([c.update(gzipSync(Buffer.from(JSON.stringify(payload)))), c.final()]);
  const file: BoxFile = { ...head, tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  return JSON.stringify(file);
}

/** Header only (no passphrase needed): what the file is and which shop it came from. */
export function peekBox(text: string): { kind: string; meta: BoxMeta; salt: string } {
  const f = parse(text);
  return { kind: f.kind, meta: f.meta, salt: f.kdf.salt };
}

export function openBox<T = unknown>(text: string, passphraseOrKey: string | Buffer, expectKind?: string): { kind: string; meta: BoxMeta; payload: T } {
  const f = parse(text);
  if (expectKind && f.kind !== expectKind) throw E.validation(`This file is a ${f.kind}, not a ${expectKind}`, { reason: 'BOX_KIND' });
  const key = typeof passphraseOrKey === 'string' ? deriveKey(passphraseOrKey, f.kdf.salt).key : passphraseOrKey;
  let plain: Buffer;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
    d.setAAD(aad(f));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    plain = gunzipSync(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]));
  } catch {
    throw E.validation('Wrong passphrase or the file was modified', { reason: 'BOX_DECRYPT' });
  }
  return { kind: f.kind, meta: f.meta, payload: JSON.parse(plain.toString('utf8')) as T };
}

function parse(text: string): BoxFile {
  let f: BoxFile;
  try {
    f = JSON.parse(text) as BoxFile;
  } catch {
    throw E.validation('Not an SCG Shop ERP file', { reason: 'BOX_FORMAT' });
  }
  if (f?.format !== BOX_FORMAT || f.v !== 1 || f.kdf?.alg !== 'scrypt' || typeof f.data !== 'string') {
    throw E.validation('Not an SCG Shop ERP file', { reason: 'BOX_FORMAT' });
  }
  if (f.kdf.N !== KDF.N || f.kdf.r !== KDF.r || f.kdf.p !== KDF.p) throw E.validation('Unsupported key derivation parameters', { reason: 'BOX_FORMAT' });
  return f;
}
