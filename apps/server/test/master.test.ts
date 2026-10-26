/** M03 master data + document list paging. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, openShift, saleBody, setupEnv, type Client, type Env } from './helpers';

let env: Env;
let owner: Client;
let prae: Client;
beforeAll(async () => {
  env = await setupEnv();
  owner = await login(env.app, 'charoen');
  prae = await login(env.app, 'prae');
});
afterAll(async () => { await env.close(); });

describe('master data', () => {
  it('owner creates and updates a product; cashier may not', async () => {
    const body = { sku: 'NEW-1', name: 'สินค้าใหม่', category: 'อื่น ๆ', isScg: false, kind: 'stock', vat: 'v7', price: '10.00', units: [{ name: 'ชิ้น', factor: '1' }], reorderPoint: '0' };
    expect((await prae.post('/api/products', body)).status).toBe(403);
    const c = await owner.post('/api/products', body);
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ sku: 'NEW-1', cost: '0', active: true, barcode: null });
    const u = await owner.patch(`/api/products/${c.body.id}`, { price: '12.50', active: false });
    expect(u.body).toMatchObject({ price: '12.50', active: false });
    expect((await owner.post('/api/products', body)).status).toBe(409); // duplicate SKU
    expect((await owner.post('/api/products', { ...body, sku: 'NEW-2', units: [{ name: 'แพ็ค', factor: '6' }] })).status).toBe(400);
  });

  it('lists products with cursor paging (default 20, max 100)', async () => {
    const p1 = await prae.get('/api/products?limit=5');
    expect(p1.body.items).toHaveLength(5);
    const p2 = await prae.get(`/api/products?limit=5&cursor=${p1.body.nextCursor}`);
    const p3 = await prae.get(`/api/products?limit=5&cursor=${p2.body.nextCursor}`);
    const all = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((p: { sku: string }) => p.sku);
    expect(new Set(all).size).toBe(12);
    expect(p3.body.nextCursor).toBeNull();
    expect((await prae.get('/api/products?limit=500')).status).toBe(400);
    expect((await prae.get('/api/products?cursor=garbage')).status).toBe(400);
  });

  it('creates a customer with the next code and finds it by phone', async () => {
    const c = await owner.post('/api/customers', { name: 'ช่างเอก', phone: '081-000-1111' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: 'C00004', group: 'retail', creditLimit: '0.00', term: { t: 'cash' } });
    const found = await prae.get('/api/customers?q=081-000');
    expect(found.body.items.map((x: { code: string }) => x.code)).toEqual(['C00004']);
  });

  it('lists warehouses and vendors', async () => {
    const w = await prae.get('/api/warehouses');
    expect(w.body.items).toEqual([
      { id: env.seed.warehouses.WH1, name: 'หน้าร้าน', isPos: true, active: true },
      { id: env.seed.warehouses.WH2, name: 'โกดังหลังร้าน', isPos: false, active: true },
    ]);
    expect((await owner.get('/api/vendors')).body.items).toHaveLength(3);
  });
});

describe('sales documents list', () => {
  it('newest first with item preview and cursor', async () => {
    const shift = await openShift(prae);
    for (const q of ['1', '2', '3']) await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p6', qty: q, price: '89.00' }], (89 * Number(q)).toFixed(2)));
    const p1 = await prae.get('/api/sales/docs?limit=2');
    expect(p1.body.items.map((d: { no: string }) => d.no)).toEqual(['ABB2610-0003', 'ABB2610-0002']);
    expect(p1.body.items[0]).toMatchObject({ total: '267.00', itemsPreview: 'ท่อ ×3', status: 'active' });
    const p2 = await prae.get(`/api/sales/docs?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((d: { no: string }) => d.no)).toEqual(['ABB2610-0001']);
  });
});
