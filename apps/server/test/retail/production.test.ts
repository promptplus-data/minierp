/** M16 production: BOM versions, MO issue FIFO (BR-07/21), outputs, close → new lot at (materials + labour) ÷ good, cancel. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, lotsOf, setupEnv, stockQty, type Client, type Env } from '../helpers';
import { seedRetail, type RetailSeed } from '../../../../packages/db/src/seedRetail';

let env: Env;
let rs: RetailSeed;
let owner: Client;
let chai: Client;
let prae: Client;

beforeAll(async () => {
  env = await setupEnv();
  rs = await seedRetail(env.pool, env.seed.tenantId);
  owner = await login(env.app, 'charoen');
  chai = await login(env.app, 'chai');
  prae = await login(env.app, 'prae');
});
afterAll(async () => { await env.close(); });

const P = (k: string) => env.seed.products[k]!;
const WH2 = () => env.seed.warehouses.WH2!;

describe('BOM (REQ-M16-01)', () => {
  it('lists the active recipe with standard cost for data.cost roles only', async () => {
    const r = await owner.get('/api/boms');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    const post = r.body.items.find((b: { productId: string }) => b.productId === P('p11'));
    expect(post).toMatchObject({ version: 1, active: true, labourPerUnit: '25' });
    expect(post.components.map((c: { qtyPerUnit: string }) => c.qtyPerUnit)).toEqual(['0.5', '0.04', '0.06', '1.2']);
    expect(Number(post.stdUnitCost)).toBeGreaterThan(300);
    const asWh = await chai.get('/api/boms');
    expect(asWh.body.items[0].stdUnitCost).toBeNull();
    expect((await prae.get('/api/boms')).status).toBe(403);
  });

  it('a new version becomes the only active one; an older version can be re-activated', async () => {
    const v2 = await chai.post('/api/boms', {
      productId: P('p11'), labourPerUnit: '30',
      components: [{ productId: P('p1'), qtyPerUnit: '0.55' }, { productId: P('p8'), qtyPerUnit: '0.04' }, { productId: P('p10'), qtyPerUnit: '0.06' }, { productId: P('p5'), qtyPerUnit: '1.2' }],
    });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, active: true });
    const all = await owner.get(`/api/boms?all=1&productId=${P('p11')}`);
    expect(all.body.items.map((b: { version: number; active: boolean }) => [b.version, b.active])).toEqual([[2, true], [1, false]]);
    const back = await owner.post(`/api/boms/${rs.boms['MK-POST-15']}/activate`, {});
    expect(back.status).toBe(200);
    const again = await owner.get(`/api/boms?productId=${P('p11')}`);
    expect(again.body.items.map((b: { version: number }) => b.version)).toEqual([1]);
  });

  it('rejects a product as its own material, duplicates, services and zero quantities', async () => {
    const base = { productId: P('p12'), labourPerUnit: '0' };
    expect((await owner.post('/api/boms', { ...base, components: [{ productId: P('p12'), qtyPerUnit: '1' }] })).status).toBe(400);
    expect((await owner.post('/api/boms', { ...base, components: [{ productId: P('p1'), qtyPerUnit: '1' }, { productId: P('p1'), qtyPerUnit: '2' }] })).status).toBe(400);
    expect((await owner.post('/api/boms', { ...base, components: [{ productId: P('p9'), qtyPerUnit: '1' }] })).status).toBe(400);
    expect((await owner.post('/api/boms', { ...base, components: [{ productId: P('p1'), qtyPerUnit: '0' }] })).status).toBe(400);
  });
});

describe('manufacturing order (REQ-M16-02/03/04)', () => {
  let no = '';

  it('suggests materials from the BOM × plan with stock on hand', async () => {
    const r = await owner.post('/api/mos/suggest', { productId: P('p12'), planQty: '20', issueWarehouseId: WH2() });
    expect(r.status).toBe(200);
    expect(r.body.lines.map((l: { stdQty: string; available: string }) => [l.stdQty, l.available])).toEqual([['12', '340'], ['1', '12'], ['1.4', '8'], ['12', '300']]);
    expect(r.body.lines[0].estCost).toBe('1420.08'); // 12 × 118.34 (oldest lot)
  });

  it('a shortage blocks the issue (BR-07) without writing anything or using a number', async () => {
    const r = await chai.post('/api/mos', { productId: P('p12'), planQty: '1000', issueWarehouseId: WH2(), outputWarehouseId: WH2() });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await env.pool.query(`select count(*)::int n from retail_mos`)).rows[0].n).toBe(0);
  });

  it('opens an MO with an edited issue qty, cutting each material FIFO from the oldest lot', async () => {
    const r = await chai.post('/api/mos', {
      productId: P('p12'), planQty: '20', issueWarehouseId: WH2(), outputWarehouseId: WH2(), issues: [{ productId: P('p5'), qty: '13' }], note: 'ทดสอบ',
    });
    expect(r.status).toBe(201);
    no = r.body.no;
    expect(no).toBe('MO2610-0001');
    expect(r.body.status).toBe('wip');
    expect(r.body.materials.map((m: { stdQty: string; issueQty: string }) => [m.stdQty, m.issueQty])).toEqual([['12', '12'], ['1', '1'], ['1.4', '1.4'], ['12', '13']]);
    expect(r.body.materialsCost).toBeNull(); // wh role: no data.cost
    const asOwner = await owner.get(`/api/mos/${no}`);
    // 12 × 118.34 + 1 × 504.40 + 1.4 × 582 + 13 × 137.74
    expect(asOwner.body.materialsCost).toBe('4529.90');
    expect(asOwner.body.materials[3].lots).toEqual([{ ref: expect.any(String), receivedAt: expect.any(String), qty: '13', unitCost: '137.74' }]);
    expect(await stockQty(env.pool, P('p5'), WH2())).toBe(287);
  });

  it('records good / reject output several times; closing needs good output', async () => {
    expect((await chai.post(`/api/mos/${no}/outputs`, { good: '0', reject: '0' })).status).toBe(400);
    expect((await chai.post(`/api/mos/${no}/outputs`, { good: '18', reject: '1', note: 'รอบเช้า' })).status).toBe(200);
    const r = await chai.post(`/api/mos/${no}/outputs`, { good: '1', reject: '0' });
    expect(r.body).toMatchObject({ goodQty: '19', rejectQty: '1', yieldPct: '95.00' });
    expect(r.body.outputs).toHaveLength(2);
    // Cancel is refused once there is output (close it instead).
    expect((await chai.post(`/api/mos/${no}/cancel`, { reason: 'x' })).status).toBe(409);
  });

  it('close returns leftovers at issue cost and receives ONE lot at (materials used + labour) ÷ good', async () => {
    const tooMuch = await chai.post(`/api/mos/${no}/close`, { returns: [{ productId: P('p5'), qty: '14' }] });
    expect(tooMuch.status).toBe(400);
    const r = await chai.post(`/api/mos/${no}/close`, { returns: [{ productId: P('p5'), qty: '1' }] });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('closed');
    const asOwner = await owner.get(`/api/mos/${no}`);
    // used 4529.90 − 137.74 = 4392.16; labour 20 × 19 = 380 → 4772.16 / 19
    expect(asOwner.body).toMatchObject({ materialsCost: '4392.16', labourCost: '380.00', unitCost: '251.1663', yieldPct: '95.00' });
    const lots = await lotsOf(env.pool, P('p12'), WH2());
    expect(lots.at(-1)).toMatchObject({ remaining: '19.0000', unit_cost: '251.1663', ref: no });
    expect(await stockQty(env.pool, P('p5'), WH2())).toBe(288);
    expect((await chai.post(`/api/mos/${no}/outputs`, { good: '1' })).status).toBe(409);
    const moves = await env.pool.query(`select count(*)::int n from stock_moves where doc_no = $1`, [no]);
    expect(moves.rows[0].n).toBe(6); // 4 issues + 1 return + 1 receipt
  });

  it('cancel without output puts every material back into its original lots', async () => {
    const before = await lotsOf(env.pool, P('p1'), WH2());
    const r = await chai.post('/api/mos', { productId: P('p11'), planQty: '2', issueWarehouseId: WH2(), outputWarehouseId: WH2() });
    expect(r.status).toBe(201);
    const c = await chai.post(`/api/mos/${r.body.no}/cancel`, { reason: 'สั่งผิดสินค้า' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'cancelled', cancelReason: 'สั่งผิดสินค้า' });
    expect(await lotsOf(env.pool, P('p1'), WH2())).toEqual(before);
  });

  it('lists MOs (paged, searchable) and reports standard vs used per MO', async () => {
    const list = await owner.get('/api/mos?limit=1');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.nextCursor).toBeTruthy();
    const next = await owner.get(`/api/mos?limit=1&cursor=${list.body.nextCursor}`);
    expect(next.body.items[0].no).toBe(no);
    const closed = await owner.get('/api/mos?status=closed&q=วงบ่อ');
    expect(closed.body.items.map((m: { no: string }) => m.no)).toEqual([no]);
    const rep = await owner.get('/api/mos/report');
    const row = rep.body.items.find((x: { no: string }) => x.no === no);
    expect(row.materials[3]).toMatchObject({ stdQty: '12', usedQty: '12', varianceQty: '0' });
    expect(row.unitCost).toBe('251.1663');
    expect(rep.body.items.some((x: { status: string }) => x.status === 'cancelled')).toBe(false);
    const asWh = await chai.get('/api/mos/report');
    expect(asWh.body.items[0].unitCost).toBeNull();
  });

  it('every step is in the audit log (BR-18)', async () => {
    const r = await env.pool.query<{ action: string }>(`select action from audit_log where tenant_id = $1 and ref = $2 order by chain_seq`, [env.seed.tenantId, no]);
    expect(r.rows.map((x) => x.action)).toEqual(['issue', 'output', 'output', 'close']);
  });
});
