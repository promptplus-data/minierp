/** Shared helpers for the admin module tests. */
import { readFileSync } from 'node:fs';
import { createPrivateKey, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Pool } from '@erp/db';
import type { LicensePayload } from '@erp/contracts';
import { buildApp } from '../../src/app';
import { signLicense } from '../../src/modules/admin/license';
import { client, TODAY, type Client } from '../helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Development keypair (its public half is embedded in license-pubkey.ts); never the production key. */
export const DEV_PRIVATE_PEM = readFileSync(path.join(here, 'fixtures/license-dev-private.pem'), 'utf8');
export const devKey = () => createPrivateKey(DEV_PRIVATE_PEM);

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
