/** Excel / CSV export of the stock page and the stock ledger for picked products and warehouses. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, openShift, saleBody, setupEnv, type Env } from '../helpers';

let env: Env;
const P = (k: string) => env.seed.products[k]!;
const W = (k: string) => env.seed.warehouses[k]!;
const tokens: Record<string, string> = {};

async function token(user: string) {
  if (!tokens[user]) {
    const r = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: user, password: '1234' } });
    tokens[user] = JSON.parse(r.body).token;
  }
  return tokens[user]!;
}
async function csv(user: string, url: string) {
  const r = await env.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${await token(user)}` } });
  return { status: r.statusCode, type: String(r.headers['content-type']), disposition: String(r.headers['content-disposition'] ?? ''), rows: r.statusCode === 200 ? r.body.replace(/^﻿/, '').trim().split(/\r?\n/).map((l) => l.split(',')) : [], body: r.body };
}

beforeAll(async () => { env = await setupEnv(); });
afterAll(async () => { await env.close(); });

describe('stock page export', () => {
  it('one row per picked product × picked warehouse with on hand, reserved, available; costs only for cost roles', async () => {
    const url = `/api/stock/export?format=csv&productIds=${P('p1')},${P('p5')}&warehouseIds=${W('WH1')}`;
    const owner = await csv('charoen', url);
    expect(owner.status).toBe(200);
    expect(owner.rows[0]).toEqual(['รหัสสินค้า', 'ชื่อสินค้า', 'หมวด', 'หน่วยหลัก', 'รหัสคลัง', 'คลัง', 'ประเภทคลัง', 'คงเหลือ', 'จอง (ใบสั่งขาย)', 'พร้อมขาย', 'ทุนเฉลี่ย/หน่วย', 'มูลค่าคงเหลือ']);
    expect(owner.rows).toHaveLength(3);
    const p1 = owner.rows.find((r) => r[0] === 'SCG-CEM-T50')!;
    expect(p1[7]).toBe('62.0000');
    expect(Number(p1[11])).toBeGreaterThan(0);
    const wh = await csv('chai', url); // warehouse staff: no data.cost
    expect(wh.rows[0]).not.toContain('มูลค่าคงเหลือ');
    expect(wh.rows[1]).toHaveLength(10);
  });

  it('Excel by default, every warehouse when none is picked, nonZero drops empty rows; sign-in and valid ids are required', async () => {
    const x = await env.app.inject({ method: 'GET', url: `/api/stock/export?productIds=${P('p1')}`, headers: { authorization: `Bearer ${await token('charoen')}` } });
    expect(x.statusCode).toBe(200);
    expect(String(x.headers['content-type'])).toContain('spreadsheetml');
    expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const all = await csv('charoen', `/api/stock/export?format=csv`);
    const some = await csv('charoen', `/api/stock/export?format=csv&nonZero=1`);
    expect(all.rows.length).toBeGreaterThan(some.rows.length);
    expect(some.rows.slice(1).every((r) => Number(r[7]) !== 0 || Number(r[8]) !== 0)).toBe(true);
    expect((await env.app.inject({ method: 'GET', url: '/api/stock/export?format=csv' })).statusCode).toBe(401);
    expect((await csv('charoen', `/api/stock/export?format=csv&warehouseIds=nope`)).status).toBe(400);
  });
});

describe('stock ledger export', () => {
  it('moves of the picked products and warehouses, oldest first, with the running balance', async () => {
    const prae = await login(env.app, 'prae');
    const shift = await openShift(prae);
    for (const qty of ['2', '1']) expect((await prae.post('/api/sales/pos', saleBody(env.seed, shift, [{ p: 'p1', qty, price: '145.00' }], (145 * Number(qty)).toFixed(2)))).status).toBe(201);
    const r = await csv('charoen', `/api/stock/ledger/export?format=csv&productIds=${P('p1')}&warehouseIds=${W('WH1')}`);
    expect(r.status).toBe(200);
    expect(r.rows[0]).toEqual(['วันที่เวลา', 'เลขที่เอกสาร', 'ประเภท', 'รหัสสินค้า', 'ชื่อสินค้า', 'คลัง', 'จำนวน', 'หน่วย', 'คงเหลือหลังรายการ', 'ทุน/หน่วย', 'หมายเหตุ', 'โดย']);
    const body = r.rows.slice(1);
    expect(body).toHaveLength(2);
    expect(body.every((x) => x[3] === 'SCG-CEM-T50')).toBe(true);
    expect([...body.map((x) => x[0])]).toEqual([...body.map((x) => x[0])].sort());
    expect(body.map((x) => x[8])).toEqual(['60.0000', '59.0000']); // running balance after each sale; last = on hand now
    const none = await csv('charoen', `/api/stock/ledger/export?format=csv&productIds=${P('p1')}&from=2099-01-01`);
    expect(none.rows).toHaveLength(1);
    expect(r.disposition).toContain('stock-ledger-start_');
  });
});
