/**
 * M19-09 encrypted backup and restore on a new machine. The on-prem edition keeps its data in the shop: it has no
 * export-to-cloud and no sales summary to SCG.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetData, withTenant } from '@erp/db';
import { seedAdmin } from '@erp/db/src/seedAdmin';
import { buildApp } from '../../src/app';
import { S3Client, signV4 } from '../../src/modules/admin/s3';
import { client, login, openShift, saleBody, setupEnv, TODAY, type Client, type Env } from '../helpers';
import { DEV_PRIVATE_PEM } from './util';

let env: Env;
let owner: Client;
let suda: Client;
let s3: Server;
let s3url: string;
const bucket = new Map<string, Buffer>();
const SECRET = 'test-secret-key';

/** Fake S3 (path style): checks every request's SigV4 signature, stores objects in memory. */
function fakeS3(): Promise<void> {
  s3 = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      const auth = String(req.headers.authorization ?? '');
      const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(';') ?? [];
      const query = Object.fromEntries(u.searchParams.entries());
      const want = signV4({
        method: req.method!, host: String(req.headers.host), path: decodeURIComponent(u.pathname), query,
        headers: Object.fromEntries(signed.filter((h) => !['host', 'x-amz-content-sha256', 'x-amz-date'].includes(h)).map((h) => [h, String(req.headers[h])])),
        payloadHash: String(req.headers['x-amz-content-sha256']), region: 'ap-southeast-1', accessKeyId: 'AKIDTEST', secretAccessKey: SECRET, amzDate: String(req.headers['x-amz-date']),
      });
      if (auth !== want.authorization) { res.statusCode = 403; res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); return; }
      const key = decodeURIComponent(u.pathname).replace(/^\/shop-bucket\//, '');
      if (req.method === 'PUT') { bucket.set(key, Buffer.concat(chunks)); res.end(); return; }
      if (req.method === 'GET' && query['list-type'] === '2') {
        const items = [...bucket.entries()].filter(([k]) => k.startsWith(query.prefix ?? ''));
        res.end(`<ListBucketResult>${items.map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>2026-10-26T01:00:00.000Z</LastModified><Size>${v.length}</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
        return;
      }
      const obj = bucket.get(key);
      if (!obj) { res.statusCode = 404; res.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      res.end(obj);
    });
  });
  return new Promise((r) => s3.listen(0, '127.0.0.1', () => { s3url = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`; r(); }));
}
const s3Settings = () => ({ endpoint: s3url, region: 'ap-southeast-1', bucket: 'shop-bucket', prefix: 'scg-erp/', accessKeyId: 'AKIDTEST', secretAccessKey: SECRET, forcePathStyle: true });

beforeAll(async () => {
  env = await setupEnv();
  await seedAdmin(env.pool, env.seed.tenantId);
  process.env.LICENSE_SIGNING_KEY = DEV_PRIVATE_PEM;
  owner = await login(env.app, 'charoen');
  suda = await login(env.app, 'suda');
  // some activity: a sale (stock lots consumed FIFO, doc counter moves, audit rows)
  const prae = await login(env.app, 'prae');
  const shift = await openShift(prae);
  await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty: '45', price: '145.00' }, { p: 'p5', qty: '3', price: '165.00' }], '7020.00'));
  await fakeS3();
});
afterAll(async () => {
  delete process.env.LICENSE_SIGNING_KEY;
  s3.close();
  await env.close();
});

describe('S3 SigV4', () => {
  it('matches the AWS documented example (GET object with Range)', () => {
    const r = signV4({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', amzDate: '20130524T000000Z',
    });
    expect(r.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
  it('round-trips through a signature-checking store and fails cleanly with a wrong secret', async () => {
    const c = new S3Client(s3Settings());
    await c.put('probe.txt', Buffer.from('สวัสดี'));
    expect((await c.get('probe.txt')).toString()).toBe('สวัสดี');
    expect((await c.list()).map((o) => o.name)).toContain('probe.txt');
    await expect(new S3Client({ ...s3Settings(), secretAccessKey: 'nope' }).get('probe.txt')).rejects.toThrow(/403 SignatureDoesNotMatch/);
    bucket.clear();
  });
});

describe('the on-prem edition keeps its data in the shop', () => {
  it('has no export-to-cloud and no sales summary to SCG', async () => {
    const auth = { authorization: await ownerAuth() };
    expect((await env.app.inject({ method: 'POST', url: '/api/system/export', payload: { passphrase: 'correct horse' }, headers: auth })).statusCode).toBe(404);
    expect((await env.app.inject({ method: 'GET', url: '/api/share/config', headers: auth })).statusCode).toBe(404);
  });
});

describe('M19-09 optional cloud backup (S3), encrypted before upload', () => {
  it('is off by default and owner-only', async () => {
    expect((await owner.get('/api/backup/config')).body).toMatchObject({ enabled: false, provider: null, hasPassphrase: false, lastSuccessAt: null });
    expect((await suda.get('/api/backup/config')).status).toBe(403);
    expect((await owner.post('/api/backup/config', { enabled: true, provider: 's3', s3: s3Settings() })).body.details.reason).toBe('BACKUP_INCOMPLETE');
  });

  it('Drive / OneDrive are marked as not available yet', async () => {
    expect((await owner.post('/api/backup/oauth/start', { provider: 'gdrive' })).body.details.reason).toBe('OAUTH_NOT_CONFIGURED');
    expect((await owner.post('/api/backup/config', { enabled: true, provider: 'onedrive', passphrase: 'shop-secret-1' })).body.details.reason).toBe('OAUTH_NOT_CONNECTED');
  });

  it('saves settings without returning secrets, backs up an encrypted file, shows last status and records failures', async () => {
    const r = await owner.post('/api/backup/config', { enabled: true, provider: 's3', s3: s3Settings(), passphrase: 'shop-secret-1' });
    expect(r.body).toMatchObject({ enabled: true, provider: 's3', hasPassphrase: true, s3: { bucket: 'shop-bucket', hasSecret: true } });
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    const cfg = await env.pool.query(`select settings, derived_key from backup_config where tenant_id = $1`, [env.seed.tenantId]);
    expect(JSON.stringify(cfg.rows[0])).not.toContain('shop-secret-1');
    const run = await owner.post('/api/backup/run', {});
    expect(run.body).toMatchObject({ status: 'ok', provider: 's3', trigger: 'manual' });
    const stored = bucket.get(`scg-erp/${run.body.fileName}`)!;
    expect(stored.toString()).not.toContain('น้องแพร');
    expect((await owner.get('/api/backup/config')).body.lastFile).toBe(run.body.fileName);
    expect((await owner.get('/api/backup/files')).body.items.map((f: { name: string }) => f.name)).toEqual([run.body.fileName]);
    // a destination error does not fail the request: it is recorded and shown
    await owner.post('/api/backup/config', { enabled: true, provider: 's3', s3: { ...s3Settings(), secretAccessKey: 'wrong' } });
    const bad = await owner.post('/api/backup/run', {});
    expect(bad.body).toMatchObject({ status: 'failed', error: expect.stringContaining('403') });
    const st = (await owner.get('/api/backup/config')).body;
    expect(st.lastError).toContain('403');
    expect(st.lastSuccessAt).not.toBeNull();
    expect((await owner.get('/api/backup/runs')).body.items.map((x: { status: string }) => x.status)).toEqual(['failed', 'ok']);
    await owner.post('/api/backup/config', { enabled: true, provider: 's3', s3: s3Settings() });
  });

  it('Google Drive: device-flow sign-in (RFC 8628) keeps the device code and refresh token server-side; uploads are stubs', async () => {
    let polls = 0;
    const seen: Record<string, string>[] = [];
    const idp = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        const f = Object.fromEntries(new URLSearchParams(body));
        seen.push(f);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/device') {
          res.end(JSON.stringify({ device_code: 'DEV-SECRET-123', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 }));
          return;
        }
        polls++;
        if (f.device_code !== 'DEV-SECRET-123' || f.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
        if (polls === 1) { res.statusCode = 428; res.end(JSON.stringify({ error: 'authorization_pending' })); return; }
        res.end(JSON.stringify({ access_token: 'at-1', refresh_token: 'RT-SECRET-456', expires_in: 3600 }));
      });
    });
    await new Promise<void>((r) => idp.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    Object.assign(process.env, { BACKUP_GDRIVE_CLIENT_ID: 'cid.apps', BACKUP_GDRIVE_CLIENT_SECRET: 'csecret', BACKUP_GDRIVE_DEVICE_URL: `${base}/device`, BACKUP_GDRIVE_TOKEN_URL: `${base}/token` });
    try {
      expect((await suda.post('/api/backup/oauth/start', { provider: 'gdrive' })).status).toBe(403);
      expect((await owner.get('/api/backup/config')).body.oauthClientConfigured).toEqual({ gdrive: true, onedrive: false });
      const st = await owner.post('/api/backup/oauth/start', { provider: 'gdrive' });
      expect(st.body).toEqual({ userCode: 'ABCD-EFGH', verificationUrl: 'https://www.google.com/device', expiresIn: 1800, interval: 5 });
      expect(seen[0]).toMatchObject({ client_id: 'cid.apps', scope: 'https://www.googleapis.com/auth/drive.file' });
      expect((await owner.post('/api/backup/oauth/poll', { provider: 'gdrive' })).body).toEqual({ status: 'pending' });
      expect((await owner.post('/api/backup/oauth/poll', { provider: 'gdrive' })).body).toEqual({ status: 'connected' });
      expect(seen[2]).toMatchObject({ client_secret: 'csecret' });
      const cfg = await owner.post('/api/backup/config', { enabled: true, provider: 'gdrive', passphrase: 'shop-secret-1' });
      expect(cfg.body).toMatchObject({ enabled: true, provider: 'gdrive', oauth: { connected: true } });
      const text = JSON.stringify(cfg.body);
      expect(text).not.toContain('RT-SECRET-456');
      expect(text).not.toContain('DEV-SECRET-123');
      // the upload adapter is a stub: the run is recorded as failed with a clear message, nothing pretends to succeed
      const run = await owner.post('/api/backup/run', {});
      expect(run.body).toMatchObject({ status: 'failed', provider: 'gdrive', error: expect.stringContaining('not implemented yet') });
      // OneDrive without a registered app stays "not configured"
      expect((await owner.post('/api/backup/oauth/start', { provider: 'onedrive' })).body.details.reason).toBe('OAUTH_NOT_CONFIGURED');
    } finally {
      for (const k of ['BACKUP_GDRIVE_CLIENT_ID', 'BACKUP_GDRIVE_CLIENT_SECRET', 'BACKUP_GDRIVE_DEVICE_URL', 'BACKUP_GDRIVE_TOKEN_URL']) delete process.env[k];
      idp.close();
      await owner.post('/api/backup/config', { enabled: true, provider: 's3', s3: s3Settings(), passphrase: 'shop-secret-1' });
    }
  });
});

describe('M19-09 restore on a new machine', () => {
  it('only while the machine has no shop; decrypts with the passphrase and restores everything', async () => {
    const files = await owner.get('/api/backup/files');
    const name = files.body.items[0].name as string;
    const target = { provider: 's3', s3: s3Settings() };
    expect((await client(env.app).post('/api/backup/restore/files', target)).body.details.reason).toBe('NOT_EMPTY');
    const before = (await env.pool.query(`select count(*)::int n from docs where tenant_id = $1`, [env.seed.tenantId])).rows[0].n;
    await resetData(env.pool); // the "new machine"
    const app = await buildApp({ pool: env.pool, edition: 'onprem', jwtSecret: 'test-secret', today: () => TODAY });
    try {
      const list = await client(app).post('/api/backup/restore/files', target);
      expect(list.body.items.map((f: { name: string }) => f.name)).toContain(name);
      expect((await client(app).post('/api/backup/restore', { ...target, file: name, passphrase: 'not-the-one' })).body.details.reason).toBe('BOX_DECRYPT');
      const r = await client(app).post('/api/backup/restore', { ...target, file: name, passphrase: 'shop-secret-1' });
      expect(r.status).toBe(201);
      expect(r.body.verified.auditChainOk).toBe(true);
      const t = await withTenant(env.pool, null, (tx) => tx.query<{ id: string }>(`select id from tenants`), { authLookup: true });
      expect((await env.pool.query(`select count(*)::int n from docs where tenant_id = $1`, [t.rows[0]!.id])).rows[0].n).toBe(before);
      const o = await login(app, 'charoen');
      expect((await o.get('/api/backup/config')).body).toMatchObject({ provider: 's3', enabled: false, hasPassphrase: false });
      expect((await client(app).post('/api/backup/restore/files', target)).body.details.reason).toBe('NOT_EMPTY');
    } finally {
      await app.close();
    }
  });
});

/** helpers' client parses JSON bodies; the export needs the raw response, so sign in again for a bearer header. */
async function ownerAuth(): Promise<string> {
  const lg = await client(env.app).post('/api/auth/login', { username: 'charoen', password: '1234' });
  return `Bearer ${lg.body.token}`;
}
