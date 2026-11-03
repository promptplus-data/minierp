/** seedSales is idempotent and its documents are valid for the API. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@erp/db';
import { seedSales } from '@erp/db/src/seedSales';
import { ok, setupSales, type SalesEnv } from './sales-helpers';

let env: SalesEnv;
beforeAll(async () => { env = await setupSales(); });
afterAll(async () => { await env.close(); });

describe('seedSales', () => {
  it('a second run changes nothing', async () => {
    const count = async () => (await env.pool.query(`select (select count(*) from sales_price_lists) + (select count(*) from sales_quotes) + (select count(*) from sales_settings) n`)).rows[0].n;
    const before = await count();
    const again = await withTenant(env.pool, env.seed.tenantId, (c) => seedSales(c, env.seed.tenantId));
    expect(again).toEqual(env.seeded);
    expect(await count()).toBe(before);
  });
  it('the demo quotation reads back with its free-text line and bank accounts are in the settings', async () => {
    const q = await ok(env.boy.get(`/api/sales/quotations/${env.seeded.quotes.bannaa}`));
    expect(q.status).toBe('sent');
    expect(q.lines.filter((l: { free: boolean }) => l.free)).toHaveLength(1);
    const s = await ok(env.boy.get('/api/sales/settings'));
    expect(s.banks).toHaveLength(2);
    expect(s.quoteValidDays).toBe(15);
  });
});
