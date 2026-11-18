/**
 * Shop roles (owner only): the shop's own permission set for each built-in role, and roles the owner creates
 * (e.g. ฝ่ายบุคคล) from a built-in starting point. Every authed request resolves the user's grants here; a user with
 * a shop role keeps users.role = the role's base (approver PIN rules and labels follow the base).
 */
import type { Tx } from '@erp/db';
import type { ShopRole } from '@erp/contracts';
import { defaultGrants, isPermValue, PERM_KEYS, permWithin, type GrantSet, type PermKey, type Role } from '@erp/core';
import { writeAudit } from '../lib/audit';
import { can, type Ctx } from '../lib/context';
import { E, isUuid } from '../lib/errors';

export const BUILTIN: readonly Exclude<Role, 'owner'>[] = ['manager', 'cashier', 'sales', 'wh', 'driver', 'acct', 'extacct'];
const ROLE_TH: Record<Exclude<Role, 'owner'>, string> = { manager: 'ผู้จัดการ', cashier: 'แคชเชียร์', sales: 'พนักงานขาย', wh: 'พนักงานคลัง', driver: 'คนขับรถ', acct: 'บัญชี', extacct: 'นักบัญชีภายนอก' };

/** Stored grants may predate a new key: fill from the base role's default. */
const complete = (base: Role, g: Partial<GrantSet>): GrantSet => {
  const d = defaultGrants(base);
  return Object.fromEntries(PERM_KEYS.map((k) => [k, isPermValue(k, g[k]) ? g[k]! : d[k]])) as GrantSet;
};

/** The grants for a user; undefined = the built-in defaults (no shop override). */
export async function grantsFor(tx: Tx, role: Role, shopRoleId: string | null): Promise<{ grants?: GrantSet; roleName?: string }> {
  if (role === 'owner') return {};
  const r = await tx.query<{ name: string; base: Role; grants: Partial<GrantSet>; builtin: boolean }>(
    shopRoleId ? `select name, base, grants, builtin from shop_roles where id = $1 and active` : `select name, base, grants, builtin from shop_roles where key = $1 and builtin and active`,
    [shopRoleId ?? role]);
  const x = r.rows[0];
  if (!x) return {};
  return { grants: complete(x.base, x.grants), roleName: x.builtin ? undefined : x.name };
}

interface Row { id: string; key: string; name: string; base: Exclude<Role, 'owner'>; builtin: boolean; grants: Partial<GrantSet>; active: boolean; updated_by: string | null; updated_at: Date; users: number }

const toRole = (x: Row): ShopRole => ({
  id: x.id, key: x.key, name: x.name, base: x.base, builtin: x.builtin, grants: complete(x.base, x.grants), defaults: defaultGrants(x.base),
  customized: x.builtin, users: x.users, updatedBy: x.updated_by, updatedAt: x.updated_at.toISOString(),
});

const requireOwner = (ctx: Ctx) => { if (ctx.role !== 'owner') throw E.forbidden('เฉพาะเจ้าของร้านจัดการสิทธิ์และบทบาทได้'); };
const readRoles = (ctx: Ctx) => {
  const v = can(ctx, 'sys.users');
  if (ctx.role !== 'owner' && v !== 1 && v !== 'ro' && can(ctx, 'hr.manage') !== 1) throw E.forbidden('Permission sys.users is required', { perm: 'sys.users' });
};

/** Every built-in role (default or the shop's version) and the shop's own roles, with how many active users each has. */
export async function listRoles(tx: Tx, ctx: Ctx): Promise<ShopRole[]> {
  readRoles(ctx);
  const r = await tx.query<Row>(
    `select s.id, s.key, s.name, s.base, s.builtin, s.grants, s.active, u.name updated_by, s.updated_at,
            (select count(*)::int from users x where x.status = 'active' and (case when s.builtin then x.role = s.key and x.shop_role_id is null else x.shop_role_id = s.id end)) users
       from shop_roles s left join users u on u.id = s.updated_by where s.active order by s.builtin desc, s.created_at`);
  const counts = await tx.query<{ role: string; n: number }>(`select role, count(*)::int n from users where status = 'active' and shop_role_id is null group by role`);
  const cnt = new Map(counts.rows.map((c) => [c.role, c.n]));
  const own = new Map(r.rows.filter((x) => x.builtin).map((x) => [x.key, x]));
  const builtins: ShopRole[] = BUILTIN.map((k) => own.get(k) ? toRole(own.get(k)!) : {
    id: k, key: k, name: ROLE_TH[k], base: k, builtin: true, grants: defaultGrants(k), defaults: defaultGrants(k), customized: false, users: cnt.get(k) ?? 0, updatedBy: null, updatedAt: null,
  });
  return [...builtins.map((b) => ({ ...b, name: ROLE_TH[b.key as Exclude<Role, 'owner'>] })), ...r.rows.filter((x) => !x.builtin).map(toRole)];
}

function parseGrants(g: Record<string, unknown>): GrantSet {
  const out = {} as GrantSet;
  for (const k of PERM_KEYS) {
    const v = g[k] ?? 0;
    if (!isPermValue(k, v)) throw E.validation(`ค่าสิทธิ์ ${k} ไม่ถูกต้อง`);
    out[k] = v;
  }
  return out;
}

const diff = (a: GrantSet, b: GrantSet) => PERM_KEYS.filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k]} → ${b[k]}`);

/** Owner: set the shop's permission set for a built-in role (`id` = the role key) or a shop role (`id` = uuid). */
export async function updateRole(tx: Tx, ctx: Ctx, id: string, body: { name?: string; grants?: Record<string, unknown>; reset?: boolean }): Promise<ShopRole> {
  requireOwner(ctx);
  if ((BUILTIN as readonly string[]).includes(id)) {
    const key = id as Exclude<Role, 'owner'>;
    const cur = await tx.query<{ id: string; grants: Partial<GrantSet>; active: boolean }>(`select id, grants, active from shop_roles where key = $1 and builtin for update`, [key]);
    const before = cur.rows[0]?.active ? complete(key, cur.rows[0].grants) : defaultGrants(key);
    if (body.reset) {
      if (cur.rows[0]) await tx.query(`update shop_roles set active = false, updated_by = $2, updated_at = now() where id = $1`, [cur.rows[0].id, ctx.userId]);
      await writeAudit(tx, ctx, [{ action: 'update', object: 'role', ref: ROLE_TH[key], detail: 'คืนค่าสิทธิ์มาตรฐาน' }]);
    } else {
      if (!body.grants) throw E.validation('ส่งสิทธิ์ที่ต้องการ');
      const g = parseGrants(body.grants);
      await tx.query(
        `insert into shop_roles (tenant_id, key, name, base, builtin, grants, updated_by) values ($1,$2,$3,$2,true,$4,$5)
         on conflict (tenant_id, key) do update set grants = excluded.grants, active = true, updated_by = excluded.updated_by, updated_at = now()`,
        [ctx.tenantId, key, ROLE_TH[key], JSON.stringify(g), ctx.userId]);
      const ch = diff(before, g);
      await writeAudit(tx, ctx, [{ action: 'update', object: 'role', ref: ROLE_TH[key], detail: ch.length ? ch.join(', ') : 'ไม่มีการเปลี่ยนแปลง' }]);
    }
    return (await listRoles(tx, ctx)).find((r) => r.key === key)!;
  }
  if (!isUuid(id)) throw E.notFound('ไม่พบบทบาท');
  const cur = await tx.query<{ id: string; name: string; base: Role; grants: Partial<GrantSet> }>(`select id, name, base, grants from shop_roles where id = $1 and not builtin and active for update`, [id]);
  const x = cur.rows[0];
  if (!x) throw E.notFound('ไม่พบบทบาท');
  const g = body.grants ? parseGrants(body.grants) : complete(x.base, x.grants);
  const name = body.name?.trim() || x.name;
  await tx.query(`update shop_roles set name = $2, grants = $3, updated_by = $4, updated_at = now() where id = $1`, [id, name, JSON.stringify(g), ctx.userId]);
  const ch = [...(name !== x.name ? [`ชื่อ: ${x.name} → ${name}`] : []), ...diff(complete(x.base, x.grants), g)];
  await writeAudit(tx, ctx, [{ action: 'update', object: 'role', ref: name, detail: ch.length ? ch.join(', ') : 'ไม่มีการเปลี่ยนแปลง' }]);
  return (await listRoles(tx, ctx)).find((r) => r.id === id)!;
}

/** Owner: a new shop role starting from a built-in role's permissions. */
export async function createRole(tx: Tx, ctx: Ctx, body: { name: string; base: Exclude<Role, 'owner'>; grants?: Record<string, unknown> }): Promise<ShopRole> {
  requireOwner(ctx);
  const name = body.name.trim();
  if (BUILTIN.some((k) => ROLE_TH[k] === name) || name === 'เจ้าของร้าน') throw E.conflict('ชื่อซ้ำกับบทบาทมาตรฐาน');
  const dup = await tx.query(`select 1 from shop_roles where not builtin and active and name = $1`, [name]);
  if (dup.rowCount) throw E.conflict(`มีบทบาท ${name} อยู่แล้ว`);
  const g = body.grants ? parseGrants(body.grants) : defaultGrants(body.base);
  const key = `r${Date.now().toString(36)}`;
  const id = (await tx.query<{ id: string }>(
    `insert into shop_roles (tenant_id, key, name, base, builtin, grants, updated_by) values ($1,$2,$3,$4,false,$5,$6) returning id`,
    [ctx.tenantId, key, name, body.base, JSON.stringify(g), ctx.userId])).rows[0]!.id;
  await writeAudit(tx, ctx, [{ action: 'create', object: 'role', ref: name, detail: `บทบาทใหม่ เริ่มจากสิทธิ์ของ${ROLE_TH[body.base]}` }]);
  return (await listRoles(tx, ctx)).find((r) => r.id === id)!;
}

/** Owner: remove a shop role nobody active uses any more. */
export async function deleteRole(tx: Tx, ctx: Ctx, id: string): Promise<{ ok: true }> {
  requireOwner(ctx);
  if (!isUuid(id)) throw E.notFound('ไม่พบบทบาท');
  const x = (await tx.query<{ name: string }>(`select name from shop_roles where id = $1 and not builtin and active for update`, [id])).rows[0];
  if (!x) throw E.notFound('ไม่พบบทบาท');
  const used = await tx.query<{ name: string }>(`select name from users where shop_role_id = $1 and status = 'active'`, [id]);
  if (used.rowCount) throw E.conflict(`ยังมีผู้ใช้บทบาทนี้ ${used.rows.map((u) => u.name).join(', ')} เปลี่ยนบทบาทของผู้ใช้ก่อน`);
  await tx.query(`update shop_roles set active = false, updated_by = $2, updated_at = now() where id = $1`, [id, ctx.userId]);
  await writeAudit(tx, ctx, [{ action: 'void', object: 'role', ref: x.name, detail: 'ลบบทบาท' }]);
  return { ok: true };
}

/**
 * Resolves the role picked for a user (a built-in key or a shop role id) and checks that a non-owner gives no more
 * than they have themselves. Returns what to store in users.role / users.shop_role_id.
 */
export async function resolveAssignment(tx: Tx, ctx: Ctx, pick: { role: Exclude<Role, 'owner'>; shopRoleId?: string | null }): Promise<{ role: Exclude<Role, 'owner'>; shopRoleId: string | null; label: string }> {
  let role = pick.role;
  let shopRoleId: string | null = null;
  let label: string = ROLE_TH[role];
  if (pick.shopRoleId) {
    if (!isUuid(pick.shopRoleId)) throw E.validation('Unknown role');
    const r = (await tx.query<{ base: Exclude<Role, 'owner'>; name: string }>(`select base, name from shop_roles where id = $1 and not builtin and active`, [pick.shopRoleId])).rows[0];
    if (!r) throw E.validation('Unknown role');
    role = r.base;
    shopRoleId = pick.shopRoleId;
    label = r.name;
  }
  if (ctx.role !== 'owner') {
    const target = (await grantsFor(tx, role, shopRoleId)).grants ?? defaultGrants(role);
    const over = PERM_KEYS.filter((k: PermKey) => !permWithin(k, target[k], can(ctx, k)));
    if (over.length) throw E.forbidden(`ให้บทบาท ${label} ไม่ได้ เพราะมีสิทธิ์มากกว่าของคุณ (${over.join(', ')}) ให้เจ้าของร้านเป็นผู้กำหนด`, { perms: over });
  }
  return { role, shopRoleId, label };
}
