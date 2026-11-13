/** Shared helpers for the admin module tests. */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '@erp/db';
import type { LicensePayload } from '@erp/contracts';
import { buildApp } from '../../src/app';
import { signLicense } from '../../src/modules/admin/license';
import { client, TODAY, type Client } from '../helpers';

/** Throw-away keypair for this test process; the verifier is pointed at its public half (never the production key). */
const pair = generateKeyPairSync('ed25519');
export const DEV_PRIVATE_PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const devKey = () => pair.privateKey;
process.env.ERP_LICENSE_TEST_PUBKEY = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
// Cloud requires a key once a signing key is configured; the existing suites test shops without one, so opt out here.
// license-cloud.test.ts covers the required path.
process.env.LICENSE_REQUIRED ??= '0';

export function makeKey(p: Partial<LicensePayload> & { shopName: string; taxId: string }): string {
  return signLicense({
    v: 1, licenseId: `LIC-T-${randomBytes(3).toString('hex')}`, edition: 'onprem', type: 'lifetime', expiresAt: null, issuedAt: new Date().toISOString(), ...p,
  }, devKey());
}

/** Cloud app: EDITION is what the bundler bakes in, so cloud-only routes register only while it is 'cloud'. */
export async function buildCloud(pool: Pool, today: () => string = () => TODAY): Promise<FastifyInstance> {
  const prev = process.env.EDITION;
  process.env.EDITION = 'cloud';
  try {
    return await buildApp({ pool, edition: 'cloud', jwtSecret: 'test-secret', today });
  } finally {
    if (prev === undefined) delete process.env.EDITION;
    else process.env.EDITION = prev;
  }
}

export async function admLogin(app: FastifyInstance, username = 'scg.admin', password = '1234'): Promise<Client> {
  const r = await client(app).post('/api/adm/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`adm login failed: ${JSON.stringify(r.body)}`);
  return client(app, r.body.token);
}
