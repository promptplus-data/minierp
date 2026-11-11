/** ของแถม lines on sales documents: QT → SO → DO → INV keep the flag at price 0; no price / below-cost approval; audited. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ok, setupSales, type SalesEnv } from './sales-helpers';

let env: SalesEnv;
let P: Record<string, string>;
let C: Record<string, string>;
let WH2: string;
beforeAll(async () => {
  env = await setupSales();
  P = env.seed.products;
  C = env.seed.customers;
  WH2 = env.seed.warehouses.WH2!;
});
afterAll(async () => { await env.close(); });

describe('ของแถม through QT → SO → DO → INV', () => {
  const s: Record<string, any> = {};
  it('a salesperson adds a free line to a quotation: price forced to 0, no approval, total unchanged', async () => {
    const p1 = await ok(env.boy.get(`/api/sales/price?customerId=${C.c1}&productId=${P.p1}&qty=100&vatMode=exc&doc=quote`));
    const q = await ok(env.boy.post('/api/sales/quotations', {
      customerId: C.c1, vatMode: 'exc', status: 'sent',
      lines: [{ productId: P.p1!, qty: '100', unitPrice: p1.unitPrice }, { productId: P.p6!, qty: '2', unitPrice: '89', giveaway: true }],
    }), 201);
    expect(q.lines[1]).toMatchObject({ giveaway: true, unitPrice: '0', net: '0.00', free: false });
    expect(q.priceApproval).toBeNull();
    expect(q.belowCostApproval).toBeNull();
    expect(q.totals.gross).toBe(q.lines[0].net);
    s.q = q;
  });

  it('the sales order made from it keeps the flag even when the client does not send it; reserved like any line', async () => {
    const so = await ok(env.boy.post('/api/sales/orders', {
      customerId: C.c1, quoteNo: s.q.no, warehouseId: WH2,
      lines: s.q.lines.map((l: any) => ({ productId: l.productId, unitIdx: l.unitIdx, qty: l.qty, unitPrice: l.unitPrice, quoteLineId: l.id })),
    }), 201);
    expect(so.lines.map((l: any) => [l.giveaway, l.unitPrice])).toEqual([[false, s.q.lines[0].unitPrice], [true, '0']]);
    const r = await env.pool.query(`select free from sales_order_lines where so_id = $1 order by line_no`, [so.id]);
    expect(r.rows.map((x) => x.free)).toEqual([false, true]);
    const a = await env.pool.query(`select detail from audit_log where action = 'free_goods' and ref = $1`, [so.no]);
    expect(a.rows[0].detail).toMatch(/^ของแถม ท่อ PVC .* × 2 เส้น · ต้นทุน ฿/);
    s.so = so;
  });

  it('the delivery order cuts the free line FIFO and keeps the flag; the invoice from it too, with COGS', async () => {
    const before = (await env.pool.query(`select sum(remaining)::text q from stock_lots where product_id = $1 and warehouse_id = $2`, [P.p6, WH2])).rows[0].q;
    const dlv = await ok(env.chai.post('/api/sales/deliveries', { soNo: s.so.no, lines: s.so.lines.map((l: any) => ({ srcLineId: l.id, qty: l.qty })) }), 201);
    expect(dlv.lines.map((l: any) => [l.giveaway, l.value])).toEqual([[false, s.so.lines[0].netAfterBill], [true, '0.00']]);
    const after = (await env.pool.query(`select sum(remaining)::text q from stock_lots where product_id = $1 and warehouse_id = $2`, [P.p6, WH2])).rows[0].q;
    expect(Number(before) - Number(after)).toBe(2);
    const inv = await ok(env.boy.post('/api/sales/invoices', { source: 'delivery', deliveryNos: [dlv.no] }), 201);
    expect(inv.doc.lines.map((l: any) => [l.free ?? false, l.unitPrice])).toEqual([[false, expect.any(String)], [true, '0']]);
    expect(inv.doc.totals.total).toBe(s.so.totals.total);
    const cogs = await env.pool.query(`select cogs::text from doc_lines where doc_id = $1 and free`, [inv.doc.id]);
    expect(Number(cogs.rows[0].cogs)).toBeGreaterThan(0);
  });
});

describe('direct invoice with a free line', () => {
  it('needs no price or below-cost approval, cuts stock and is audited with its cost', async () => {
    const inv = await env.boy.post('/api/sales/invoices', {
      source: 'direct', customerId: C.c1, vatMode: 'exc', warehouseId: WH2, payMethod: 'cash',
      lines: [{ productId: P.p6!, qty: '1', unitPrice: '89' }, { productId: P.p4!, qty: '1', unitPrice: '0', giveaway: true }],
    });
    expect(inv.status).toBe(201);
    expect(inv.body.doc.lines[1]).toMatchObject({ free: true, unitPrice: '0', net: '0.00' });
    const a = await env.pool.query(`select detail from audit_log where action = 'free_goods' and ref = $1`, [inv.body.doc.no]);
    expect(a.rows[0].detail).toMatch(/^ของแถม กาวซีเมนต์ปูกระเบื้อง 20 กก\. × 1 ถุง · ต้นทุน ฿\d/);
  });

  it('a price-0 line that is not ของแถม still needs the price approval', async () => {
    const r = await env.boy.post('/api/sales/invoices', {
      source: 'direct', customerId: C.c1, vatMode: 'exc', warehouseId: WH2, payMethod: 'cash',
      lines: [{ productId: P.p6!, qty: '1', unitPrice: '89' }, { productId: P.p4!, qty: '1', unitPrice: '0' }],
    });
    expect(r.status).toBe(403);
    expect(r.body.details.need).toBe('priceApproval');
  });

  it('a service cannot be given as ของแถม', async () => {
    const r = await env.boy.post('/api/sales/invoices', {
      source: 'direct', customerId: C.c1, vatMode: 'exc', warehouseId: WH2, payMethod: 'cash',
      lines: [{ productId: P.p6!, qty: '1', unitPrice: '89' }, { productId: P.p9!, qty: '1', unitPrice: '0', giveaway: true }],
    });
    expect(r.status).toBe(400);
  });
});
