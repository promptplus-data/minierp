/** seedPurchasing(): demo data is consistent with the services (lots = ledger, AP balances, alerts) and idempotent. */
import { seedPurchasing } from '@erp/db/src/seedPurchasing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, TODAY, type Client, type Env, setupEnv } from '../helpers';

let env: Env;
let suda: Client;

beforeAll(async () => {
  env = await setupEnv();
  await seedPurchasing(env.pool, env.seed.tenantId, { today: TODAY });
  await seedPurchasing(env.pool, env.seed.tenantId, { today: TODAY }); // second run: no-op
  suda = await login(env.app, 'suda');
});
afterAll(async () => { await env.close(); });

describe('seedPurchasing', () => {
  it('creates receipts, AP bills, a payment, a vendor return and an overdue draft exactly once', async () => {
    const n = await env.pool.query(`select (select count(*) from ap_bills)::int bills, (select count(*) from ap_payments)::int pv, (select count(*) from vendor_returns)::int pr, (select count(*) from gr_drafts)::int drafts`);
    expect(n.rows[0]).toEqual({ bills: 3, pv: 1, pr: 1, drafts: 1 });
    const alert = await suda.get('/api/purchasing/gr-alerts');
    expect(alert.body).toMatchObject({ count: 1, items: [{ dnNo: '8100230001', ageDays: 3 }] });
    const aging = await suda.get('/api/ap/aging');
    expect(aging.body.dueSoon.count).toBe(1);
    expect(d(aging.body.buckets.d1_30)).toBeGreaterThan(0);
    expect(aging.body.purchaseDiscountMonth).toBe('200.00');
    const dr = await suda.get('/api/gr-drafts');
    expect(dr.body.items[0]).toMatchObject({ unmatched: 1, lineCount: 2 });
  });

  it('ledger balances end at the lot balances and new documents continue the numbering', async () => {
    const bad = await env.pool.query(`
      select l.id from stock_lots l where l.ref in (select no from stock_docs)
         and l.remaining <> l.qty_in - coalesce((select sum(ml.qty) from stock_move_lots ml join stock_moves m on m.id = ml.move_id where ml.lot_id = l.id and m.qty < 0), 0)`);
    expect(bad.rows).toEqual([]);
    const led = await suda.get(`/api/stock/ledger?productId=${env.seed.products.p6}&warehouseId=${env.seed.warehouses.WH2}`);
    expect(led.body.items.map((x: { docType: string; qty: string; balance: string }) => [x.docType, x.qty, x.balance])).toEqual([['PR', '-5', '155'], ['GR', '40', '160']]);
    const ret = await suda.get('/api/ap/vendor-returns');
    expect(ret.body.items[0]).toMatchObject({ vendorCnNo: 'TT-CN-0012', lines: [expect.objectContaining({ qty: '0.25', unitName: 'มัด' })] });
    const gr = await suda.get(`/api/purchasing/receipts?returnable=true`);
    expect(gr.body.items.length).toBe(3);
    const g1 = gr.body.items.find((x: { no: string }) => x.no === 'GR2610-0001');
    expect(g1.receivedQty).toEqual([{ unit: 'ถุง', qty: '100' }, { unit: 'พาเลท', qty: '1' }]);
    expect(g1.lineCount).toBe(2);
    const r = await suda.post('/api/stock/receipts', {
      vendorId: env.seed.vendors.v1, vendorInvoiceNo: 'NEW-1', deliveryNo: 'DN-NEW-1', warehouseId: env.seed.warehouses.WH2,
      lines: [{ productId: env.seed.products.p1, qty: '1', unitCost: '120' }],
    });
    expect(r.status).toBe(201);
    expect(r.body.no).toBe('GR2610-0003'); // the seed used GR2610-0001/0002 (dated this month) and GR2609-0001
  });
});

const d = (s: string) => Number(s);
