/** POS (M07): live cost preview, manager-override approval token, discount reasons, bill note, credit sale into AR. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, openShift, saleBody, setupEnv, type Client, type Env } from './helpers';

let env: Env;
let prae: Client;
let suda: Client;
let owner: Client;
let praeShift: string;
let sudaShift: string;
const R = { discountReason: { code: 'regular' } };

beforeAll(async () => {
  env = await setupEnv();
  prae = await login(env.app, 'prae');
  suda = await login(env.app, 'suda');
  owner = await login(env.app, 'charoen');
  praeShift = await openShift(prae);
  sudaShift = await openShift(suda, '500.00', 'POS-2');
});
afterAll(async () => { await env.close(); });

const preview = (c: Client, lines: { p: string; qty: string; price: string; discount?: { kind: 'pct' | 'amt'; value: string } }[], billDiscount = '0') =>
  c.post('/api/sales/pos/preview', {
    warehouseId: env.seed.warehouses.WH1, billDiscount,
    lines: lines.map((l) => ({ productId: env.seed.products[l.p], unitIdx: 0, qty: l.qty, unitPrice: l.price, ...(l.discount ? { discount: l.discount } : {}) })),
  });
const approve = (c: Client, shiftId: string, body: Record<string, unknown>, approver = 'suda') =>
  c.post('/api/sales/pos/approvals', { shiftId, approval: { approverUserId: env.seed.users[approver], pin: '1234' }, ...body });

describe('cost preview (POST /api/sales/pos/preview)', () => {
  it('cashier gets the below-cost flag only, never cost numbers; nothing is written or locked', async () => {
    // p1 at 120 inc VAT = 112.15 ex VAT; oldest WH1 lot costs 118.34
    const r = await preview(prae, [{ p: 'p1', qty: '1', price: '120.00' }, { p: 'p6', qty: '2', price: '89.00' }]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ showCost: false, belowCost: true, lines: [{ belowCost: true }, { belowCost: false }], bundles: [] });
    expect(JSON.stringify(r.body)).not.toMatch(/cost"?:\s*"/);
  });

  it('manager sees FIFO cost, revenue ex VAT, margin per line and the bill profit', async () => {
    const r = await preview(suda, [{ p: 'p1', qty: '30', price: '145.00' }]);
    expect(r.body.showCost).toBe(true);
    // 30 × 145 / 1.07 = 4065.42 revenue; FIFO 25 × 118.34 + 5 × 124.44 = 3580.70
    expect(r.body.lines[0]).toMatchObject({ belowCost: false, revenue: '4065.42', cost: '3580.70', margin: '484.72', marginPct: '11.92' });
    expect(r.body).toMatchObject({ revenue: '4065.42', cost: '3580.70', profit: '484.72' });
    const lots = await env.pool.query(`select sum(remaining)::text s from stock_lots where product_id = $1 and warehouse_id = $2`, [env.seed.products.p1, env.seed.warehouses.WH1]);
    expect(lots.rows[0].s).toBe('62.0000');
  });

  it('a bill discount that pushes a line under cost raises the flag', async () => {
    const ok = await preview(prae, [{ p: 'p1', qty: '1', price: '145.00' }]);
    expect(ok.body.lines[0].belowCost).toBe(false);
    const low = await preview(prae, [{ p: 'p1', qty: '1', price: '145.00' }], '30');
    expect(low.body.lines[0].belowCost).toBe(true);
  });
});

describe('manager override token (POST /api/sales/pos/approvals)', () => {
  const body = (disc: string, extra: Record<string, unknown> = {}) =>
    saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '89.00', discount: { kind: 'amt', value: disc } }], (89 - Number(disc)).toFixed(2), { ...R, ...extra });

  it('verifies the PIN once at entry; the sale carries the token; raising the discount re-asks', async () => {
    const bad = await prae.post('/api/sales/pos/approvals', { shiftId: praeShift, approval: { approverUserId: env.seed.users.suda, pin: '0000' }, maxAmount: '10', maxPct: '11.2360' });
    expect(bad.status).toBe(403);
    expect(bad.body.details.approvalError).toBe('BAD_PIN');
    const t = await approve(prae, praeShift, { maxAmount: '10.00', maxPct: '11.2360', reason: { code: 'defect', text: 'กล่องบุบ' } });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ approver: { name: 'คุณสุดา ศรีสุข' }, maxAmount: '10.00' });
    const more = await prae.post('/api/sales/pos', body('12', { discountToken: t.body.token }));
    expect(more.status).toBe(403);
    expect(more.body.details).toMatchObject({ need: 'discountApproval', tokenError: 'EXCEEDS_APPROVAL' });
    const ok = await prae.post('/api/sales/pos', body('8', { discountToken: t.body.token }));
    expect(ok.status).toBe(201);
    expect(ok.body.discReason).toBe('ลูกค้าประจำ');
    const audit = await env.pool.query(`select detail from audit_log where object = 'discount' and action = 'approve' order by at desc limit 2`);
    expect(audit.rows.map((x) => x.detail).join('|')).toMatch(/อนุมัติโดย คุณสุดา/);
    // single use
    const again = await prae.post('/api/sales/pos', body('8', { discountToken: t.body.token }));
    expect(again.body.details.tokenError).toBe('EXPIRED');
  });

  it('self-approval is forbidden; the approver cannot exceed their own cap; tokens are bound to the caller', async () => {
    const self = await approve(suda, sudaShift, { maxAmount: '50', maxPct: '30' }, 'suda');
    expect(self.body.details.approvalError).toBe('SELF_APPROVAL');
    const overCap = await approve(prae, praeShift, { maxAmount: '30', maxPct: '30' }, 'suda'); // manager cap 20 %
    expect(overCap.body.details.approvalError).toBe('APPROVER_CAP');
    const byOwner = await approve(prae, praeShift, { maxAmount: '30', maxPct: '33.7079' }, 'charoen');
    expect(byOwner.status).toBe(201);
    const stolen = await suda.post('/api/sales/pos', saleBody(env.seed, sudaShift, [{ p: 'p6', qty: '1', price: '89.00', discount: { kind: 'amt', value: '30' } }], '59.00', { ...R, discountToken: byOwner.body.token }));
    expect(stolen.body.details.tokenError).toBe('EXPIRED');
  });

  it('covers a changed price at or above the approved price', async () => {
    const t = await approve(prae, praeShift, { maxAmount: '0', maxPct: '0', prices: [{ productId: env.seed.products.p6, unitIdx: 0, price: '80.00' }] });
    expect(t.status).toBe(201);
    const low = await prae.post('/api/sales/pos', saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '79.00' }], '79.00', { ...R, discountToken: t.body.token }));
    expect(low.body.details).toMatchObject({ tokenError: 'EXCEEDS_APPROVAL', why: 'PRICE' });
    const ok = await prae.post('/api/sales/pos', saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '82.00' }], '82.00', { ...R, discountToken: t.body.token }));
    expect(ok.status).toBe(201);
  });

  it('a discount or changed price needs a reason, for every role; "other" needs text', async () => {
    const s1 = await suda.post('/api/sales/pos', saleBody(env.seed, sudaShift, [{ p: 'p6', qty: '1', price: '89.00' }], '84.00', { billDiscount: '5' }));
    expect(s1.status).toBe(400);
    expect(s1.body.details.field).toBe('discountReason');
    const other = await suda.post('/api/sales/pos', saleBody(env.seed, sudaShift, [{ p: 'p6', qty: '1', price: '89.00' }], '84.00', { billDiscount: '5', discountReason: { code: 'other' } }));
    expect(other.status).toBe(400);
    const ok = await suda.post('/api/sales/pos', saleBody(env.seed, sudaShift, [{ p: 'p6', qty: '1', price: '89.00' }], '84.00', { billDiscount: '5', discountReason: { code: 'other', text: 'ลูกค้าเก่า' }, note: 'ส่งของบ่ายนี้' }));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ discReason: 'อื่นๆ: ลูกค้าเก่า', note: 'ส่งของบ่ายนี้' });
    const audit = await env.pool.query(`select detail from audit_log where ref = $1 and action = 'create'`, [ok.body.no]);
    expect(audit.rows[0].detail).toMatch(/เหตุผล: อื่นๆ: ลูกค้าเก่า · หมายเหตุ: ส่งของบ่ายนี้/);
  });
});

describe('credit sale เงินเชื่อ', () => {
  const credit = (customer: string | undefined, total: string, extra: Record<string, unknown> = {}) => ({
    ...saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '89.00' }], total),
    ...(customer ? { customerId: env.seed.customers[customer] } : {}),
    payments: [{ method: 'credit', amount: total }], ...extra,
  });

  it('needs a named customer on credit terms, paid fully on credit', async () => {
    expect((await prae.post('/api/sales/pos', credit(undefined, '89.00'))).body.details.field).toBe('customerId');
    const cash = await prae.post('/api/sales/pos', credit('c3', '89.00'));
    expect(cash.status).toBe(400);
    expect(cash.body.details.reason).toBe('CASH_TERM');
    const split = await prae.post('/api/sales/pos', { ...credit('c2', '89.00'), payments: [{ method: 'credit', amount: '50.00' }, { method: 'cash', amount: '39.00' }] });
    expect(split.body.details.field).toBe('payments');
  });

  it('creates a receivable shown in AR, settled by an AR receipt, excluded from the shift cash', async () => {
    const before = (await prae.get('/api/shifts/current')).body;
    const r = await prae.post('/api/sales/pos', credit('c2', '89.00'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'ABB', arBalance: '89.00', payments: [{ method: 'credit', amount: '89.00' }] });
    const after = (await prae.get('/api/shifts/current')).body;
    expect(after.cashSales).toBe(before.cashSales);
    expect(after.expected).toBe(before.expected);
    expect(after.byMethod.credit).toBeUndefined();
    expect(after.creditSales).toBe('89.00');
    const ar = await owner.get(`/api/ar/invoices?customerId=${env.seed.customers.c2}`);
    expect(ar.body.items.map((x: { no: string }) => x.no)).toContain(r.body.no);
    expect(ar.body.items.find((x: { no: string }) => x.no === r.body.no)).toMatchObject({ arBalance: '89.00', dueDate: '2026-10-31' });
    const rc = await owner.post('/api/ar/receipts', { customerId: env.seed.customers.c2, method: 'cash', lines: [{ invoiceNo: r.body.no, amount: '89.00' }] });
    expect(rc.status).toBe(201);
    expect((await owner.get(`/api/sales/docs/${r.body.no}`)).body.arBalance).toBe('0.00');
    // BR-22: the receipt goes first
    const v = await owner.post(`/api/sales/docs/${r.body.no}/void`, { reason: 'ทดสอบ' });
    expect(v.body.code).toBe('DOWNSTREAM_FIRST');
  });

  it('over the credit limit: a cashier needs an owner / manager PIN; the manager self-approves (logged)', async () => {
    await env.pool.query(`update customers set credit_limit = 100 where id = $1`, [env.seed.customers.c1]);
    const total = '178.00';
    const body = () => ({ ...credit('c1', total), lines: [{ productId: env.seed.products.p6, unitIdx: 0, qty: '2', unitPrice: '89.00' }] });
    const blocked = await prae.post('/api/sales/pos', body());
    expect(blocked.status).toBe(403);
    expect(blocked.body.details).toMatchObject({ need: 'creditApproval', limit: '100.00', over: true });
    const ok = await prae.post('/api/sales/pos', { ...body(), creditApproval: { approverUserId: env.seed.users.suda, pin: '1234' } });
    expect(ok.status).toBe(201);
    const bySuda = await suda.post('/api/sales/pos', { ...body(), shiftId: sudaShift });
    expect(bySuda.status).toBe(201);
    const audit = await env.pool.query(`select detail from audit_log where object = 'credit-limit' order by at`);
    expect(audit.rows.map((x) => x.detail).join('|')).toMatch(/อนุมัติโดย คุณสุดา ศรีสุข \(ผู้มีสิทธิ์อนุมัติ\)/);
  });
});

describe('FIFO stock cut at sale', () => {
  it('a sale cuts the oldest lot first and records COGS from the lots consumed', async () => {
    const key = randomUUID();
    const r = await suda.post('/api/sales/pos', { ...saleBody(env.seed, sudaShift, [{ p: 'p1', qty: '2', price: '145.00' }], '290.00'), idempotencyKey: key });
    expect(r.status).toBe(201);
    const ml = await env.pool.query(
      `select ml.qty::text, ml.unit_cost::text from stock_move_lots ml join stock_moves m on m.id = ml.move_id where m.doc_no = $1 order by ml.unit_cost`, [r.body.no]);
    expect(ml.rows).toEqual([{ qty: '2.0000', unit_cost: '118.3400' }]);
    expect(r.body.lines[0].cogs).toBe('236.68');
  });
});
