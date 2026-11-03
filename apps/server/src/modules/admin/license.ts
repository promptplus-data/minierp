/**
 * REQ-M19-11 license keys. Format: `SCG1.<base64url(JSON payload)>.<base64url(Ed25519 signature over "SCG1.<payload>")>`.
 * The payload binds shop name + tax id + edition + type + expiresAt|null + issuedAt + licenseId. SCG Admin (cloud)
 * signs with LICENSE_SIGNING_KEY; the on-prem server verifies offline with the embedded public key.
 * After expiry the shop is read-only: licenseGuard() refuses every mutating authed request (one central place).
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { Tx } from '@erp/db';
import { LicensePayload, type LicenseStatus } from '@erp/contracts';
import { writeAudit } from '../../lib/audit';
import type { Ctx, Deps, TenantGuard } from '../../lib/context';
import { E } from '../../lib/errors';
import { LICENSE_PUBLIC_KEY_SPKI_B64 } from './license-pubkey';

export const KEY_PREFIX = 'SCG1';
export const WARN_DAYS = 30;

const pubCache = new Map<string, KeyObject>();
export function embeddedPublicKey(): KeyObject {
  const test = process.env.NODE_ENV !== 'production' ? process.env.ERP_LICENSE_TEST_PUBKEY : undefined;
  const b64 = test || LICENSE_PUBLIC_KEY_SPKI_B64;
  let k = pubCache.get(b64);
  if (!k) pubCache.set(b64, (k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })));
  return k;
}

/** LICENSE_SIGNING_KEY: the Ed25519 private key as PKCS#8 PEM, or that PEM base64-encoded (cloud only). */
export function signingKeyFromEnv(env: NodeJS.ProcessEnv = process.env): KeyObject | null {
  const raw = env.LICENSE_SIGNING_KEY?.trim();
  if (!raw) return null;
  const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return createPrivateKey(pem);
}

export function signLicense(payload: LicensePayload, privateKey: KeyObject): string {
  const body = `${KEY_PREFIX}.${Buffer.from(JSON.stringify(LicensePayload.parse(payload))).toString('base64url')}`;
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
}

/** Verifies the signature and shape; throws VALIDATION with details.reason = LICENSE_INVALID. */
export function parseLicenseKey(key: string, publicKey: KeyObject = embeddedPublicKey()): LicensePayload {
  const bad = (why: string) => E.validation(`License key is not valid: ${why}`, { reason: 'LICENSE_INVALID' });
  const parts = key.trim().replace(/\s+/g, '').split('.');
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) throw bad('format');
  const body = `${parts[0]}.${parts[1]}`;
  let ok = false;
  try {
    ok = verify(null, Buffer.from(body), publicKey, Buffer.from(parts[2]!, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw bad('signature');
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw bad('payload');
  }
  const p = LicensePayload.safeParse(json);
  if (!p.success) throw bad('payload');
  if ((p.data.type === 'lifetime') !== (p.data.expiresAt === null)) throw bad('type');
  return p.data;
}

const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
export const sameShop = (a: { shopName: string; taxId: string }, b: { name: string; taxId: string }) =>
  a.taxId.replace(/\D/g, '') === b.taxId.replace(/\D/g, '') && norm(a.shopName) === norm(b.name);

export const licenseRequired = (env: NodeJS.ProcessEnv = process.env) => /^(1|true)$/i.test(env.LICENSE_REQUIRED ?? '');

/** Days from today until the expiry date (inclusive of the last valid day); negative after expiry. */
const daysUntil = (today: string, expiresAt: string): number =>
  Math.round((Date.parse(`${expiresAt}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);

export function licenseState(lic: LicensePayload | null, today: string, required = licenseRequired()): Omit<LicenseStatus, 'installedAt'> {
  if (!lic) return { state: 'none', readOnly: required, required, daysLeft: null, license: null };
  if (lic.expiresAt === null) return { state: 'valid', readOnly: false, required, daysLeft: null, license: lic };
  const left = daysUntil(today, lic.expiresAt);
  if (left < 0) return { state: 'expired', readOnly: true, required, daysLeft: left, license: lic };
  return { state: left <= WARN_DAYS ? 'expiring' : 'valid', readOnly: false, required, daysLeft: left, license: lic };
}

interface LicRow { license_key: string; installed_at: Date }
export async function currentLicense(tx: Tx): Promise<{ payload: LicensePayload; installedAt: string } | null> {
  const r = await tx.query<LicRow>(`select license_key, installed_at from licenses order by installed_at desc, id desc limit 1`);
  const row = r.rows[0];
  if (!row) return null;
  // Re-verify on every read: a key edited in the database stops counting.
  try {
    return { payload: parseLicenseKey(row.license_key), installedAt: row.installed_at.toISOString() };
  } catch {
    return null;
  }
}

export async function licenseStatus(tx: Tx, today: string): Promise<LicenseStatus> {
  const cur = await currentLicense(tx);
  return { ...licenseState(cur?.payload ?? null, today), installedAt: cur?.installedAt ?? null };
}

/** Installs (or replaces) the shop's key after checking signature, edition and that it names this shop. */
export async function installLicense(tx: Tx, ctx: Ctx, key: string, opts: { auditLast?: boolean } = {}): Promise<LicensePayload> {
  const p = parseLicenseKey(key);
  if (p.edition !== 'onprem') throw E.validation('This key is not for the on-premise edition', { reason: 'LICENSE_EDITION' });
  const shop = (await tx.query<{ name: string; tax_id: string }>(`select name, tax_id from tenants where id = $1`, [ctx.tenantId])).rows[0];
  if (!shop) throw E.notFound('Shop not found');
  if (!sameShop(p, { name: shop.name, taxId: shop.tax_id })) {
    throw E.validation('The key was issued for another shop name or tax id', { reason: 'LICENSE_SHOP_MISMATCH', key: { shopName: p.shopName, taxId: p.taxId } });
  }
  await tx.query(
    `insert into licenses (tenant_id, license_id, license_key, shop_name, tax_id, edition, key_type, expires_at, issued_at, installed_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ctx.tenantId, p.licenseId, key.trim().replace(/\s+/g, ''), p.shopName, p.taxId, p.edition, p.type, p.expiresAt, p.issuedAt, ctx.userId],
  );
  if (opts.auditLast !== false) {
    await writeAudit(tx, ctx, [{ action: 'update', object: 'license', ref: p.licenseId, detail: p.expiresAt ? `หมดอายุ ${p.expiresAt}` : 'ตลอดชีพ' }]);
  }
  return p;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * On-prem: after expiry (or with LICENSE_REQUIRED=1 and no key) every mutating authed request is refused, except
 * routes that declare `config: { readOnlyOk: true }` (license entry, export, backup, sales-summary share).
 * Viewing, printing and exporting keep working.
 */
export function licenseGuard(deps: Deps): TenantGuard {
  return async (tx, info) => {
    if (info.phase !== 'request' || READ_METHODS.has(info.method) || info.config.readOnlyOk === true) return;
    const st = licenseState((await currentLicense(tx))?.payload ?? null, deps.today());
    if (st.readOnly) {
      throw E.forbidden(
        st.state === 'none' ? 'A license key is required before creating documents' : 'The license has expired: the shop is read-only',
        { reason: 'LICENSE_READ_ONLY', state: st.state },
      );
    }
  };
}
