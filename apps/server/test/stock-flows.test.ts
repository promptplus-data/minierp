/**
 * Stock audit (item 3): every stock-moving flow cuts / restores on hand and lots correctly and atomically.
 * After each flow: the expected per-warehouse delta, and the ledger invariants
 *   - Σ lots − Σ ledger per product × warehouse never changes (lots and stock_moves move together),
 *   - each lot's remaining = (qty_in for opening lots | 0) + Σ in − Σ out of its stock_move_lots,
 *   - every ledger row's cost = Σ lot qty × lot cost of its stock_move_lots (±0.01),
 *   - no negative lot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@erp/db';
import { seedSales } from '@erp/db/src/seedSales';
import { seedRetail } from '../../../packages/db/src/seedRetail';
import { login, lotsOf, openShift, saleBody, setupEnv, stockQty, type Client, type Env } from './helpers';

let env: Env;
let owner: Client;
let suda: Client;
let chai: Client;
let boy: Client;
let prae: Client;
let shift: string;
let failOp = '';
let baseline: Map<string, number>;

const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;

beforeAll(async () => {
  env = await setupEnv({ hooks: { beforeCommit: (op) => { if (failOp && op === failOp) { failOp = ''; throw new Error(`simulated crash in ${op}`); } } } });
  await withTenant(env.pool, env.seed.tenantId, (c) => seedSales(c, env.seed.tenantId));
  await seedRetail(env.pool, env.seed.tenantId);
  [owner, suda, chai, boy, prae] = await Promise.all([login(env.app, 'charoen'), login(env.app, 'suda'), login(env.app, 'chai'), login(env.app, 'boy'), login(env.app, 'prae')]);
  shift = await openShift(prae, '1000.00', 'POS-01');
  baseline = await lotsMinusLedger();
});
afterAll(async () => { await env.close(); });

async function lotsMinusLedger(): Promise<Map<string, number>> {
  const r = await env.pool.query<{ k: string; v: string }>(
    `select x.product_id || ':' || x.warehouse_id k, (coalesce(sum(x.l), 0) - coalesce(sum(x.m), 0))::text v from (
       select product_id, warehouse_id, remaining l, 0 m from stock_lots
       union all select product_id, warehouse_id, 0, qty from stock_moves) x group by 1`);
  return new Map(r.rows.map((x) => [x.k, Number(x.v)]));
}

async function invariants() {
  const now = await lotsMinusLedger();
  for (const [k, v] of now) expect({ k, v }).toEqual({ k, v: baseline.get(k) ?? 0 });
  const lots = await env.pool.query<{ id: string; bad: boolean }>(
    `select l.id, not (l.remaining - coalesce(n.net, 0) in (0, l.qty_in)) bad
       from stock_lots l left join (select ml.lot_id, sum(case when m.qty < 0 then -ml.qty else ml.qty end) net
                                      from stock_move_lots ml join stock_moves m on m.id = ml.move_id group by ml.lot_id) n on n.lot_id = l.id`);
  expect(lots.rows.filter((x) => x.bad)).toEqual([]);
  const cost = await env.pool.query(
    `select m.id from stock_moves m left join stock_move_lots ml on ml.move_id = m.id
      group by m.id, m.cost having abs(m.cost - coalesce(sum(ml.qty * ml.unit_cost), 0)) > 0.01`);
  expect(cost.rows).toEqual([]);
  expect((await env.pool.query(`select count(*)::int n from stock_lots where remaining < 0`)).rows[0].n).toBe(0);
}

/** Runs a flow and checks the on-hand delta of each product × warehouse it touches, then the invariants. */
async function expectDelta(deltas: [string, string, number][], flow: () => Promise<unknown>) {
  const before = await Promise.all(deltas.map(([p, w]) => stockQty(env.pool, p, w)));
  const out = await flow();
  const after = await Promise.all(deltas.map(([p, w]) => stockQty(env.pool, p, w)));
  expect(after.map((a, i) => +(a - before[i]!).toFixed(4))).toEqual(deltas.map((x) => x[2]));
  await invariants();
  return out;
}

async function ok<T = any>(p: Promise<{ status: number; body: any }>, status = 200): Promise<T> {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

describe('stock-moving flows', () => {
  it('POS sale cuts FIFO; void puts it back into the very same lots', async () => {
    const lots0 = await lotsOf(env.pool, P('p6'), W('WH1'));
    const bill = await expectDelta([[P('p6'), W('WH1'), -3]], () => ok(prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '3', price: '89.00' }], '267.00')), 201));
    await expectDelta([[P('p6'), W('WH1'), 3]], () => ok(owner.post(`/api/sales/docs/${(bill as { no: string }).no}/void`, { reason: 'คีย์ผิด' })));
    expect(await lotsOf(env.pool, P('p6'), W('WH1'))).toEqual(lots0);
  });

  it('POS sale in a non-base unit cuts base units', async () => {
    await expectDelta([[P('p5'), W('WH1'), -0.5]], () => ok(prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p5', qty: '5', unitIdx: 1, price: '18.00' }], '90.00')), 201));
  });

  it('sales order reserves without cutting; DO cuts; DO void restores', async () => {
    const so = await expectDelta([[P('p4'), W('WH2'), 0]], () => ok(boy.post('/api/sales/orders', { customerId: env.seed.customers.c1, warehouseId: W('WH2'), lines: [{ productId: P('p4'), qty: '10', unitPrice: '196.26' }] }), 201)) as any;
    const dlv = await expectDelta([[P('p4'), W('WH2'), -4]], () => ok(chai.post('/api/sales/deliveries', { soNo: so.no, lines: [{ srcLineId: so.lines[0].id, qty: '4' }] }), 201)) as any;
    await expectDelta([[P('p4'), W('WH2'), 4]], () => ok(owner.post(`/api/sales/deliveries/${dlv.no}/void`, { reason: 'ส่งผิด' })));
  });

  it('B2B invoice with goods cuts stock; void restores', async () => {
    const inv = await expectDelta([[P('p6'), W('WH2'), -5]], () => ok(boy.post('/api/sales/invoices', {
      source: 'direct', customerId: env.seed.customers.c2, warehouseId: W('WH2'), lines: [{ productId: P('p6'), qty: '5', unitPrice: '83.18' }],
    }), 201)) as any;
    await expectDelta([[P('p6'), W('WH2'), 5]], () => ok(owner.post(`/api/sales/docs/${inv.doc.no}/void`, { reason: 'x' })));
  });

  it('returns: good back to the sale warehouse at the sold FIFO cost; damaged into the damaged-goods warehouse', async () => {
    const inv = await ok(boy.post('/api/sales/invoices', {
      source: 'direct', customerId: env.seed.customers.c2, warehouseId: W('WH2'), lines: [{ productId: P('p6'), qty: '4', unitPrice: '83.18' }],
    }), 201) as any;
    const sold = await env.pool.query<{ c: string }>(`select (cogs / base_qty)::numeric(14,4)::text c from doc_lines where id = $1`, [inv.doc.lines[0].id]);
    const cn = await expectDelta([[P('p6'), W('WH2'), 1]], () => ok(suda.post('/api/returns', {
      sourceDocNo: inv.doc.no, lines: [{ lineId: inv.doc.lines[0].id, qty: '1', condition: 'good' }], refund: 'credit', reason: 'ซื้อเกิน',
    }), 201)) as any;
    const lot = await env.pool.query<{ c: string; w: string }>(`select unit_cost::text c, warehouse_id w from stock_lots where ref = $1`, [cn.no]);
    expect(lot.rows).toEqual([{ c: sold.rows[0]!.c, w: W('WH2') }]);
    const dmg = await ok(suda.post('/api/returns', {
      sourceDocNo: inv.doc.no, lines: [{ lineId: inv.doc.lines[0].id, qty: '2', condition: 'damaged' }], refund: 'credit', reason: 'แตก',
    }), 201) as any;
    const dw = await env.pool.query<{ id: string }>(`select id from warehouses where kind = 'damaged'`);
    expect(dw.rows).toHaveLength(1);
    expect(await stockQty(env.pool, P('p6'), dw.rows[0]!.id)).toBe(2);
    expect((await env.pool.query(`select unit_cost::text c from stock_lots where ref = $1`, [dmg.no])).rows).toEqual([{ c: sold.rows[0]!.c }]);
    await invariants();
  });

  it('return of a B2B invoice made from delivery orders goes back to the DO warehouse at the delivered cost', async () => {
    const so = await ok(boy.post('/api/sales/orders', { customerId: env.seed.customers.c1, warehouseId: W('WH2'), lines: [{ productId: P('p1'), qty: '5', unitPrice: '135.51' }] }), 201) as any;
    const dlv = await ok(chai.post('/api/sales/deliveries', { soNo: so.no, lines: [{ srcLineId: so.lines[0].id, qty: '5' }] }), 201) as any;
    const inv = await ok(boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [dlv.no] }), 201) as any;
    const cn = await expectDelta([[P('p1'), W('WH2'), 2]], () => ok(suda.post('/api/returns', {
      sourceDocNo: inv.doc.no, lines: [{ lineId: inv.doc.lines[0].id, qty: '2' }], refund: 'credit', reason: 'เหลือจากหน้างาน',
    }), 201)) as any;
    const c = await env.pool.query<{ u: string; dl: string }>(
      `select (select unit_cost::text from stock_lots where ref = $1) u, (select (cogs / base_qty)::numeric(14,4)::text from sales_delivery_lines where delivery_id = (select id from sales_deliveries where no = $2)) dl`, [cn.no, dlv.no]);
    expect(c.rows[0]!.u).toBe(c.rows[0]!.dl);
  });

  it('MO issue cuts materials, output adds a lot, cancel restores the materials', async () => {
    const mo = await expectDelta([[P('p1'), W('WH2'), -1.2], [P('p5'), W('WH2'), -1.2]], () => ok(chai.post('/api/mos', {
      productId: P('p12'), planQty: '2', issueWarehouseId: W('WH2'), outputWarehouseId: W('WH2'),
    }), 201)) as any;
    await ok(chai.post(`/api/mos/${mo.no}/outputs`, { good: '2' }));
    await expectDelta([[P('p12'), W('WH2'), 2]], () => ok(chai.post(`/api/mos/${mo.no}/close`, {})));
    const mo2 = await ok(chai.post('/api/mos', { productId: P('p12'), planQty: '1', issueWarehouseId: W('WH2'), outputWarehouseId: W('WH2') }), 201) as any;
    await expectDelta([[P('p1'), W('WH2'), 0.6], [P('p5'), W('WH2'), 0.6]], () => ok(chai.post(`/api/mos/${mo2.no}/cancel`, { reason: 'ยกเลิกงาน' })));
  });

  it('manual receipt adds a lot; vendor return cuts it', async () => {
    const gr = await expectDelta([[P('p7'), W('WH2'), 6]], () => ok(owner.post('/api/stock/receipts', {
      vendorId: env.seed.vendors.v3, vendorInvoiceNo: 'AUD-1', deliveryNo: 'DN-AUD-1', warehouseId: W('WH2'), lines: [{ productId: P('p7'), qty: '6', unitCost: '1000' }],
    }), 201)) as any;
    const grd = await ok(owner.get(`/api/purchasing/receipts/${gr.no}`)) as any;
    await expectDelta([[P('p7'), W('WH2'), -2]], () => ok(owner.post('/api/ap/vendor-returns', { grNo: gr.no, lines: [{ grLineId: grd.lines[0].id, qty: '2' }], reason: 'บุบ' }), 201));
  });

  it('transfer moves lots at their cost and received date', async () => {
    await expectDelta([[P('p3'), W('WH2'), -10], [P('p3'), W('WH1'), 10]], () => ok(chai.post('/api/stock/transfers', {
      fromWarehouseId: W('WH2'), toWarehouseId: W('WH1'), lines: [{ productId: P('p3'), qty: '10' }], note: 'เติมหน้าร้าน',
    }), 201));
  });

  it('adjustment: nothing moves until approved; approval applies decreases FIFO and increases at average cost', async () => {
    const rq = await expectDelta([[P('p2'), W('WH2'), 0]], () => ok(chai.post('/api/stock/adjust-requests', {
      warehouseId: W('WH2'), lines: [{ productId: P('p2'), qtyDelta: '-3' }, { productId: P('p3'), qtyDelta: '2' }], reason: 'นับได้', note: 'แผ่นแตก 3',
    }), 201)) as any;
    expect(rq.note).toBe('แผ่นแตก 3');
    await expectDelta([[P('p2'), W('WH2'), -3], [P('p3'), W('WH2'), 2]], () => ok(suda.post(`/api/stock/adjust-requests/${rq.id}/approve`)));
  });

  it('issue (เบิกใช้) cuts FIFO', async () => {
    await expectDelta([[P('p8'), W('WH2'), -1]], () => ok(chai.post('/api/stock/issues', { warehouseId: W('WH2'), lines: [{ productId: P('p8'), qty: '1' }], reason: 'ใช้ในร้าน' }), 201));
  });

  it('a crash before commit leaves stock, lots and numbers untouched (transfer, adjustment approval, return)', async () => {
    failOp = 'transfer';
    await expectDelta([[P('p3'), W('WH2'), 0], [P('p3'), W('WH1'), 0]], async () => {
      expect((await chai.post('/api/stock/transfers', { fromWarehouseId: W('WH2'), toWarehouseId: W('WH1'), lines: [{ productId: P('p3'), qty: '5' }] })).status).toBe(500);
    });
    const rq = await ok(chai.post('/api/stock/adjust-requests', { warehouseId: W('WH2'), lines: [{ productId: P('p2'), qtyDelta: '-1' }], reason: 'x' }), 201) as any;
    failOp = 'approveAdjust';
    await expectDelta([[P('p2'), W('WH2'), 0]], async () => {
      expect((await suda.post(`/api/stock/adjust-requests/${rq.id}/approve`)).status).toBe(500);
    });
    expect((await env.pool.query(`select status from adjust_requests where id = $1`, [rq.id])).rows[0].status).toBe('pending');
    const bill = await ok(prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00')), 201) as any;
    const cnBefore = (await env.pool.query(`select count(*)::int n from docs where type = 'CN'`)).rows[0].n;
    failOp = 'createReturn';
    await expectDelta([[P('p6'), W('WH1'), 0]], async () => {
      expect((await suda.post('/api/returns', { sourceDocNo: bill.no, lines: [{ lineId: bill.lines[0].id, qty: '1' }], refund: 'transfer', reason: 'x' })).status).toBe(500);
    });
    expect((await env.pool.query(`select count(*)::int n from docs where type = 'CN'`)).rows[0].n).toBe(cnBefore);
  });

  it('the damaged-goods warehouse is never sellable: POS, DO, invoice and production refuse it; transfer and write-off work', async () => {
    const dw = (await env.pool.query<{ id: string }>(`select id from warehouses where kind = 'damaged'`)).rows[0]!.id;
    expect((await prae.post('/api/sales/pos', { ...saleBody(env.seed, shift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'), warehouseId: dw })).status).toBe(400);
    expect((await boy.post('/api/sales/invoices', { source: 'direct', customerId: env.seed.customers.c2, warehouseId: dw, lines: [{ productId: P('p6'), qty: '1', unitPrice: '83.18' }] })).status).toBe(400);
    expect((await boy.post('/api/sales/orders', { customerId: env.seed.customers.c1, warehouseId: dw, lines: [{ productId: P('p6'), qty: '1', unitPrice: '83.18' }] })).status).toBe(400);
    expect((await chai.post('/api/mos', { productId: P('p12'), planQty: '1', issueWarehouseId: dw, outputWarehouseId: W('WH2') })).status).toBe(400);
    expect((await owner.post('/api/stock/receipts', { vendorId: env.seed.vendors.v3, vendorInvoiceNo: 'AUD-2', deliveryNo: 'D', warehouseId: dw, lines: [{ productId: P('p7'), qty: '1', unitCost: '1' }] })).status).toBe(400);
    // write-off through the adjustment approval
    const rq = await ok(chai.post('/api/stock/adjust-requests', { warehouseId: dw, lines: [{ productId: P('p6'), qtyDelta: '-1' }], reason: 'ตัดจำหน่ายของเสีย' }), 201) as any;
    await expectDelta([[P('p6'), dw, -1]], () => ok(suda.post(`/api/stock/adjust-requests/${rq.id}/approve`)));
    // back to a normal warehouse by transfer (e.g. to return it to the vendor from there)
    await expectDelta([[P('p6'), dw, -1], [P('p6'), W('WH2'), 1]], () => ok(chai.post('/api/stock/transfers', { fromWarehouseId: dw, toWarehouseId: W('WH2'), lines: [{ productId: P('p6'), qty: '1' }] }), 201));
  });
});
