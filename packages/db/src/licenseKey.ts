/**
 * License key encoding (REQ-M19-11), shared by the server and the deploy bootstrap:
 * `SCG1.<base64url(JSON payload)>.<base64url(Ed25519 signature over "SCG1.<payload>")>`.
 * Validation of the payload shape lives with the server (apps/server/src/modules/admin/license.ts).
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

export const LICENSE_KEY_PREFIX = 'SCG1';

export function encodeLicenseKey(payload: object, privateKey: KeyObject): string {
  const body = `${LICENSE_KEY_PREFIX}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
}

/** LICENSE_SIGNING_KEY: the Ed25519 private key as PKCS#8 PEM, or that PEM base64-encoded (cloud only). */
export function signingKeyFrom(raw: string | undefined): KeyObject | null {
  const v = raw?.trim();
  if (!v) return null;
  return createPrivateKey(v.includes('BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8'));
}
