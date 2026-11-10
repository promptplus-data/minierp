/** REQ-M08-01/02/03/08/09, BR-05 price resolution, BR-08 credit approval, BR-16 below cost, BR-22 void order. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apv, ok, pin, setupSales, type SalesEnv } from './sales-helpers';

let env: SalesEnv;
let P: Record<string, string>;
let C: Record<string, string>;
beforeAll(async () => {
  env = await setupSales();
  P = env.seed.products;
  C = env.seed.customers;
});
afterAll(async () => { await env.close(); });

const quoteBody = (extra: Record<string, unknown> = {}) => ({
  customerId: C.c2, attn: 'คุณวิชัย',
  lines: [
    { productId: P.p1!, qty: '50', unitPrice: '130' },
    { name: 'ประตูไม้สักบานคู่', unitName: 'ชุด', qty: '1', unitPrice: '8500' },
  ],
  priceApproval: apv(env),
  ...extra,
});

describe('quotations', () => {
  it('saves free-text lines, a 15-day validity, exc VAT totals, no stock; price below list and below cost need approvals', async () => {
    const before = await env.pool.query(`select count(*)::int n from stock_moves`);
    const lines = [{ productId: P.p1!, qty: '50', unitPrice: '1' }, { name: 'ประตูไม้สักบานคู่', unitName: 'ชุด', qty: '1', unitPrice: '8500' }];
    const r1 = await env.boy.post('/api/sales/quotations', quoteBody({ lines, priceApproval: undefined }));
    expect(r1.status).toBe(403);
    expect(r1.body.details).toMatchObject({ need: 'priceApproval', priceChanged: true, lines: [{ line: 1, unitPrice: '1.00', listPrice: '130.84' }] });
    const r2 = await env.boy.post('/api/sales/quotations', quoteBody({ lines }));
    expect(r2.status).toBe(409); // BR-16 now also on quotations (free-text lines have no cost)
    expect(r2.body.code).toBe('BELOW_COST');
    const q = await ok(env.boy.post('/api/sales/quotations', quoteBody({ lines, belowCostApproval: pin(env, 'charoen') })), 201);
    expect(q.priceApproval.detail).toContain('เหตุผล: ราคาพิเศษ');
    expect(q.belowCostApproval.detail).toContain('คุณเจริญ');
    expect(q.lines[0]).toMatchObject({ listPrice: '130.84', priceSource: 'groupList', priceRef: 'PL-WHOLE', unitCost: null }); // sales role sees no cost
    expect(q.lines[1]).toMatchObject({ priceSource: 'manual' });
    expect(q.profit).toBeNull();
    const asOwner = await ok(env.owner.get(`/api/sales/quotations/${q.no}`));
    expect(asOwner.profit).not.toBeNull();
    expect(Number(asOwner.lines[0].profit)).toBeLessThan(0);
    expect(q.no).toMatch(/^QT2610-/);
    expect(q.validUntil).toBe('2026-11-10');
    expect(q.vatMode).toBe('exc');
    expect(q.lines[1]).toMatchObject({ productId: null, free: true, name: 'ประตูไม้สักบานคู่', unitName: 'ชุด' });
    expect(q.totals).toMatchObject({ base7: '8550.00', vat: '598.50', total: '9148.50' }); // 50 × 1 below cost: quotations are not checked
    expect(q.status).toBe('draft');
    expect((await env.pool.query(`select count(*)::int n from stock_moves`)).rows[0].n).toBe(before.rows[0].n);
  });

  it('keeps every revision until converted and tracks the status', async () => {
    const q = await ok(env.boy.post('/api/sales/quotations', quoteBody()), 201);
    const r2 = await ok(env.boy.patch(`/api/sales/quotations/${q.no}`, quoteBody({ lines: [{ productId: P.p1!, qty: '60', unitPrice: '130' }] })));
    expect(r2.revision).toBe(2);
    expect(r2.lines).toHaveLength(1);
    const revs = await env.pool.query(`select r.revision from sales_quote_revisions r join sales_quotes q on q.id = r.quote_id where q.no = $1 order by r.revision`, [q.no]);
    expect(revs.rows.map((x) => x.revision)).toEqual([1, 2]);
    expect((await ok(env.boy.post(`/api/sales/quotations/${q.no}/status`, { status: 'sent' }))).status).toBe('sent');
    const list = await ok(env.boy.get(`/api/sales/quotations?customerId=${C.c2}&status=open`));
    expect(list.items.map((x: { no: string }) => x.no)).toContain(q.no);
  });

  it('a past validity shows as expired and cannot be sent', async () => {
    const q = await ok(env.boy.post('/api/sales/quotations', quoteBody({ date: '2026-09-01', validUntil: '2026-09-16' })), 201);
    expect(q.status).toBe('expired');
    expect((await env.boy.post(`/api/sales/quotations/${q.no}/status`, { status: 'sent' })).status).toBe(409);
  });

  it('cashier cannot create quotations', async () => {
    expect((await env.prae.post('/api/sales/quotations', quoteBody())).status).toBe(403);
  });
});

describe('BR-05 price resolution', () => {
  const price = (customer: string, product: string, qty: string, unitIdx = 0) =>
    ok(env.boy.get(`/api/sales/price?customerId=${customer}&productId=${product}&qty=${qty}&unitIdx=${unitIdx}&vatMode=inc`));

  it('customer list → group list by quantity → retail', async () => {
    expect(await price(C.c1!, P.p1!, '10')).toMatchObject({ unitPrice: '138.00', source: 'customerList', ref: 'PL-C00001' });
    expect(await price(C.c1!, P.p1!, '1', 1)).toMatchObject({ unitPrice: '5440.00', source: 'customerList' });
    expect(await price(C.c2!, P.p6!, '10')).toMatchObject({ unitPrice: '84.00', source: 'groupList', ref: 'PL-WHOLE' });
    expect(await price(C.c2!, P.p6!, '200')).toMatchObject({ unitPrice: '80.00', source: 'groupList' });
    // ร้านวัสดุบ้านนา has a sent quotation with กระเบื้องลอนคู่ at 45.79 before VAT: the quotation wins (step 1)
    expect(await price(C.c2!, P.p2!, '10')).toMatchObject({ unitPrice: '49.00', source: 'quote', ref: env.seeded.quotes.bannaa });
    expect(await price(C.c3!, P.p2!, '10')).toEqual({ unitPrice: '52.00', source: 'retail', ref: null, retailPrice: '52.00' });
    // a quotation does not take another quotation's price (BR-05 for quotations starts at the price lists)
    expect(await ok(env.boy.get(`/api/sales/price?customerId=${C.c2}&productId=${P.p2}&qty=10&vatMode=inc&doc=quote`))).toMatchObject({ unitPrice: '49.00', source: 'groupList', ref: 'PL-WHOLE' });
    expect(await price(C.c2!, P.p4!, '1')).toMatchObject({ unitPrice: '210.00', source: 'retail' });
  });

  it('a valid sent quotation wins over the price lists; exc documents get the price before VAT', async () => {
    const q = await ok(env.boy.post('/api/sales/quotations', { customerId: C.c1, vatMode: 'inc', status: 'sent', lines: [{ productId: P.p1!, qty: '10', unitPrice: '133.75' }], priceApproval: apv(env) }), 201);
    expect(await price(C.c1!, P.p1!, '5')).toMatchObject({ unitPrice: '133.75', source: 'quote', ref: q.no });
    const exc = await ok(env.boy.get(`/api/sales/price?customerId=${C.c3}&productId=${P.p1}&qty=1&vatMode=exc`));
    expect(exc.unitPrice).toBe('135.51'); // 145 / 1.07
  });

  it('price lists are maintained with data.master only and validated', async () => {
    const body = { name: 'ผู้รับเหมา', kind: 'group', group: 'contr', items: [{ productId: P.p3!, minQty: '0', price: '23' }, { productId: P.p3!, minQty: '1000', price: '22' }] };
    expect((await env.boy.post('/api/sales/price-lists', body)).status).toBe(403);
    const pl = await ok(env.owner.post('/api/sales/price-lists', body), 201);
    expect(pl.code).toMatch(/^PL\d{3}$/);
    expect(pl.items[1]).toMatchObject({ sku: 'SCG-AAC-75', minQty: '1000', price: '22' });
    expect((await env.owner.post('/api/sales/price-lists', { ...body, items: [body.items[0], body.items[0]] })).status).toBe(400);
    const off = await ok(env.owner.patch(`/api/sales/price-lists/${pl.id}`, { ...body, active: false }));
    expect(off.active).toBe(false);
    expect((await ok(env.boy.get(`/api/sales/price?customerId=${C.c1}&productId=${P.p3}&qty=5&vatMode=inc`))).source).toBe('retail');
  });
});

describe('sales orders', () => {
  it('REQ-M08-09: a quotation with free-text lines converts only after every line is mapped to a product', async () => {
    const qt = env.seeded.quotes.bannaa!;
    const q = await ok(env.boy.get(`/api/sales/quotations/${qt}`));
    const [l1, l2, free] = q.lines;
    expect(free.free).toBe(true);
    const r = await env.boy.post('/api/sales/orders', {
      customerId: C.c2, quoteNo: qt,
      lines: [{ productId: P.p1!, qty: '100', unitPrice: l1.unitPrice, quoteLineId: l1.id }, { productId: P.p2!, qty: '300', unitPrice: l2.unitPrice, quoteLineId: l2.id }, { qty: '1', unitPrice: '8500', quoteLineId: free.id }],
    });
    expect(r.status).toBe(400);
    const so = await ok(env.boy.post('/api/sales/orders', {
      customerId: C.c2, quoteNo: qt,
      lines: [{ productId: P.p1!, qty: '100', unitPrice: l1.unitPrice, quoteLineId: l1.id }, { productId: P.p2!, qty: '300', unitPrice: l2.unitPrice, quoteLineId: l2.id }, { productId: P.p7!, qty: '1', unitPrice: '8500', quoteLineId: free.id }],
    }), 201);
    expect(so.quoteNo).toBe(qt);
    expect(so.vatMode).toBe('exc');
    expect(so.term).toEqual({ t: 'eom' });
    const after = await ok(env.boy.get(`/api/sales/quotations/${qt}`));
    expect(after.status).toBe('accepted');
    expect(after.editable).toBe(false);
    expect(after.orders.map((o: { no: string }) => o.no)).toEqual([so.no]);
    expect((await env.boy.patch(`/api/sales/quotations/${qt}`, quoteBody())).status).toBe(409);
    // BR-22: the quotation cannot be voided while the order is active
    expect((await env.owner.post(`/api/sales/quotations/${qt}/void`, { reason: 'x' })).status).toBe(409);
  });

  it('BR-16: below-cost lines need the owner, never the manager', async () => {
    const body = { customerId: C.c1, term: { t: 'cash' }, lines: [{ productId: P.p1!, qty: '10', unitPrice: '100' }], priceApproval: apv(env) };
    const r = await env.boy.post('/api/sales/orders', body);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BELOW_COST');
    expect(r.body.details.lines[0]).not.toHaveProperty('cost'); // sales role cannot see cost
    expect((await env.boy.post('/api/sales/orders', { ...body, belowCostApproval: pin(env, 'suda') })).status).toBe(409);
    const so = await ok(env.boy.post('/api/sales/orders', { ...body, belowCostApproval: pin(env, 'charoen') }), 201);
    expect(so.belowCostApproval.detail).toContain('คุณเจริญ');
  });

  it('BR-08: over the credit limit stops for approval and records the approver', async () => {
    // c2 limit 80,000; an order of 100,000 is over
    const body = { customerId: C.c2, lines: [{ productId: P.p7!, qty: '80', unitPrice: '1250' }] };
    const r = await env.boy.post('/api/sales/orders', body);
    expect(r.status).toBe(403);
    expect(r.body.details).toMatchObject({ need: 'creditApproval', limit: '80000.00', over: true });
    expect(r.body.details.after).toBe('107000.00');
    const so = await ok(env.boy.post('/api/sales/orders', { ...body, creditApproval: pin(env, 'suda') }), 201);
    expect(so.creditApproval.by).toBe('คุณสุดา ศรีสุข');
    expect(so.creditApproval.detail).toContain('เกินวงเงิน');
    // the manager approves her own order without a PIN (logged)
    const own = await ok(env.suda.post('/api/sales/orders', body), 201);
    expect(own.creditApproval.detail).toContain('ผู้มีสิทธิ์อนุมัติ');
    // cash term: no credit check
    await ok(env.boy.post('/api/sales/orders', { ...body, term: { t: 'cash' } }), 201);
  });

  it('BR-08: overdue bills need approval even within the limit; default limit 50,000 for a customer without one', async () => {
    await env.pool.query(`update customers set term = '{"t":"days","x":30}' where id = $1`, [C.c3]);
    const credit = await ok(env.boy.get(`/api/sales/customers/${C.c3}/credit`));
    expect(credit.limit).toBe('50000.00');
    const r = await env.boy.post('/api/sales/orders', { customerId: C.c3, lines: [{ productId: P.p7!, qty: '40', unitPrice: '1250' }] });
    expect(r.status).toBe(403);
    expect(r.body.details.limit).toBe('50000.00');
  });

  it('a cashier cannot create sales orders; voiding an order with no delivery keeps its number', async () => {
    expect((await env.prae.post('/api/sales/orders', { customerId: C.c1, lines: [{ productId: P.p1!, qty: '1', unitPrice: '140' }] })).status).toBe(403);
    const so = await ok(env.boy.post('/api/sales/orders', { customerId: C.c1, lines: [{ productId: P.p1!, qty: '1', unitPrice: '140' }] }), 201);
    expect((await env.boy.post(`/api/sales/orders/${so.no}/void`, { reason: 'ลูกค้ายกเลิก' })).status).toBe(403); // 'apv' needs a PIN
    const v = await ok(env.boy.post(`/api/sales/orders/${so.no}/void`, { reason: 'ลูกค้ายกเลิก', ...pin(env) }));
    expect(v.status).toBe('void');
    expect(v.voided.reason).toBe('ลูกค้ายกเลิก');
    const audit = await env.pool.query(`select detail from audit_log where ref = $1 and action = 'void'`, [so.no]);
    expect(audit.rows[0].detail).toContain('อนุมัติโดย คุณสุดา');
  });
});
