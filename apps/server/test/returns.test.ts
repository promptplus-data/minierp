/** REQ-M08-06 returns: bill picker search + credit note with stock back at original cost; BR-22 downstream-first void. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, lotsOf, openShift, saleBody, setupEnv, stockQty, type Client, type Env } from './helpers';

let env: Env;
let prae: Client;
let suda: Client;
let shift: string;
const bills: Record<string, string> = {};
const approval = () => ({ approverUserId: env.seed.users.suda!, pin: '1234' });

beforeAll(async () => {
  env = await setupEnv();
  prae = await login(env.app, 'prae');
  suda = await login(env.app, 'suda');
  shift = await openShift(prae);
  const sell = async (key: string, body: ReturnType<typeof saleBody>) => {
    const r = await prae.post('/api/sales/pos', body);
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    bills[key] = r.body.no;
  };
  await sell('cement', saleBody(env.seed, shift, [{ p: 'p1', qty: '30', price: '145.00' }], '4350.00'));
  await sell('somsri', saleBody(env.seed, shift, [{ p: 'p6', qty: '3', price: '89.00' }], '267.00', { customerId: env.seed.customers.c3 }));
  await sell('rungruang', saleBody(env.seed, shift, [{ p: 'p4', qty: '2', price: '210.00' }], '420.00', { docKind: 'full', customerId: env.seed.customers.c1 }));
  await sell('old', saleBody(env.seed, shift, [{ p: 'p2', qty: '10', price: '52.00' }], '520.00', { customerId: env.seed.customers.c3 }));
  // pretend the last bill is 40 days old
  await env.pool.query(`update docs set date = date '2026-10-26' - 40, created_at = now() - interval '40 days' where no = $1`, [bills.old]);
});
afterAll(async () => { await env.close(); });

const search = async (qs: string) => (await prae.get(`/api/returns/eligible?${qs}`)).body;
const nos = (page: { items: { no: string }[] }) => page.items.map((i) => i.no);

describe('GET /api/returns/eligible', () => {
  it('finds bills by customer name, phone, product, bill no and amount (multi-word AND)', async () => {
    expect(nos(await search('q=' + encodeURIComponent('สมศรี')))).toEqual([bills.somsri]);
    expect(nos(await search('q=086-555-7788'))).toEqual([bills.somsri]);
    expect(nos(await search('q=0865557788'))).toEqual([bills.somsri]);
    expect(nos(await search('q=' + encodeURIComponent('ปูนซีเมนต์')))).toEqual([bills.cement]);
    expect(nos(await search('q=scg-ta-20'))).toEqual([bills.rungruang]);
    expect(nos(await search('q=' + bills.cement))).toEqual([bills.cement]);
    expect(nos(await search('q=4,350.00'))).toEqual([bills.cement]);
    expect(nos(await search('q=267'))).toEqual([bills.somsri]);
    expect(nos(await search('q=0503558001234'))).toEqual([bills.rungruang]); // customer tax ID
    expect(nos(await search('q=' + encodeURIComponent('สมศรี pvc')))).toEqual([bills.somsri]);
    expect(nos(await search('q=' + encodeURIComponent('สมศรี กาว')))).toEqual([]);
  });

  it('filters by period and lists newest first', async () => {
    expect(nos(await search('days=30'))).toEqual([bills.rungruang, bills.somsri, bills.cement]);
    expect(nos(await search('days=all'))).toEqual([bills.rungruang, bills.somsri, bills.cement, bills.old]);
    expect(nos(await search('days=all&q=' + encodeURIComponent('สมศรี')))).toEqual([bills.somsri, bills.old]);
    expect(nos(await search('days=7&q=' + encodeURIComponent('ลอนคู่')))).toEqual([]);
  });

  it('pages with an opaque cursor', async () => {
    const p1 = await search('days=all&limit=2');
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await search(`days=all&limit=2&cursor=${p1.nextCursor}`);
    expect(nos(p2)).toEqual([bills.cement, bills.old]);
    expect(p2.nextCursor).toBeNull();
    expect((await prae.get('/api/returns/eligible?limit=101')).status).toBe(400);
  });

  it('uses the pg_trgm index for the haystack', async () => {
    const idx = await env.pool.query(`select indexdef from pg_indexes where indexname = 'docs_search_trgm'`);
    expect(idx.rows[0].indexdef).toContain('gin_trgm_ops');
  });
});

describe('POST /api/returns', () => {
  it('cashier needs a manager PIN', async () => {
    const doc = (await suda.get(`/api/sales/docs/${bills.cement}`)).body;
    const r = await prae.post('/api/returns', { sourceDocNo: bills.cement, lines: [{ lineId: doc.lines[0].id, qty: '1' }], condition: 'good', refund: 'cash', reason: 'ซื้อเกิน' });
    expect(r.status).toBe(403);
  });

  it('good condition: stock back IN at the original FIFO cost, cash refund counted in the shift', async () => {
    const doc = (await suda.get(`/api/sales/docs/${bills.cement}`)).body;
    const wh2 = env.seed.warehouses.WH2!;
    const p1 = env.seed.products.p1!;
    const before = await stockQty(env.pool, p1, wh2);
    const r = await prae.post('/api/returns', {
      sourceDocNo: bills.cement, lines: [{ lineId: doc.lines[0].id, qty: '10' }], condition: 'good', warehouseId: wh2, refund: 'cash', reason: 'ซื้อเกิน', approval: approval(),
    });
    expect(r.status).toBe(201);
    expect(r.body.type).toBe('CN');
    expect(r.body.no).toBe('CN2610-0001');
    expect(r.body.ref).toBe(bills.cement);
    expect(r.body.totals.total).toBe('1450.00');
    expect(await stockQty(env.pool, p1, wh2)).toBe(before + 10);
    const lot = (await lotsOf(env.pool, p1, wh2)).find((l) => l.ref === r.body.no)!;
    expect(lot).toMatchObject({ remaining: '10.0000', unit_cost: '119.3567' }); // 3580.70 / 30 sold

    const src = (await suda.get(`/api/sales/docs/${bills.cement}`)).body;
    expect(src.lines[0].returnedQty).toBe('10');
    const s = (await prae.get('/api/shifts/current')).body;
    expect(s.cashRefunds).toBe('1450.00');
  });

  it('rejects qty above sold − already returned', async () => {
    const doc = (await suda.get(`/api/sales/docs/${bills.cement}`)).body;
    const r = await suda.post('/api/returns', { sourceDocNo: bills.cement, lines: [{ lineId: doc.lines[0].id, qty: '25' }], condition: 'good', refund: 'transfer', reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ max: '20' });
  });

  it('returning the rest refunds exactly the remainder', async () => {
    const doc = (await suda.get(`/api/sales/docs/${bills.cement}`)).body;
    const r = await suda.post('/api/returns', { sourceDocNo: bills.cement, lines: [{ lineId: doc.lines[0].id, qty: '20' }], condition: 'bad', refund: 'transfer', reason: 'ชำรุด' });
    expect(r.status).toBe(201);
    expect(r.body.totals.total).toBe('2900.00');
    expect(r.body.payments).toEqual([{ method: 'transfer', amount: '2900.00' }]);
    const left = await search('days=all&q=' + bills.cement);
    expect(left.items).toEqual([]); // fully returned bills drop out of the picker
  });

  it('bad condition puts nothing back into stock', async () => {
    const doc = (await suda.get(`/api/sales/docs/${bills.somsri}`)).body;
    const before = await stockQty(env.pool, env.seed.products.p6!, env.seed.warehouses.WH1!);
    const r = await suda.post('/api/returns', { sourceDocNo: bills.somsri, lines: [{ lineId: doc.lines[0].id, qty: '1' }], condition: 'bad', refund: 'transfer', reason: 'ชำรุด' });
    expect(r.status).toBe(201);
    expect(await stockQty(env.pool, env.seed.products.p6!, env.seed.warehouses.WH1!)).toBe(before);
  });

  it('cash refund needs an open shift', async () => {
    const boy = await login(env.app, 'boy');
    const doc = (await suda.get(`/api/sales/docs/${bills.rungruang}`)).body;
    const r = await boy.post('/api/returns', { sourceDocNo: bills.rungruang, lines: [{ lineId: doc.lines[0].id, qty: '1' }], condition: 'good', refund: 'cash', reason: 'x', approval: approval() });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SHIFT_REQUIRED');
  });

  it('credit refund needs an outstanding receivable on the bill', async () => {
    const doc = (await suda.get(`/api/sales/docs/${bills.rungruang}`)).body;
    const r = await suda.post('/api/returns', { sourceDocNo: bills.rungruang, lines: [{ lineId: doc.lines[0].id, qty: '1' }], condition: 'good', refund: 'credit', reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ arBalance: '0.00' });
  });

  it('a bill with a return cannot be voided (DOWNSTREAM_FIRST)', async () => {
    const r = await suda.post(`/api/sales/docs/${bills.somsri}/void`, { reason: 'ผิด' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DOWNSTREAM_FIRST');
    expect(r.body.details.docs).toHaveLength(1);
  });
});
