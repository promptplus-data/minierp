import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, resetData, seedDemo, type Pool, type SeedResult } from '@erp/db';
import { buildApp, type BuildOptions } from '../src/app';
import { TEST_DATABASE_URL } from './db-url';

export { TEST_DATABASE_URL };
export const TODAY = '2026-10-26';

export interface Env { app: FastifyInstance; pool: Pool; seed: SeedResult; close: () => Promise<void> }

/**
 * Fresh database state for a test file: truncate, seed the mockup tenant, build an app.
 * `pool` connects as the test superuser (bypasses RLS) and is used for direct assertions.
 */
export async function setupEnv(opts: Partial<BuildOptions> = {}): Promise<Env> {
  const pool = createPool(TEST_DATABASE_URL, 12);
  await resetData(pool);
  const seed = await seedDemo(pool);
  const app = await buildApp({ pool, edition: 'onprem', jwtSecret: 'test-secret', today: () => TODAY, ...opts });
  return { app, pool, seed, close: async () => { await app.close(); await pool.end(); } };
}

export type Res = { status: number; body: any };

export function client(app: FastifyInstance, token?: string) {
  const call = async (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<Res> => {
    const r = await app.inject({ method, url, payload: payload as object | undefined, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body: unknown = {}) => call('POST', url, body),
    patch: (url: string, body: unknown) => call('PATCH', url, body),
  };
}
export type Client = ReturnType<typeof client>;

export async function login(app: FastifyInstance, username: string, password = '1234'): Promise<Client> {
  const r = await client(app).post('/api/auth/login', { username, password });
  if (r.status !== 200) throw new Error(`login ${username} failed: ${JSON.stringify(r.body)}`);
  return client(app, r.body.token);
}

export async function openShift(c: Client, float = '1000.00', deviceId = 'POS-1'): Promise<string> {
  const r = await c.post('/api/shifts/open', { float, deviceId });
  if (r.status !== 201) throw new Error(`open shift failed: ${JSON.stringify(r.body)}`);
  return r.body.id;
}

/** POS sale body for VAT-inclusive ABB, cash paid in full. */
export function saleBody(
  seed: SeedResult,
  shiftId: string,
  lines: { p: string; qty: string; price: string; unitIdx?: number; discount?: { kind: 'pct' | 'amt'; value: string } }[],
  total: string,
  extra: Record<string, unknown> = {},
) {
  return {
    idempotencyKey: randomUUID(),
    shiftId,
    warehouseId: seed.warehouses.WH1,
    docKind: 'abb',
    lines: lines.map((l) => ({ productId: seed.products[l.p], unitIdx: l.unitIdx ?? 0, qty: l.qty, unitPrice: l.price, ...(l.discount ? { discount: l.discount } : {}) })),
    payments: [{ method: 'cash', amount: total }],
    ...extra,
  };
}

/** Lots of a product in a warehouse, oldest first (superuser read). */
export async function lotsOf(pool: Pool, productId: string, warehouseId: string) {
  const r = await pool.query<{ remaining: string; unit_cost: string; ref: string }>(
    `select remaining::text, unit_cost::text, ref from stock_lots where product_id = $1 and warehouse_id = $2 order by received_at, id`,
    [productId, warehouseId],
  );
  return r.rows;
}

export async function stockQty(pool: Pool, productId: string, warehouseId: string): Promise<number> {
  const r = await pool.query<{ q: string | null }>(`select sum(remaining)::text q from stock_lots where product_id = $1 and warehouse_id = $2`, [productId, warehouseId]);
  return Number(r.rows[0]?.q ?? 0);
}
