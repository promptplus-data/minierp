/** Shared fixtures for the sales module tests (group A). */
import { withTenant } from '@erp/db';
import { seedSales } from '@erp/db/src/seedSales';
import { login, setupEnv, type Client, type Env } from '../helpers';

export interface SalesEnv extends Env { owner: Client; suda: Client; boy: Client; prae: Client; chai: Client; seeded: Awaited<ReturnType<typeof seedSales>> }

export async function setupSales(): Promise<SalesEnv> {
  const env = await setupEnv(process.env.DBG ? { logger: { level: "error" } } : {});
  const seeded = await withTenant(env.pool, env.seed.tenantId, (c) => seedSales(c, env.seed.tenantId));
  const [owner, suda, boy, prae, chai] = await Promise.all(['charoen', 'suda', 'boy', 'prae', 'chai'].map((u) => login(env.app, u)));
  return { ...env, owner: owner!, suda: suda!, boy: boy!, prae: prae!, chai: chai!, seeded };
}

/** Throws with the response body when the status is not the expected one; returns the body. */
export async function ok<T = any>(p: Promise<{ status: number; body: any }>, status = 200): Promise<T> {
  const r = await p;
  if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

export const pin = (env: Env, user = 'suda') => ({ approverUserId: env.seed.users[user]!, pin: '1234' });
/** Manager PIN + reason for a price below the BR-05 price / a discount over the role cap (sales role has pos.price 'apv'). */
export const apv = (env: Env, user = 'suda') => ({ ...pin(env, user), reason: 'ราคาพิเศษตามที่ตกลงกับลูกค้า' });

/** Balance of one invoice straight from the database (superuser). */
export async function arOf(env: Env, no: string): Promise<string> {
  return (await env.pool.query<{ b: string }>(`select ar_balance::text b from docs where no = $1`, [no])).rows[0]!.b;
}
