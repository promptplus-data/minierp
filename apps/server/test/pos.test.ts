import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, lotsOf, openShift, saleBody, setupEnv, stockQty, type Client, type Env } from './helpers';

let env: Env;
let prae: Client;
let suda: Client;
let owner: Client;
let praeShift: string;
let sudaShift: string;

beforeAll(async () => {
  env = await setupEnv();
  prae = await login(env.app, 'prae');
  suda = await login(env.app, 'suda');
  owner = await login(env.app, 'charoen');
  praeShift = await openShift(prae);
  sudaShift = await openShift(suda, '500.00', 'POS-2');
});
afterAll(async () => { await env.close(); });

describe('POS sale (M07)', () => {
  it('VAT-inclusive ABB: totals, document number, FIFO COGS across two lots', async () => {
    // p1 in WH1: lot 25 @ 118.34 (older) + lot 37 @ 124.44
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, praeShift, [{ p: 'p1', qty: '30', price: '145.00' }], '4350.00'));
    expect(r.status).toBe(201);
    expect(r.body.no).toBe('ABB2610-0001');
    expect(r.body.type).toBe('ABB');
    expect(r.body.vatMode).toBe('inc');
    expect(r.body.totals).toEqual({ gross: '4350.00', lineDisc: '0.00', billDisc: '0.00', base7: '4065.42', exempt: '0.00', vat: '284.58', total: '4350.00' });
    expect(r.body.lines[0].cogs).toBeNull(); // cashier lacks data.cost

    const asOwner = await owner.get(`/api/sales/docs/${r.body.no}`);
    expect(asOwner.body.lines[0].cogs).toBe('3580.70'); // 25 × 118.34 + 5 × 124.44
    expect(await lotsOf(env.pool, env.seed.products.p1!, env.seed.warehouses.WH1!)).toMatchObject([
      { remaining: '0.0000', unit_cost: '118.3400' },
      { remaining: '32.0000', unit_cost: '124.4400' },
    ]);
    const ml = await env.pool.query(
      `select ml.qty::text, ml.unit_cost::text from stock_move_lots ml join stock_moves m on m.id = ml.move_id where m.doc_no = $1 order by ml.unit_cost`, [r.body.no]);
    expect(ml.rows).toEqual([{ qty: '25.0000', unit_cost: '118.3400' }, { qty: '5.0000', unit_cost: '124.4400' }]);
  });

  it('pack unit sells base quantity (1 พาเลท = 40 ถุง) and services do not touch stock', async () => {
    const before = await stockQty(env.pool, env.seed.products.p3!, env.seed.warehouses.WH1!);
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, praeShift, [
      { p: 'p3', qty: '1', price: '4800.00', unitIdx: 1 }, // 1 พาเลท = 200 ก้อน × 24
      { p: 'p9', qty: '1', price: '300.00' },
    ], '5100.00'));
    expect(r.status).toBe(201);
    expect(await stockQty(env.pool, env.seed.products.p3!, env.seed.warehouses.WH1!)).toBe(before - 200);
    expect(r.body.lines[1].cogs).toBeNull();
  });

  it('requires an open shift owned by the seller (BR-20)', async () => {
    const boy = await login(env.app, 'boy');
    const none = await boy.post('/api/sales/pos', saleBody(env.seed, randomUUID(), [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('SHIFT_REQUIRED');
    const someoneElses = await boy.post('/api/sales/pos', saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00'));
    expect(someoneElses.body.code).toBe('SHIFT_REQUIRED');
  });

  it('idempotent retry returns the original bill (200), never a second one', async () => {
    const body = saleBody(env.seed, praeShift, [{ p: 'p6', qty: '2', price: '89.00' }], '178.00');
    const before = await stockQty(env.pool, env.seed.products.p6!, env.seed.warehouses.WH1!);
    const a = await prae.post('/api/sales/pos', body);
    const b = await prae.post('/api/sales/pos', body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.no).toBe(a.body.no);
    expect(await stockQty(env.pool, env.seed.products.p6!, env.seed.warehouses.WH1!)).toBe(before - 2);
    const n = await env.pool.query(`select count(*)::int n from docs where idempotency_key = $1`, [body.idempotencyKey]);
    expect(n.rows[0].n).toBe(1);
  });

  it('concurrent idempotent retries also yield one bill', async () => {
    const body = saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00');
    const [a, b] = await Promise.all([prae.post('/api/sales/pos', body), prae.post('/api/sales/pos', body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.no).toBe(b.body.no);
  });

  it('payments must equal the total', async () => {
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '89.00' }], '80.00'));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION');
  });

  it('full tax invoice needs a customer with a tax ID', async () => {
    const noTax = await prae.post('/api/sales/pos', saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00', { docKind: 'full', customerId: env.seed.customers.c3 }));
    expect(noTax.status).toBe(400);
    const ok = await prae.post('/api/sales/pos', saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '89.00' }], '89.00', { docKind: 'full', customerId: env.seed.customers.c1 }));
    expect(ok.status).toBe(201);
    expect(ok.body.no).toBe('INV2610-0001');
    expect(ok.body.customer.name).toBe('หจก. รุ่งเรืองก่อสร้าง');
  });
});

describe('discount cap (OQ-10)', () => {
  it('cashier (cap 0%) needs a manager/owner PIN for any discount', async () => {
    const body = () => saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '89.00' }], '84.00', { billDiscount: '5' });
    const blocked = await prae.post('/api/sales/pos', body());
    expect(blocked.status).toBe(403);
    expect(blocked.body.details).toMatchObject({ need: 'discountApproval', cap: 0 });
    const badPin = await prae.post('/api/sales/pos', { ...body(), discountApproval: { approverUserId: env.seed.users.suda, pin: '9999' } });
    expect(badPin.body.details.approvalError).toBe('BAD_PIN');
    const notApprover = await prae.post('/api/sales/pos', { ...body(), discountApproval: { approverUserId: env.seed.users.boy, pin: '1234' } });
    expect(notApprover.body.details.approvalError).toBe('ROLE_NOT_ALLOWED');
    const ok = await prae.post('/api/sales/pos', { ...body(), discountApproval: { approverUserId: env.seed.users.suda, pin: '1234' } });
    expect(ok.status).toBe(201);
    expect(ok.body.totals.billDisc).toBe('5.00');
    expect(ok.body.totals.total).toBe('84.00');
  });

  it('cashier cannot change a unit price without approval', async () => {
    const r = await prae.post('/api/sales/pos', saleBody(env.seed, praeShift, [{ p: 'p6', qty: '1', price: '80.00' }], '80.00'));
    expect(r.status).toBe(403);
    expect(r.body.details.priceChanged).toBe(true);
  });
});

describe('below cost (BR-16)', () => {
  // p1 at 120 inc VAT = 112.15 ex VAT per bag, next FIFO lot in WH1 costs 124.44
  const body = () => saleBody(env.seed, sudaShift, [{ p: 'p1', qty: '1', price: '120.00' }], '120.00');

  it('blocks a manager without approval and lists the lines', async () => {
    const r = await suda.post('/api/sales/pos', body());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BELOW_COST');
    expect(r.body.details.lines[0]).toMatchObject({ productId: env.seed.products.p1, sell: '112.15', cost: '124.44' });
  });

  it('rejects a manager PIN (owner only), and nobody approves their own sale', async () => {
    const bySuda = { ...saleBody(env.seed, praeShift, [{ p: 'p1', qty: '1', price: '120.00' }], '120.00'), discountApproval: { approverUserId: env.seed.users.suda, pin: '1234' } };
    const r = await prae.post('/api/sales/pos', { ...bySuda, belowCostApproval: { approverUserId: env.seed.users.suda, pin: '1234' } });
    expect(r.status).toBe(409);
    expect(r.body.details.approvalError).toBe('ROLE_NOT_ALLOWED');
    const self = await suda.post('/api/sales/pos', { ...body(), belowCostApproval: { approverUserId: env.seed.users.suda, pin: '1234' } });
    expect(self.body.details.approvalError).toBe('SELF_APPROVAL');
  });

  it('rejects a wrong owner PIN', async () => {
    const r = await suda.post('/api/sales/pos', { ...body(), belowCostApproval: { approverUserId: env.seed.users.charoen, pin: '0000' } });
    expect(r.body.details.approvalError).toBe('BAD_PIN');
  });

  it('allows it with the owner PIN and logs the approval', async () => {
    const r = await suda.post('/api/sales/pos', { ...body(), belowCostApproval: { approverUserId: env.seed.users.charoen, pin: '1234' } });
    expect(r.status).toBe(201);
    const log = await env.pool.query(`select detail from audit_log where object = 'below-cost' order by chain_seq desc limit 1`);
    expect(log.rows[0].detail).toContain('คุณเจริญ ศรีสุข');
  });

  it('owner selling himself is allowed but logged', async () => {
    const ownerShift = await openShift(owner, '0.00', 'POS-3');
    const r = await owner.post('/api/sales/pos', saleBody(env.seed, ownerShift, [{ p: 'p1', qty: '1', price: '120.00' }], '120.00'));
    expect(r.status).toBe(201);
    const log = await env.pool.query(`select user_name, detail from audit_log where object = 'below-cost' order by chain_seq desc limit 1`);
    expect(log.rows[0].detail).toContain('ยืนยันเอง');
  });
});
