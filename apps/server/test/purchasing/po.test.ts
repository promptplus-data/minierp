/** Purchase orders (ใบสั่งซื้อ): create, from a QT / SO with the shortfall, receive against it, GR void rolls back, void / close rules, permissions. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, stockQty, type Client, type Env, setupEnv } from '../helpers';

let env: Env;
let chai: Client; // wh: inv.receive, no data.cost
let charoen: Client; // owner
let boy: Client; // sales: no inv.receive
let acct: Client; // accountant: fin.ap
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const V = (k: string) => env.seed.vendors[k]!;
const C = (k: string) => env.seed.customers[k]!;

beforeAll(async () => {
  env = await setupEnv();
  await env.pool.query(`insert into users (tenant_id, username, name, role, password_hash) select tenant_id, 'nok', 'คุณนก (บัญชี)', 'acct', password_hash from users where username = 'suda'`);
  [chai, charoen, boy, acct] = await Promise.all([login(env.app, 'chai'), login(env.app, 'charoen'), login(env.app, 'boy'), login(env.app, 'nok')]);
});
afterAll(async () => { await env.close(); });

const poBody = (over: Record<string, unknown> = {}) => ({
  vendorId: V('v1'), warehouseId: W('WH2'), expectedDate: '2026-10-30', vendorRef: 'QV-889', note: 'ส่งก่อน 10 โมง',
  lines: [{ productId: P('p4'), qty: '10', unitCost: '100' }, { productId: P('p6'), unitIdx: 1, qty: '2', unitCost: '1400', discount: { kind: 'pct', value: '10' } }],
  ...over,
});
const receive = (c: Client, inv: string, po: { id: string }, lines: { p: string; qty: string; cost?: string; poLineId?: string; unitIdx?: number }[], vendorKey = 'v1') =>
  c.post('/api/stock/receipts', {
    vendorId: V(vendorKey), vendorInvoiceNo: inv, deliveryNo: `DN-${inv}`, warehouseId: W('WH2'), poId: po.id,
    lines: lines.map((l) => ({ productId: P(l.p), unitIdx: l.unitIdx ?? 0, qty: l.qty, unitCost: l.cost ?? '100', poLineId: l.poLineId })),
  });
const audits = async (ref: string) => (await env.pool.query(`select action from audit_log where object = 'PO' and ref = $1 order by chain_seq`, [ref])).rows.map((r) => r.action);

describe('create a purchase order', () => {
  it('PO + YYMM-#### number, lines in any unit, line discount, VAT-excluded totals, audit', async () => {
    const r = await chai.post('/api/purchase-orders', poBody());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      no: 'PO2610-0001', status: 'open', vatMode: 'exc', expectedDate: '2026-10-30', vendorRef: 'QV-889', note: 'ส่งก่อน 10 โมง', source: null,
      vendor: { id: V('v1') }, warehouseId: W('WH2'),
      totals: { gross: '3800.00', lineDisc: '280.00', base7: '3520.00', vat: '246.40', total: '3766.40' },
    });
    expect(r.body.lines[1]).toMatchObject({ unitName: 'มัด', unitFactor: '20', qty: '2', receivedQty: '0', remainingQty: '2', net: '2520.00', grUnitCost: '1260' });
    expect(await audits('PO2610-0001')).toEqual(['create']);
    const list = await chai.get('/api/purchase-orders?status=pending&q=QV-889');
    expect(list.body.items.map((x: { no: string }) => x.no)).toEqual(['PO2610-0001']);
  });

  it('validates on the server: service product, expected date, vendor, empty lines', async () => {
    expect((await chai.post('/api/purchase-orders', poBody({ lines: [{ productId: P('p9'), qty: '1', unitCost: '1' }] }))).status).toBe(400);
    expect((await chai.post('/api/purchase-orders', poBody({ expectedDate: '2026-10-01' }))).status).toBe(400);
    expect((await chai.post('/api/purchase-orders', poBody({ vendorId: W('WH1') }))).status).toBe(400);
    expect((await chai.post('/api/purchase-orders', poBody({ lines: [] }))).status).toBe(400);
    expect((await chai.post('/api/purchase-orders', poBody({ lines: [{ productId: P('p4'), qty: '0', unitCost: '1' }] }))).status).toBe(400);
    const n = await env.pool.query(`select count(*)::int n from purchase_orders`);
    expect(n.rows[0].n).toBe(1); // nothing half-written, no number used
  });
});

describe('permissions', () => {
  it('only inv.receive creates / closes / voids; sales may read without prices; AP sees prices', async () => {
    expect((await boy.post('/api/purchase-orders', poBody())).status).toBe(403);
    expect((await boy.post('/api/purchase-orders/PO2610-0001/void', { reason: 'x' })).status).toBe(403);
    expect((await boy.post('/api/purchase-orders/PO2610-0001/close', { reason: 'x' })).status).toBe(403);
    expect((await boy.get('/api/purchase-orders/prefill/SO2610-0001')).status).toBe(403);
    const asSales = await boy.get('/api/purchase-orders/PO2610-0001');
    expect(asSales.status).toBe(200);
    expect(asSales.body.totals).toBeNull();
    expect(asSales.body.lines[0].unitCost).toBeNull();
    expect((await acct.get('/api/purchase-orders/PO2610-0001')).body.totals.total).toBe('3766.40');
  });
});

describe('PO from a sales order / quotation', () => {
  let so: any;
  it('prefills stock lines with the shortfall in the order warehouse; services are skipped', async () => {
    const r = await charoen.post('/api/sales/orders', {
      customerId: C('c1'), warehouseId: W('WH2'), vatMode: 'exc',
      lines: [{ productId: P('p7'), qty: '10', unitPrice: '1290' }, { productId: P('p1'), qty: '20', unitPrice: '145' }, { productId: P('p9'), qty: '1', unitPrice: '300' }],
    });
    expect(r.status).toBe(201);
    so = r.body;
    const pf = await chai.get(`/api/purchase-orders/prefill/${so.no}`);
    expect(pf.status).toBe(200);
    expect(pf.body).toMatchObject({ source: { type: 'SO', no: so.no }, warehouseId: W('WH2'), vatMode: 'exc', skipped: 1 });
    // p7: 4 on hand in WH2, this order's own reservation does not count against itself → order 6; p1: 340 on hand → 0
    expect(pf.body.lines).toEqual([
      expect.objectContaining({ productId: P('p7'), sourceLineId: so.lines[0].id, orderedQty: '10', availableQty: '4', qty: '6', unitCost: '1050' }),
      expect.objectContaining({ productId: P('p1'), orderedQty: '20', availableQty: '340', qty: '0' }),
    ]);
    // the order's own reservation still counts for anyone else: a second order sees 4 − 10 (first order) = −6 → order all 3
    const so2 = await charoen.post('/api/sales/orders', { customerId: C('c1'), warehouseId: W('WH2'), vatMode: 'exc', lines: [{ productId: P('p7'), qty: '3', unitPrice: '1290' }] });
    expect((await chai.get(`/api/purchase-orders/prefill/${so2.body.no}`)).body.lines[0]).toMatchObject({ availableQty: '-6', qty: '3' });
    expect((await chai.get(`/api/purchase-orders/prefill/${so.no}`)).body.lines[0]).toMatchObject({ availableQty: '1', qty: '9' }); // and the first sees the second
  });

  it('stores the source; the sales order lists its purchase orders', async () => {
    const pf = (await chai.get(`/api/purchase-orders/prefill/${so.no}`)).body;
    const r = await chai.post('/api/purchase-orders', {
      vendorId: V('v2'), warehouseId: pf.warehouseId, sourceNo: so.no,
      lines: [{ productId: P('p7'), qty: pf.lines[0].qty, unitCost: pf.lines[0].unitCost, sourceLineId: pf.lines[0].sourceLineId }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ no: 'PO2610-0002', source: { type: 'SO', no: so.no } });
    expect(r.body.lines[0]).toMatchObject({ qty: '9', sourceLineId: so.lines[0].id, sourceQty: '10' });
    expect((await charoen.get(`/api/sales/orders/${so.no}`)).body.purchaseOrders).toEqual([{ no: 'PO2610-0002', status: 'open' }]);
    // a line that is not on the source document is refused
    const bad = await chai.post('/api/purchase-orders', { vendorId: V('v2'), warehouseId: W('WH2'), sourceNo: so.no, lines: [{ productId: P('p7'), qty: '1', unitCost: '1', sourceLineId: so.lines[1].id }] });
    expect(bad.status).toBe(400);
  });

  it('a quotation skips free-text lines', async () => {
    const q = await charoen.post('/api/sales/quotations', {
      customerId: C('c1'), vatMode: 'exc', status: 'sent',
      lines: [{ productId: P('p8'), qty: '20', unitPrice: '650' }, { name: 'ประตูไม้สั่งทำ', unitName: 'บาน', qty: '2', unitPrice: '4500' }],
    });
    expect(q.status).toBe(201);
    const pf = await chai.get(`/api/purchase-orders/prefill/${q.body.no}`);
    expect(pf.body).toMatchObject({ source: { type: 'QT' }, skipped: 1 });
    expect(pf.body.lines).toEqual([expect.objectContaining({ productId: P('p8'), orderedQty: '20', availableQty: '12', qty: '8' })]);
    const po = await chai.post('/api/purchase-orders', { vendorId: V('v3'), warehouseId: W('WH2'), sourceNo: q.body.no, lines: [{ productId: P('p8'), qty: '8', unitCost: '520', sourceLineId: pf.body.lines[0].sourceLineId }] });
    expect(po.status).toBe(201);
    expect((await charoen.get(`/api/sales/quotations/${q.body.no}`)).body.purchaseOrders).toEqual([{ no: po.body.no, status: 'open' }]);
  });
});

describe('receive against a PO', () => {
  let po: any;
  let gr2: string;
  it('partial receipt → partially received; links both ways', async () => {
    po = (await chai.get('/api/purchase-orders/PO2610-0001')).body;
    const before = await stockQty(env.pool, P('p4'), W('WH2'));
    const r = await receive(chai, 'PO-IV-1', po, [{ p: 'p4', qty: '4', poLineId: po.lines[0].id }]);
    expect(r.status).toBe(201);
    expect(await stockQty(env.pool, P('p4'), W('WH2'))).toBe(before + 4);
    po = (await chai.get('/api/purchase-orders/PO2610-0001')).body;
    expect(po.status).toBe('partial');
    expect(po.lines[0]).toMatchObject({ receivedQty: '4', remainingQty: '6' });
    expect(po.receipts).toEqual([{ no: r.body.no, date: expect.any(String), status: 'active' }]);
    expect((await chai.get(`/api/purchasing/receipts/${r.body.no}`)).body.poNos).toEqual(['PO2610-0001']);
  });

  it('refuses more than ordered, another vendor and lines of another PO', async () => {
    const over = await receive(chai, 'PO-IV-X', po, [{ p: 'p4', qty: '7', poLineId: po.lines[0].id }]);
    expect(over.status).toBe(400);
    expect(over.body.details.reason).toBe('PO_OVER_RECEIVE');
    expect((await receive(chai, 'PO-IV-X', po, [{ p: 'p4', qty: '1', poLineId: po.lines[0].id }], 'v2')).status).toBe(400);
    const other = (await chai.get('/api/purchase-orders/PO2610-0002')).body;
    expect((await receive(chai, 'PO-IV-X', po, [{ p: 'p7', qty: '1', poLineId: other.lines[0].id }])).status).toBe(400);
    expect((await env.pool.query(`select count(*)::int n from stock_docs where vendor_invoice_no = 'PO-IV-X'`)).rows[0].n).toBe(0);
  });

  it('full receipt (the box line in pieces) → received; nothing more can be received', async () => {
    const r = await receive(chai, 'PO-IV-2', po, [{ p: 'p4', qty: '6', poLineId: po.lines[0].id }, { p: 'p6', qty: '40', cost: '63', poLineId: po.lines[1].id }]);
    expect(r.status).toBe(201);
    gr2 = r.body.no;
    po = (await chai.get('/api/purchase-orders/PO2610-0001')).body;
    expect(po.status).toBe('received');
    expect(po.lines[1]).toMatchObject({ receivedQty: '2', remainingQty: '0' });
    const more = await receive(chai, 'PO-IV-3', po, [{ p: 'p4', qty: '1', poLineId: po.lines[0].id }]);
    expect(more.status).toBe(409);
  });

  it('voiding a GR rolls the PO back, takes the stock out and voids the AP bill', async () => {
    const before = await stockQty(env.pool, P('p6'), W('WH2'));
    const v = await chai.post(`/api/purchasing/receipts/${gr2}/void`, { reason: 'ผู้ขายส่งผิดรุ่น' });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ status: 'void', returnable: false, voided: { reason: 'ผู้ขายส่งผิดรุ่น' } });
    expect(await stockQty(env.pool, P('p6'), W('WH2'))).toBe(before - 40);
    expect((await env.pool.query(`select status from ap_bills where gr_no = $1`, [gr2])).rows[0].status).toBe('void');
    po = (await chai.get('/api/purchase-orders/PO2610-0001')).body;
    expect(po.status).toBe('partial');
    expect(po.lines.map((l: { remainingQty: string }) => l.remainingQty)).toEqual(['6', '2']);
    expect(po.receipts.map((x: { status: string }) => x.status)).toEqual(['active', 'void']);
    expect((await chai.post(`/api/purchasing/receipts/${gr2}/void`, { reason: 'ซ้ำ' })).status).toBe(409);
    const out = await env.pool.query(`select qty::text from stock_moves where doc_no = $1 and qty < 0 order by qty desc`, [gr2]);
    expect(out.rows.map((x) => x.qty)).toEqual(['-6.0000', '-40.0000']); // ledger stock-out at the lot, per line
    expect((await boy.post(`/api/purchasing/receipts/${po.receipts[0].no}/void`, { reason: 'x' })).status).toBe(403);
  });

  it('a GR whose goods were already used cannot be voided', async () => {
    const r = await receive(chai, 'PO-IV-4', po, [{ p: 'p6', qty: '1', unitIdx: 1, cost: '1260', poLineId: po.lines[1].id }]);
    expect(r.status).toBe(201);
    const lot = (await env.pool.query(`select lot_id from gr_lines where gr_no = $1`, [r.body.no])).rows[0].lot_id;
    await env.pool.query(`update stock_lots set remaining = remaining - 1 where id = $1`, [lot]); // stands in for a sale from that lot
    const v = await chai.post(`/api/purchasing/receipts/${r.body.no}/void`, { reason: 'ทดสอบ' });
    expect(v.status).toBe(409);
    expect(v.body.details.reason).toBe('GR_LOTS_USED');
    await env.pool.query(`update stock_lots set remaining = remaining + 1 where id = $1`, [lot]);
  });
});

describe('void and close rules', () => {
  it('a PO with an active GR cannot be voided; it can be closed (short shipment) and then receives nothing', async () => {
    const v = await chai.post('/api/purchase-orders/PO2610-0001/void', { reason: 'ไม่ต้องการแล้ว' });
    expect(v.status).toBe(409);
    expect(v.body.code).toBe('DOWNSTREAM_FIRST');
    expect(v.body.details.docs.length).toBe(2);
    expect((await chai.post('/api/purchase-orders/PO2610-0001/close', { reason: '' })).status).toBe(400);
    const c = await chai.post('/api/purchase-orders/PO2610-0001/close', { reason: 'ผู้ขายของหมด ส่งไม่ครบ' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'closed', closed: { reason: 'ผู้ขายของหมด ส่งไม่ครบ' } });
    const po = c.body;
    expect((await receive(chai, 'PO-IV-5', po, [{ p: 'p4', qty: '1', poLineId: po.lines[0].id }])).status).toBe(409);
    expect((await chai.post('/api/purchase-orders/PO2610-0001/close', { reason: 'อีกครั้ง' })).status).toBe(409);
    expect(await audits('PO2610-0001')).toEqual(['create', 'close']);
  });

  it('a PO without receipts is voided with a reason, once; a void PO cannot be closed', async () => {
    const v = await chai.post('/api/purchase-orders/PO2610-0002/void', { reason: 'ลูกค้ายกเลิกออเดอร์' });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ status: 'void', voided: { reason: 'ลูกค้ายกเลิกออเดอร์' } });
    expect((await chai.post('/api/purchase-orders/PO2610-0002/void', { reason: 'ซ้ำ' })).status).toBe(409);
    expect((await chai.post('/api/purchase-orders/PO2610-0002/close', { reason: 'x' })).status).toBe(409);
    expect(await audits('PO2610-0002')).toEqual(['create', 'void']);
    expect((await chai.get('/api/purchase-orders?status=void')).body.items.map((x: { no: string }) => x.no)).toEqual(['PO2610-0002']);
  });

  it('rows are never deleted', async () => {
    await expect(env.pool.query(`delete from purchase_orders`)).rejects.toThrow();
    await expect(env.pool.query(`delete from purchase_order_lines`)).rejects.toThrow();
  });
});
