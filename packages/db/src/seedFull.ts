/**
 * Full demo shop: the core demo (seedDemo) plus every module group's demo data.
 * Used by the Vercel demo (bootstrap with SEED_DEMO=1) and `pnpm db:seed`. Idempotent.
 */
import type pg from 'pg';
import { withTenant } from './tx';
import { seedDemo } from './seed';
import { seedSales } from './seedSales';
import { seedPurchasing } from './seedPurchasing';
import { seedRetail } from './seedRetail';
import { seedAdmin } from './seedAdmin';
import { seedReports } from './seedReports';

export async function seedModules(pool: pg.Pool, tenantId: string): Promise<void> {
  await withTenant(pool, tenantId, (c) => seedRetail(c, tenantId));
  await withTenant(pool, tenantId, (c) => seedSales(c, tenantId));
  await withTenant(pool, tenantId, (c) => seedPurchasing(c, tenantId));
  await withTenant(pool, tenantId, (c) => seedReports(c, tenantId));
  await seedAdmin(pool, tenantId);
}

export async function seedFullDemo(pool: pg.Pool): Promise<{ tenantId: string }> {
  const s = await seedDemo(pool);
  await seedModules(pool, s.tenantId);
  return { tenantId: s.tenantId };
}
