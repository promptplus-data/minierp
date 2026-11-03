/** Shared setup for the reports tests: demo shop + two weeks of seeded sales + today's sales through the API. */
import type { FastifyInstance } from 'fastify';
import { seedReports } from '@erp/db/src/seedReports';
import { TODAY, login, openShift, saleBody, setupEnv, type Client, type Env } from '../helpers';

export { TODAY };
export const MONTH = TODAY.slice(0, 7);

export interface ReportsEnv extends Env { owner: Client; today: Record<string, string>; prae: Client; shift: string }

/** Superuser view of the documents: the numbers every report must match. */
export async function docSums(env: Env, from: string, to: string) {
  const r = await env.pool.query<{ net: string; vat: string; total: string; bills: number; cns: number }>(
    `select coalesce(sum(case when type = 'CN' then -(base7 + exempt) else base7 + exempt end), 0)::numeric(14,2)::text net,
            coalesce(sum(case when type = 'CN' then -vat else vat end), 0)::numeric(14,2)::text vat,
            coalesce(sum(case when type = 'CN' then -total else total end), 0)::numeric(14,2)::text total,
            (count(*) filter (where type <> 'CN'))::int bills, (count(*) filter (where type = 'CN'))::int cns
       from docs where tenant_id = $1 and status = 'active' and type in ('ABB','INV','RC','CN') and date between $2 and $3`,
    [env.seed.tenantId, from, to],
  );
  return r.rows[0]!;
}

/** Ledger COGS of live sales documents (out = +cost, restocked returns = −cost). */
export async function ledgerCogs(env: Env, from: string, to: string): Promise<string> {
  const r = await env.pool.query<{ c: string }>(
    `select coalesce(sum(case when m.qty < 0 then m.cost else -m.cost end), 0)::numeric(14,2)::text c
       from stock_moves m join docs d on d.id = m.doc_id
      where d.tenant_id = $1 and d.status = 'active' and d.type in ('ABB','INV','RC','CN') and d.date between $2 and $3`,
    [env.seed.tenantId, from, to],
  );
  return r.rows[0]!.c;
}

export async function setupReports(opts: Parameters<typeof setupEnv>[0] = {}): Promise<ReportsEnv> {
  const env = await setupEnv(opts);
  const c = await env.pool.connect();
  try {
    await seedReports(c, env.seed.tenantId, { today: TODAY });
  } finally {
    c.release();
  }
  const owner = await login(env.app, 'charoen');
  const prae = await login(env.app, 'prae');
  const shift = await openShift(prae);
  const today: Record<string, string> = {};
  const sell = async (k: string, body: ReturnType<typeof saleBody>) => {
    const r = await prae.post('/api/sales/pos', body);
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    today[k] = r.body.no;
  };
  await sell('cement', saleBody(env.seed, shift, [{ p: 'p1', qty: '10', price: '145.00' }, { p: 'p9', qty: '1', price: '300.00' }], '1750.00'));
  await sell('pvc', saleBody(env.seed, shift, [{ p: 'p6', qty: '3', price: '89.00', discount: { kind: 'amt', value: '0' } }], '267.00'));
  await sell('inv', saleBody(env.seed, shift, [{ p: 'p4', qty: '2', price: '210.00' }], '420.00', { docKind: 'full', customerId: env.seed.customers.c1 }));
  await sell('voided', saleBody(env.seed, shift, [{ p: 'p2', qty: '5', price: '52.00' }], '260.00'));
  const v = await owner.post(`/api/sales/docs/${today.voided}/void`, { reason: 'บิลซ้ำ' });
  if (v.status !== 200) throw new Error(JSON.stringify(v.body));
  return { ...env, owner, today, prae, shift };
}

/** Raw request (file downloads are not JSON). */
export async function raw(app: FastifyInstance, token: string, url: string) {
  const r = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, headers: r.headers, body: r.rawPayload, text: r.body };
}

export async function token(app: FastifyInstance, username: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: '1234' } });
  return JSON.parse(r.body).token;
}
