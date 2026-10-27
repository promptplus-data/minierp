/**
 * M19-07 whole-shop export (on-prem) → import into a new cloud shop (SCG Admin), M19-09 encrypted cloud backup and
 * restore on a new machine, M19-10 sales summary from on-prem to the SCG receiver.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetData, withTenant } from '@erp/db';
import { seedAdmin } from '@erp/db/src/seedAdmin';
import { buildApp } from '../../src/app';
import { S3Client, signV4 } from '../../src/modules/admin/s3';
import { transports } from '../../src/modules/admin/transports';
import { client, login, openShift, saleBody, setupEnv, TODAY, type Client, type Env } from '../helpers';
import { DEV_PRIVATE_PEM, admLogin, buildCloud } from './util';

let env: Env;
let cloud: FastifyInstance;
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
  cloud = await buildCloud(env.pool);
  owner = await login(env.app, 'charoen');
  suda = await login(env.app, 'suda'); // before the import duplicates the usernames into a second shop
  // some activity: a sale (stock lots consumed FIFO, doc counter moves, audit rows)
  const prae = await login(env.app, 'prae');
  const shift = await openShift(prae);
  await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty: '45', price: '145.00' }, { p: 'p5', qty: '3', price: '165.00' }], '7020.00'));
  await fakeS3();
});
afterAll(async () => {
  delete process.env.LICENSE_SIGNING_KEY;
  delete process.env.SCG_SHARE_URL;
  s3.close();
  await cloud.close();
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

describe('M19-07 export on-prem → import into a new cloud shop', () => {
  let file: string;
  it('owner-only export: one passphrase-encrypted file, no readable shop data inside', async () => {
    expect((await suda.post('/api/system/export', { passphrase: 'pass-phrase-1' })).status).toBe(403);
    const r = await env.app.inject({ method: 'POST', url: '/api/system/export', payload: { passphrase: 'correct horse' }, headers: { authorization: await ownerAuth() } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="charoen-\d{4}-\d{2}-\d{2}\.scgshop"/);
    file = r.body;
    expect(JSON.parse(file).format).toBe('scg-erp-box');
    expect(file).not.toContain('น้องแพร');
    expect(file).not.toContain('SCG-CEM-T50');
  });

  it('wrong passphrase or a modified file is refused; nothing is created', async () => {
    const scg = await admLogin(cloud);
    expect((await scg.post('/api/adm/tenants/import', { code: 'moved', passphrase: 'wrong-pass', file })).body.details.reason).toBe('BOX_DECRYPT');
    const f = JSON.parse(file);
    f.meta.shopName = 'อื่น';
    expect((await scg.post('/api/adm/tenants/import', { code: 'moved', passphrase: 'correct horse', file: JSON.stringify(f) })).body.details.reason).toBe('BOX_DECRYPT');
    const n = await env.pool.query(`select count(*)::int n from tenants where code = 'moved'`);
    expect(n.rows[0].n).toBe(0);
  });

  it('imports with stock lots, balances, doc counters and the audit log matching 100%', async () => {
    const scg = await admLogin(cloud);
    const r = await scg.post('/api/adm/tenants/import', { code: 'moved', region: 'ภาคกลาง', passphrase: 'correct horse', file });
    expect(r.status).toBe(201);
    expect(r.body.verified).toMatchObject({ auditChainOk: true });
    expect(r.body.verified.numericColumns).toBeGreaterThan(20);
    const src = env.seed.tenantId;
    const dst = r.body.tenant.id as string;
    const q = async (sql: string, t: string) => (await env.pool.query(sql, [t])).rows;
    const lots = `select p.sku, l.received_at, l.qty_in::text, l.remaining::text, l.unit_cost::text, l.ref from stock_lots l join products p on p.id = l.product_id where l.tenant_id = $1 order by 1,2,4`;
    const l1 = await q(lots, src);
    const l2 = await q(lots, dst);
    expect(l2).toEqual(l1);
    const ctr = `select type, period, device, seq from doc_counters where tenant_id = $1 order by 1,2,3`;
    expect(await q(ctr, dst)).toEqual(await q(ctr, src));
    const ar = `select coalesce(sum(ar_balance),0)::text s, count(*)::int n from docs where tenant_id = $1`;
    expect(await q(ar, dst)).toEqual(await q(ar, src));
    const audit = `select at, user_name, action, object, ref, detail from audit_log where tenant_id = $1 order by chain_seq`;
    const a1 = await q(audit, src);
    const a2 = await q(audit, dst);
    // the file is a snapshot: every source entry up to the export is replayed with its original time and author
    expect(a2.slice(0, -1)).toEqual(a1.slice(0, a2.length - 1));
    expect(a1[a2.length - 1]).toMatchObject({ action: 'export' });
    expect(a2.at(-1)).toMatchObject({ action: 'import', ref: 'moved' });
    // employees keep their user links; staff sign in to the new shop with their old passwords (shop code picks the tenant)
    const lg = await client(cloud).post('/api/auth/login', { username: 'prae', password: '1234', tenant: 'moved' });
    expect(lg.status).toBe(200);
    const e = await q(`select e.code, u.username from employees e left join users u on u.id = e.user_id where e.tenant_id = $1 order by 1`, dst);
    expect(e.find((x) => x.code === 'EMP002')?.username).toBe('prae');
    // the moved shop is a cloud shop now: the owner accepts the SCG terms first
    expect((await client(cloud, lg.body.token).get('/api/products')).body.details.reason).toBe('TERMS_REQUIRED');
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
});

describe('M19-10 sales summary to SCG (manual, preview, audited, no customer data)', () => {
  it('preview: daily qty + value per SCG product and one total for other products, nothing about customers', async () => {
    const p = await owner.get(`/api/share/preview?from=${TODAY}&to=${TODAY}`);
    expect(p.status).toBe(200);
    const day = p.body.days[0];
    expect(day.date).toBe(TODAY);
    expect(day.scg).toEqual([{ sku: 'SCG-CEM-T50', name: 'ปูนซีเมนต์ตราเสือ 50 กก.', unit: 'ถุง', qty: '45', amount: '6525.00' }]);
    expect(day.otherAmount).toBe('495.00');
    expect(p.body.totals).toEqual({ scgQty: '45', scgAmount: '6525.00', otherAmount: '495.00', total: '7020.00' });
    const s = JSON.stringify(p.body);
    for (const leak of ['ลูกค้าทั่วไป', 'ABB', 'น้องแพร', 'customer']) expect(s).not.toContain(leak);
    expect((await owner.get('/api/share/preview?from=2026-10-27&to=2026-10-27')).status).toBe(400); // future
  });

  it('needs the owner, the destination URL and a license key; sends to the SCG receiver and records the receipt', async () => {
    expect((await suda.post('/api/share/send', { from: TODAY, to: TODAY })).status).toBe(403);
    expect((await owner.post('/api/share/send', { from: TODAY, to: TODAY })).body.details.reason).toBe('SHARE_URL_MISSING');
    process.env.SCG_SHARE_URL = 'https://erp.scg.example/api/scg/sales-summary';
    expect((await owner.post('/api/share/send', { from: TODAY, to: TODAY })).body.details.reason).toBe('LICENSE_REQUIRED');
    // the SCG team issues the key on cloud; the shop enters it
    const scg = await admLogin(cloud);
    const t = (await env.pool.query(`select name, tax_id from tenants where id = $1`, [env.seed.tenantId])).rows[0];
    const lic = (await scg.post('/api/adm/licenses', { shopName: t.name, taxId: t.tax_id, type: 'lifetime' })).body;
    expect((await owner.post('/api/license', { key: lic.key })).body.state).toBe('valid');
    // transport: deliver to the cloud app in-process
    const prev = transports.share;
    transports.share = async (url, body) => {
      expect(url).toBe(process.env.SCG_SHARE_URL);
      const r = await client(cloud).post('/api/scg/sales-summary', body);
      if (r.status !== 201) throw new Error(`SCG answered ${r.status}`);
      return r.body;
    };
    try {
      const sent = await owner.post('/api/share/send', { from: TODAY, to: TODAY });
      expect(sent.body).toMatchObject({ status: 'sent', total: '7020.00', receiptId: expect.any(String) });
      const inbox = await scg.get(`/api/adm/sales-shares?licenseId=${lic.licenseId}`);
      expect(inbox.body.items[0]).toMatchObject({ id: sent.body.receiptId, total: '7020.00' });
      transports.share = async () => { throw new Error('offline'); };
      const failed = await owner.post('/api/share/send', { from: TODAY, to: TODAY });
      expect(failed.body).toMatchObject({ status: 'failed', error: 'offline' });
    } finally {
      transports.share = prev;
    }
    const h = await owner.get('/api/share/history');
    expect(h.body.items.map((x: { status: string }) => x.status)).toEqual(['failed', 'sent']);
    const a = await env.pool.query(`select action from audit_log where tenant_id = $1 and object = 'sales-summary' order by chain_seq`, [env.seed.tenantId]);
    expect(a.rows.map((x) => x.action)).toEqual(['share', 'share-failed']);
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
