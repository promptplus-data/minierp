/**
 * M14 SCG Admin services (cloud): shops (REQ-M14-01/04), KPI (REQ-M14-03), central SCG product master with
 * recommended prices pushed to shops (REQ-M14-02), read-only support access with the shop's consent (REQ-M14-05),
 * license issuing (REQ-M19-11), sales summaries received from on-prem shops (REQ-M19-10) and whole-shop import
 * (REQ-M19-07). Every action is written to platform_audit; effects inside a shop are also in that shop's audit_log.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { z } from 'zod';
import { withTenant, type Pool, type Tx } from '@erp/db';
import type {
  AdmCentralPriceReq, AdmCentralProduct, AdmCentralUpsert, AdmKpi, AdmLicenseIssue, AdmPushReq, AdmTenant, AdmTenantCreate, AdmTenantImport,
  AdmTenantQuery, LicensePayload, SharePayload,
} from '@erp/contracts';
import { SharePayload as SharePayloadSchema } from '@erp/contracts';
import { d, money, type Role , searchTokens } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { openBox } from './box';
import { parseLicenseKey, signLicense, signingKeyFromEnv } from './license';
import { ADM_CAN, admAudit, requireAdm, withPlatform, type AdmCtx } from './platform';
import { importShop, type ShopExport } from './transfer';

type In<T extends z.ZodTypeAny> = z.output<T>;
const shopWho = (a: AdmCtx, label = 'SCG Admin') => ({ userId: null, name: `${label}: ${a.name}` });

// ---------------------------------------------------------------- shops
interface OverviewRow {
  id: string; code: string; name: string; tax_id: string; vat_registered: boolean; edition: 'cloud' | 'onprem'; region: string; customer_code: string;
  status: 'active' | 'suspended'; status_reason: string | null; created_at: Date; users: number; bills_30d: number; last_bill_at: Date | null; sales_month: string;
}
const toTenant = (r: OverviewRow): AdmTenant => ({
  id: r.id, code: r.code, name: r.name, taxId: r.tax_id, vatRegistered: r.vat_registered, edition: r.edition, region: r.region, customerCode: r.customer_code,
  status: r.status, statusReason: r.status_reason, createdAt: r.created_at.toISOString(), users: r.users, bills30d: r.bills_30d,
  lastBillAt: r.last_bill_at?.toISOString() ?? null, salesMonth: money(r.sales_month),
});

export async function listTenants(tx: Tx, q: In<typeof AdmTenantQuery>) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status) {
    params.push(q.status);
    where.push(`status = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(name ilike $${params.length} or code ilike $${params.length} or tax_id ilike $${params.length} or region ilike $${params.length} or customer_code ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<OverviewRow>(
    `select * from adm_tenant_overview() ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at desc, id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (t) => [t.created_at.toISOString(), t.id], toTenant);
}

async function tenantById(pool: Pool, id: string): Promise<AdmTenant> {
  const r = await withPlatform(pool, (tx) => tx.query<OverviewRow>(`select * from adm_tenant_overview() where id = $1`, [id]));
  if (!r.rows[0]) throw E.notFound('Shop not found');
  return toTenant(r.rows[0]);
}

/** REQ-M14-01: shop + POS warehouse + owner user created together with the owner's employee record (REQ-M01-10). */
export async function createTenant(pool: Pool, a: AdmCtx, body: In<typeof AdmTenantCreate>): Promise<AdmTenant> {
  requireAdm(a, ADM_CAN.shopsWrite);
  if (await withPlatform(pool, async (tx) => (await tx.query<{ t: boolean }>(`select adm_tenant_code_taken($1) t`, [body.code])).rows[0]!.t)) {
    throw E.conflict(`Shop code ${body.code} is already used`, { reason: 'CODE_TAKEN' });
  }
  const tenantId = (await withPlatform(pool, (tx) => tx.query<{ id: string }>(`select gen_random_uuid() id`))).rows[0]!.id;
  const pw = await argon2.hash(body.owner.password, { type: argon2.argon2id });
  const pin = await argon2.hash(body.owner.pin, { type: argon2.argon2id });
  await withTenant(pool, tenantId, async (tx) => {
    await tx.query(
      `insert into tenants (id, code, name, tax_id, branch, address, phone, vat_registered, adm_edition, adm_region, adm_customer_code, adm_terms_required)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'cloud',$9,$10,true)`,
      [tenantId, body.code, body.name, body.taxId, body.branch, body.address, body.phone, body.vatRegistered, body.region, body.customerCode],
    );
    await tx.query(`insert into warehouses (tenant_id, code, name, is_pos) values ($1,'WH1','หน้าร้าน',true)`, [tenantId]);
    const u = await tx.query<{ id: string }>(
      `insert into users (tenant_id, username, name, role, password_hash, pin_hash, phone) values ($1,$2,$3,'owner',$4,$5,$6) returning id`,
      [tenantId, body.owner.username, body.owner.name, pw, pin, body.phone || null],
    );
    await tx.query(
      `insert into employees (tenant_id, code, name, position, emp_type, start_date, sso, leave_ent, user_id)
       values ($1,'OWN001',$2,'เจ้าของกิจการ','owner',(now() at time zone 'Asia/Bangkok')::date,false,$3,$4)`,
      [tenantId, body.owner.name, JSON.stringify({ sick: 0, personal: 0, vacation: 0, maternity: 0, other: 0 }), u.rows[0]!.id],
    );
    await writeAudit(tx, { tenantId, ...shopWho(a) }, [{ action: 'create', object: 'tenant', ref: body.code, detail: `เปิดร้าน ${body.name} · เจ้าของ ${body.owner.username}` }]);
  });
  await withPlatform(pool, (tx) => admAudit(tx, a, 'create', 'tenant', body.code, `${body.name} · ${body.taxId}`));
  return tenantById(pool, tenantId);
}

/** REQ-M14-04: suspended shops cannot sign in or call the API (terms.ts shopStatusGuard); data stays complete. */
export async function setTenantStatus(pool: Pool, a: AdmCtx, id: string, status: 'active' | 'suspended', reason: string): Promise<AdmTenant> {
  requireAdm(a, ADM_CAN.shopsWrite);
  if (!isUuid(id)) throw E.notFound('Shop not found');
  const code = await withTenant(pool, id, async (tx) => {
    const t = (await tx.query<{ code: string; adm_status: string }>(`select code, adm_status from tenants where id = $1 for update`, [id])).rows[0];
    if (!t) throw E.notFound('Shop not found');
    if (t.adm_status === status) throw E.conflict(`Shop is already ${status}`);
    await tx.query(`update tenants set adm_status = $2, adm_status_reason = $3 where id = $1`, [id, status, status === 'suspended' ? reason : null]);
    await writeAudit(tx, { tenantId: id, ...shopWho(a) }, [{ action: status === 'suspended' ? 'suspend' : 'resume', object: 'tenant', ref: t.code, detail: reason }]);
    return t.code;
  });
  await withPlatform(pool, (tx) => admAudit(tx, a, status === 'suspended' ? 'suspend' : 'resume', 'tenant', code, reason));
  return tenantById(pool, id);
}

/** REQ-M19-07: decrypt the on-prem export and load it into a NEW cloud shop (verified totals, transfer.ts). */
export async function importTenant(pool: Pool, a: AdmCtx, body: In<typeof AdmTenantImport>) {
  requireAdm(a, ADM_CAN.shopsWrite);
  const { payload, meta } = openBox<ShopExport>(body.file, body.passphrase, 'shop-export');
  if (await withPlatform(pool, async (tx) => (await tx.query<{ t: boolean }>(`select adm_tenant_code_taken($1) t`, [body.code])).rows[0]!.t)) {
    throw E.conflict(`Shop code ${body.code} is already used`, { reason: 'CODE_TAKEN' });
  }
  const res = await importShop(pool, payload, {
    code: body.code, edition: 'cloud', region: body.region, who: shopWho(a), termsRequired: true,
    detail: `ย้ายจาก On-premise ขึ้น Cloud · ไฟล์ ${meta.createdAt} · ร้านเดิม ${payload.source.code}`,
  });
  await withPlatform(pool, (tx) => admAudit(tx, a, 'import', 'tenant', body.code,
    `${meta.shopName} · ${res.verified.rows} แถว ${res.verified.tables} ตาราง · ยอดตรงกันทุกตาราง`));
  return { tenant: await tenantById(pool, res.tenantId), tables: res.tables, verified: res.verified };
}

/** REQ-M14-05: read-only look at a shop, only while the shop's own grant is active; the shop sees it in its log. */
export async function supportView(pool: Pool, a: AdmCtx, id: string) {
  requireAdm(a, ADM_CAN.support);
  if (!isUuid(id)) throw E.notFound('Shop not found');
  const out = await withTenant(pool, id, async (tx) => {
    const shop = (await tx.query<{ code: string; name: string; tax_id: string; vat_registered: boolean }>(`select code, name, tax_id, vat_registered from tenants where id = $1`, [id])).rows[0];
    if (!shop) throw E.notFound('Shop not found');
    const g = (await tx.query<{ expires_at: Date; by: string }>(
      `select g.expires_at, u.name by from support_grants g join users u on u.id = g.granted_by
        where g.revoked_at is null and g.expires_at > now() order by g.expires_at desc limit 1`)).rows[0];
    if (!g) throw E.forbidden('The shop has not granted support access (or it expired)', { reason: 'NO_SUPPORT_GRANT' });
    const users = await tx.query<{ username: string; name: string; role: Role; status: string; locked: boolean }>(
      `select username, name, role, status, locked_at is not null locked from users order by role = 'owner' desc, username`);
    const counts: Record<string, number> = {};
    for (const t of ['products', 'customers', 'vendors', 'warehouses', 'docs', 'stock_lots', 'employees']) {
      counts[t] = Number((await tx.query<{ n: string }>(`select count(*)::text n from ${t}`)).rows[0]!.n);
    }
    const docs = await tx.query<{ no: string; type: string; date: string; total: string; status: string }>(
      `select no, type, date, total::text, status from docs order by created_at desc, id desc limit 10`);
    const audit = await tx.query<{ at: Date; user_name: string; action: string; object: string; ref: string | null }>(
      `select at, user_name, action, object, ref from audit_log order by chain_seq desc limit 20`);
    await writeAudit(tx, { tenantId: id, ...shopWho(a, 'SCG Support') }, [{ action: 'support-view', object: 'tenant', ref: shop.code, detail: `ดูข้อมูลร้านแบบอ่านอย่างเดียว · สิทธิ์ถึง ${g.expires_at.toISOString()}` }]);
    return {
      shop: { code: shop.code, name: shop.name, taxId: shop.tax_id, vatRegistered: shop.vat_registered },
      grant: { expiresAt: g.expires_at.toISOString(), grantedBy: g.by },
      users: users.rows, counts,
      recentDocs: docs.rows.map((x) => ({ ...x, total: money(x.total) })),
      recentAudit: audit.rows.map((x) => ({ at: x.at.toISOString(), user: x.user_name, action: x.action, object: x.object, ref: x.ref })),
    };
  });
  await withPlatform(pool, (tx) => admAudit(tx, a, 'support-view', 'tenant', out.shop.code));
  return out;
}

// ---------------------------------------------------------------- KPI (REQ-M14-03, OQ-07: KPI = registered shops)
export async function kpi(tx: Tx, today: string): Promise<AdmKpi> {
  const shops = (await tx.query<OverviewRow>(`select * from adm_tenant_overview()`)).rows;
  // On-prem shops are counted from the license registry (one per tax id), active = sent a sales summary in 30 days.
  const onprem = (await tx.query<{ tax_id: string; region: string; first: Date; active: boolean }>(
    `select l.tax_id, (array_agg(l.region order by l.issued_at))[1] region, min(l.issued_at) first,
            exists (select 1 from sales_share_inbox i where i.tax_id = l.tax_id and i.received_at >= now() - interval '30 days') active
       from license_registry l where l.revoked_at is null group by l.tax_id`)).rows;
  const months: string[] = [];
  const [y, m] = today.split('-').map(Number) as [number, number];
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const ym = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' }).format(x).slice(0, 7);
  const active = (s: OverviewRow) => s.bills_30d > 0;
  const regions = new Map<string, { total: number; active30: number }>();
  const bump = (region: string, isActive: boolean) => {
    const k = region || 'ไม่ระบุภาค';
    const v = regions.get(k) ?? { total: 0, active30: 0 };
    v.total++;
    if (isActive) v.active30++;
    regions.set(k, v);
  };
  shops.forEach((s) => bump(s.region, active(s)));
  onprem.forEach((s) => bump(s.region, s.active));
  const cloudActive = shops.filter(active).length;
  const onpremActive = onprem.filter((s) => s.active).length;
  return {
    asOf: today,
    total: shops.length + onprem.length, byEdition: { cloud: shops.length, onprem: onprem.length },
    active30: cloudActive + onpremActive, active30ByEdition: { cloud: cloudActive, onprem: onpremActive },
    newPerMonth: months.map((mo) => ({ month: mo, cloud: shops.filter((s) => ym(s.created_at) === mo).length, onprem: onprem.filter((s) => ym(s.first) === mo).length })),
    byRegion: [...regions.entries()].map(([region, v]) => ({ region, ...v })).sort((p, q) => q.total - p.total || p.region.localeCompare(q.region)),
    suspended: shops.filter((s) => s.status === 'suspended').length,
  };
}

// ---------------------------------------------------------------- central SCG master (REQ-M14-02)
interface CentralRow {
  id: string; sku: string; name: string; category: string; units: { name: string; factor: string }[]; barcode: string | null; image_url: string | null;
  vat: 'v7' | 'exempt'; active: boolean; p_retail: string | null; p_wholesale: string | null; p_from: string | null;
  n_retail: string | null; n_wholesale: string | null; n_from: string | null;
}
const CENTRAL_SELECT = `select c.id, c.sku, c.name, c.category, c.units, c.barcode, c.image_url, c.vat, c.active,
    p.retail::text p_retail, p.wholesale::text p_wholesale, p.effective_from p_from, n.retail::text n_retail, n.wholesale::text n_wholesale, n.effective_from n_from
  from central_products c
  left join lateral (select * from central_prices x where x.product_id = c.id and x.effective_from <= $1 order by x.effective_from desc, x.created_at desc limit 1) p on true
  left join lateral (select * from central_prices x where x.product_id = c.id and x.effective_from > $1 order by x.effective_from, x.created_at desc limit 1) n on true`;
const toCentral = (r: CentralRow): AdmCentralProduct => ({
  id: r.id, sku: r.sku, name: r.name, category: r.category, units: r.units.map((u) => ({ name: u.name, factor: d(u.factor).toString() })), barcode: r.barcode,
  imageUrl: r.image_url, vat: r.vat, active: r.active,
  price: r.p_retail ? { retail: money(r.p_retail), wholesale: money(r.p_wholesale!), effectiveFrom: r.p_from! } : null,
  nextPrice: r.n_retail ? { retail: money(r.n_retail), wholesale: money(r.n_wholesale!), effectiveFrom: r.n_from! } : null,
});

/** Readable by every shop and SCG Admin (central catalogue is not shop data). */
export async function listCentral(tx: Tx, today: string, q: { q?: string; limit: number; cursor?: string }) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [today];
  const where: string[] = [];
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(c.sku ilike $${params.length} or c.name ilike $${params.length} or c.category ilike $${params.length} or coalesce(c.barcode,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(c.sku, c.id) > ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<CentralRow>(`${CENTRAL_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by c.sku, c.id limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.sku, x.id], (x) => toCentral(x));
}

async function centralOne(tx: Tx, id: string, today: string): Promise<AdmCentralProduct> {
  if (!isUuid(id)) throw E.notFound('Product not found');
  const r = await tx.query<CentralRow>(`${CENTRAL_SELECT} where c.id = $2`, [today, id]);
  if (!r.rows[0]) throw E.notFound('Product not found');
  return toCentral(r.rows[0]);
}

const checkUnits = (units: { name: string; factor: string }[]) => {
  if (!d(units[0]!.factor).eq(1)) throw E.validation('The first unit is the base unit (factor 1)');
  if (units.some((u) => !d(u.factor).gt(0))) throw E.validation('Unit factors must be above 0');
};

export async function upsertCentral(tx: Tx, a: AdmCtx, today: string, id: string | null, body: In<typeof AdmCentralUpsert>): Promise<AdmCentralProduct> {
  requireAdm(a, ADM_CAN.masterWrite);
  checkUnits(body.units);
  const vals = [body.sku, body.name, body.category, JSON.stringify(body.units), body.barcode || null, body.imageUrl || null, body.vat, body.active];
  let pid: string;
  if (id) {
    if (!isUuid(id)) throw E.notFound('Product not found');
    const r = await tx.query<{ id: string }>(
      `update central_products set sku=$2, name=$3, category=$4, units=$5, barcode=$6, image_url=$7, vat=$8, active=$9, updated_at=now() where id = $1 returning id`, [id, ...vals]);
    if (!r.rows[0]) throw E.notFound('Product not found');
    pid = id;
  } else {
    pid = (await tx.query<{ id: string }>(
      `insert into central_products (sku, name, category, units, barcode, image_url, vat, active, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [...vals, a.name])).rows[0]!.id;
  }
  await admAudit(tx, a, id ? 'update' : 'create', 'central-product', body.sku, body.name);
  return centralOne(tx, pid, today);
}

export async function addCentralPrice(tx: Tx, a: AdmCtx, today: string, id: string, body: In<typeof AdmCentralPriceReq>): Promise<AdmCentralProduct> {
  requireAdm(a, ADM_CAN.masterWrite);
  const p = await centralOne(tx, id, today);
  await tx.query(`insert into central_prices (product_id, retail, wholesale, effective_from, created_by) values ($1,$2,$3,$4,$5)`,
    [id, body.retail, body.wholesale, body.effectiveFrom, a.name]);
  await admAudit(tx, a, 'price', 'central-product', p.sku, `ราคาแนะนำ ${p.price?.retail ?? '-'} → ${body.retail} มีผล ${body.effectiveFrom}`);
  return centralOne(tx, id, today);
}

/**
 * Pushes central products into shops. Master fields (sku, name, category, units, barcode, VAT) are SCG's; the
 * recommended price lands in adm_srp and becomes the selling price unless the shop has set its own price
 * (adm_price_custom, set by the products_central_guard trigger when the shop edits the price).
 */
export async function pushCentral(pool: Pool, a: AdmCtx, today: string, body: In<typeof AdmPushReq>) {
  requireAdm(a, ADM_CAN.masterWrite);
  const { prods, shops } = await withPlatform(pool, async (tx) => {
    const ids = body.productIds?.filter(isUuid);
    const prods = (await tx.query<CentralRow>(`${CENTRAL_SELECT} where c.active ${ids ? 'and c.id = any($2::uuid[])' : ''} order by c.sku`, ids ? [today, ids] : [today])).rows;
    const tids = body.tenantIds?.filter(isUuid);
    const shops = (await tx.query<{ id: string; code: string }>(
      `select id, code from adm_tenant_overview() where status = 'active' and edition = 'cloud' ${tids ? 'and id = any($1::uuid[])' : ''} order by code`, tids ? [tids] : [])).rows;
    return { prods, shops };
  });
  if (!prods.length) throw E.validation('No active central products to push');
  if (!shops.length) throw E.validation('No active shops to push to');
  let created = 0, updated = 0, priceApplied = 0;
  for (const s of shops) {
    await withTenant(pool, s.id, async (tx) => {
      await tx.query(`select set_config('app.central_push', 'on', true)`);
      let c = 0, u = 0, pa = 0;
      for (const p of prods) {
        const srp = p.p_retail ? money(p.p_retail) : null;
        const ex = (await tx.query<{ id: string; price: string; custom: boolean; units: { name: string; factor: string; price?: string }[] }>(
          `select id, price::text, adm_price_custom custom, units from products where adm_central_id = $1 or (adm_central_id is null and sku = $2)
            order by (adm_central_id = $1) desc nulls last limit 1 for update`, [p.id, p.sku])).rows[0];
        if (ex) {
          const units = p.units.map((cu) => {
            const old = ex.units.find((o) => o.name === cu.name);
            return { name: cu.name, factor: cu.factor, ...(old?.price != null ? { price: old.price } : {}) };
          });
          const applyPrice = srp !== null && !ex.custom && !d(ex.price).eq(srp);
          await tx.query(
            `update products set sku=$2, name=$3, category=$4, units=$5, barcode=$6, vat=$7, is_scg=true, adm_central_id=$8, adm_srp=$9,
               price = case when $10 then $9::numeric else price end where id = $1`,
            [ex.id, p.sku, p.name, p.category, JSON.stringify(units), p.barcode, p.vat, p.id, srp, applyPrice]);
          u++;
          if (applyPrice) pa++;
        } else {
          await tx.query(
            `insert into products (tenant_id, sku, name, barcode, category, is_scg, kind, vat, price, cost, units, adm_central_id, adm_srp)
             values ($1,$2,$3,$4,$5,true,'stock',$6,$7,0,$8,$9,$10)`,
            [s.id, p.sku, p.name, p.barcode, p.category, p.vat, srp ?? '0', JSON.stringify(p.units), p.id, srp]);
          c++;
          if (srp) pa++;
        }
      }
      await writeAudit(tx, { tenantId: s.id, ...shopWho(a) }, [{ action: 'central-push', object: 'product', ref: null, detail: `Master กลาง SCG ${prods.length} รายการ · ใหม่ ${c} · อัปเดต ${u} · ใช้ราคาแนะนำ ${pa}` }]);
      created += c; updated += u; priceApplied += pa;
    });
  }
  await withPlatform(pool, async (tx) => {
    const target = body.tenantIds?.length ? shops.map((s) => s.code).join(',') : 'all';
    await tx.query(`insert into central_pushes (what, products, shops, target, by_name) values ($1,$2,$3,$4,$5)`,
      [body.productIds?.length ? 'selected products' : 'all products', prods.length, shops.length, target, a.name]);
    await tx.query(`update central_prices set pushed_at = now() where pushed_at is null and effective_from <= $1 and product_id = any($2::uuid[])`, [today, prods.map((p) => p.id)]);
    await admAudit(tx, a, 'push', 'central-product', target, `${prods.length} สินค้า → ${shops.length} ร้าน · ใหม่ ${created} · อัปเดต ${updated} · ราคา ${priceApplied}`);
  });
  return { shops: shops.length, products: prods.length, created, updated, priceApplied };
}

export async function listPushes(tx: Tx, q: { limit: number; cursor?: string }) {
  const cur = decodeCursor(q.cursor, 2);
  const r = await tx.query<{ id: string; at: Date; what: string; products: number; shops: number; target: string; by_name: string }>(
    `select * from central_pushes ${cur ? 'where (at, id) < ($2::timestamptz, $3::uuid)' : ''} order by at desc, id desc limit $1`,
    cur ? [q.limit + 1, cur[0], cur[1]] : [q.limit + 1]);
  return pageOf(r.rows, q.limit, (x) => [x.at.toISOString(), x.id], (x) => ({ id: x.id, at: x.at.toISOString(), what: x.what, products: x.products, shops: x.shops, target: x.target, by: x.by_name }));
}

// ---------------------------------------------------------------- licenses (REQ-M19-11 issuing side)
interface RegRow {
  license_id: string; license_key: string; shop_name: string; tax_id: string; edition: string; key_type: 'expiring' | 'lifetime'; expires_at: string | null;
  issued_at: Date; region: string; note: string; issued_by: string; revoked_at: Date | null; last_share: Date | null;
}
const toReg = (r: RegRow) => ({
  licenseId: r.license_id, key: r.license_key, shopName: r.shop_name, taxId: r.tax_id, edition: r.edition, type: r.key_type, expiresAt: r.expires_at,
  issuedAt: r.issued_at.toISOString(), region: r.region, note: r.note, issuedBy: r.issued_by, revokedAt: r.revoked_at?.toISOString() ?? null,
  lastShareAt: r.last_share?.toISOString() ?? null,
});
const REG_SELECT = `select l.*, (select max(i.received_at) from sales_share_inbox i where i.license_id = l.license_id) last_share from license_registry l`;

export async function listLicenses(tx: Tx, q: { q?: string; limit: number; cursor?: string }) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(l.shop_name ilike $${params.length} or l.tax_id ilike $${params.length} or l.license_id ilike $${params.length} or l.region ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(l.issued_at, l.license_id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<RegRow>(`${REG_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by l.issued_at desc, l.license_id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.issued_at.toISOString(), x.license_id], toReg);
}

export const newLicenseId = (now: Date) => `LIC-${now.toISOString().slice(0, 7).replace('-', '')}-${randomBytes(4).toString('hex').toUpperCase()}`;

export async function issueLicense(tx: Tx, a: AdmCtx, today: string, body: In<typeof AdmLicenseIssue>) {
  requireAdm(a, ADM_CAN.licenseWrite);
  if (body.type === 'expiring' && !body.expiresAt) throw E.validation('An expiring key needs an expiry date');
  if (body.type === 'expiring' && body.expiresAt! <= today) throw E.validation('The expiry date must be in the future');
  const key = signingKeyFromEnv();
  if (!key) throw E.validation('LICENSE_SIGNING_KEY is not configured on this server', { reason: 'SIGNING_KEY_MISSING' });
  const now = new Date();
  const payload: LicensePayload = {
    v: 1, licenseId: newLicenseId(now), shopName: body.shopName.trim(), taxId: body.taxId, edition: 'onprem', type: body.type,
    expiresAt: body.type === 'lifetime' ? null : body.expiresAt, issuedAt: now.toISOString(),
  };
  const lk = signLicense(payload, key);
  await tx.query(
    `insert into license_registry (license_id, license_key, shop_name, tax_id, edition, key_type, expires_at, issued_at, region, note, issued_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [payload.licenseId, lk, payload.shopName, payload.taxId, payload.edition, payload.type, payload.expiresAt, payload.issuedAt, body.region, body.note, a.name]);
  await admAudit(tx, a, 'issue', 'license', payload.licenseId, `${payload.shopName} · ${payload.taxId} · ${payload.expiresAt ?? 'ตลอดชีพ'}`);
  return toReg((await tx.query<RegRow>(`${REG_SELECT} where l.license_id = $1`, [payload.licenseId])).rows[0]!);
}

/** Offline keys keep working on the shop's machine; revoking stops the key from being accepted by SCG (share receiver). */
export async function revokeLicense(tx: Tx, a: AdmCtx, id: string, reason: string) {
  requireAdm(a, ADM_CAN.licenseWrite);
  const r = await tx.query(`update license_registry set revoked_at = now(), revoked_by = $2 where license_id = $1 and revoked_at is null`, [id, a.name]);
  if (!r.rowCount) throw E.notFound('License not found or already revoked');
  await admAudit(tx, a, 'revoke', 'license', id, reason);
  return toReg((await tx.query<RegRow>(`${REG_SELECT} where l.license_id = $1`, [id])).rows[0]!);
}

// ---------------------------------------------------------------- sales summaries (REQ-M19-10 receiving side)
/** Public receiver: the sender proves who it is with its signed license key; nothing else is accepted. */
export async function receiveShare(pool: Pool, body: { key?: unknown; payload?: unknown }): Promise<{ receiptId: string }> {
  if (typeof body.key !== 'string') throw E.validation('License key required', { reason: 'LICENSE_INVALID' });
  const lic = parseLicenseKey(body.key);
  const payload = SharePayloadSchema.parse(body.payload);
  if (payload.shop.taxId.replace(/\D/g, '') !== lic.taxId) throw E.validation('The summary is for another tax id than the key', { reason: 'SHOP_MISMATCH' });
  return withTenant(pool, null, async (tx) => {
    await tx.query(`select set_config('app.share_receiver', 'on', true)`);
    const reg = (await tx.query<{ revoked_at: Date | null }>(`select revoked_at from license_registry where license_id = $1`, [lic.licenseId])).rows[0];
    if (!reg) throw E.forbidden('This license key is not registered with SCG', { reason: 'LICENSE_UNKNOWN' });
    if (reg.revoked_at) throw E.forbidden('This license key was revoked', { reason: 'LICENSE_REVOKED' });
    // No RETURNING: the receiver may insert into the inbox but not read it (RLS).
    const receiptId = randomUUID();
    await tx.query(
      `insert into sales_share_inbox (id, license_id, shop_name, tax_id, from_date, to_date, payload, total) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [receiptId, lic.licenseId, payload.shop.name, lic.taxId, payload.from, payload.to, JSON.stringify(payload), payload.totals.total]);
    return { receiptId };
  });
}

export async function listShares(tx: Tx, q: { q?: string; licenseId?: string; limit: number; cursor?: string }) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.licenseId) {
    params.push(q.licenseId);
    where.push(`license_id = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(shop_name ilike $${params.length} or tax_id ilike $${params.length} or license_id ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(received_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; license_id: string; shop_name: string; tax_id: string; from_date: string; to_date: string; total: string; received_at: Date; payload: SharePayload }>(
    `select * from sales_share_inbox ${where.length ? 'where ' + where.join(' and ') : ''} order by received_at desc, id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.received_at.toISOString(), x.id], (x) => ({
    id: x.id, licenseId: x.license_id, shopName: x.shop_name, taxId: x.tax_id, from: x.from_date, to: x.to_date, total: money(x.total),
    receivedAt: x.received_at.toISOString(), payload: x.payload,
  }));
}

export async function listAdmAudit(tx: Tx, a: AdmCtx, q: { q?: string; limit: number; cursor?: string }) {
  requireAdm(a, ADM_CAN.audit);
  const cur = decodeCursor(q.cursor, 1);
  const params: unknown[] = [];
  const where: string[] = [];
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(admin_name ilike $${params.length} or action ilike $${params.length} or object ilike $${params.length} or coalesce(ref,'') ilike $${params.length} or detail ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0]);
    where.push(`id < $${params.length}::bigint`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<{ id: string; at: Date; admin_name: string; action: string; object: string; ref: string | null; detail: string }>(
    `select * from platform_audit ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (x) => [x.id], (x) => ({ id: String(x.id), at: x.at.toISOString(), admin: x.admin_name, action: x.action, object: x.object, ref: x.ref, detail: x.detail }));
}
