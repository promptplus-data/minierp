/** On-prem first run: create the shop, its POS warehouse and the owner, only while the database is empty. */
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { withTenant, type Pool } from '@erp/db';
import type { SetupReq } from '@erp/contracts';
import { writeAudit } from '../lib/audit';
import type { Ctx } from '../lib/context';
import { E } from '../lib/errors';

/** True when there is no shop and no user yet (tenants / users are readable cross-tenant only via auth_lookup). */
export async function needsSetup(pool: Pool): Promise<boolean> {
  const r = await withTenant(pool, null, (tx) =>
    tx.query<{ n: number }>(`select ((select count(*) from tenants) + (select count(*) from users))::int n`), { authLookup: true });
  return r.rows[0]!.n === 0;
}

export async function runSetup(pool: Pool, body: SetupReq): Promise<Ctx> {
  const [passwordHash, pinHash] = await Promise.all([
    argon2.hash(body.owner.password, { type: argon2.argon2id }),
    argon2.hash(body.owner.pin, { type: argon2.argon2id }),
  ]);
  const tenantId = randomUUID();
  return withTenant(pool, tenantId, async (tx) => {
    // One setup at a time; re-check emptiness under the lock (read across tenants, then back to this tenant only).
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('erp_setup', 0))`);
    await tx.query(`select set_config('app.auth_lookup', 'on', true)`);
    const n = (await tx.query<{ n: number }>(`select ((select count(*) from tenants) + (select count(*) from users))::int n`)).rows[0]!.n;
    await tx.query(`select set_config('app.auth_lookup', 'off', true)`);
    if (n > 0) throw E.conflict('This server is already set up');
    const s = body.shop;
    await tx.query(
      `insert into tenants (id, code, name, tax_id, branch, address, phone, vat_registered, b2b_vat_mode) values ($1,'main',$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, s.name, s.taxId, s.branch, s.address, s.phone, s.vatRegistered, s.b2bVatMode],
    );
    await tx.query(`insert into warehouses (tenant_id, code, name, is_pos) values ($1,'WH1','หน้าร้าน',true)`, [tenantId]);
    const u = await tx.query<{ id: string }>(
      `insert into users (tenant_id, username, name, role, password_hash, pin_hash) values ($1,$2,$3,'owner',$4,$5) returning id`,
      [tenantId, body.owner.username, body.owner.name, passwordHash, pinHash],
    );
    const ctx: Ctx = { tenantId, userId: u.rows[0]!.id, name: body.owner.name, role: 'owner' };
    await writeAudit(tx, ctx, [{ action: 'setup', object: 'tenant', ref: s.name, detail: `ตั้งค่าร้านครั้งแรก · เจ้าของ ${body.owner.username}` }]);
    return ctx;
  });
}
