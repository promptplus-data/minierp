import pg from 'pg';

// DATE columns stay 'YYYY-MM-DD' strings (no host-time-zone Date conversion); numeric and int8 already arrive as strings.
pg.types.setTypeParser(1082, (v: string) => v);

export type Pool = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

/** Whether this pool's login user can SET ROLE erp_app (cached per pool). */
const appRoleCache = new WeakMap<pg.Pool, Promise<boolean>>();
export function canUseAppRole(pool: pg.Pool): Promise<boolean> {
  let p = appRoleCache.get(pool);
  if (!p) {
    p = pool
      .query<{ ok: boolean }>(
        `select exists(select 1 from pg_roles where rolname = 'erp_app')
                and pg_has_role(current_user, 'erp_app', 'MEMBER') as ok`,
      )
      .then((r) => r.rows[0]?.ok === true);
    appRoleCache.set(pool, p);
  }
  return p;
}

export interface TenantTxOptions {
  /** Login / pairing lookups only: lets the transaction read users, tenants and pairing codes of every tenant. */
  authLookup?: boolean;
}

/**
 * Runs fn in one transaction scoped to a tenant (BR-14 / M19):
 * BEGIN; SET LOCAL ROLE erp_app; set_config('app.tenant_id', tenantId, true); fn; COMMIT.
 * RLS policies filter every table on app.tenant_id, so a query that forgets `WHERE tenant_id = ...`
 * still only sees this tenant's rows. Rolls back on any error.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string | null,
  fn: (tx: pg.PoolClient) => Promise<T>,
  opts: TenantTxOptions = {},
): Promise<T> {
  const useRole = await canUseAppRole(pool);
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    if (useRole) await client.query('SET LOCAL ROLE erp_app');
    await client.query(`select set_config('app.tenant_id', $1, true), set_config('app.auth_lookup', $2, true)`, [
      tenantId ?? '',
      opts.authLookup ? 'on' : 'off',
    ]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    // If even ROLLBACK fails the connection is in an unknown state: destroy it instead of returning it to the pool.
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      broken = rbErr instanceof Error ? rbErr : new Error(String(rbErr));
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
