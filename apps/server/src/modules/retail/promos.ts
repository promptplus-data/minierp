/**
 * M15 shop promotions: discount promos and bundles (REQ-M15-01..05).
 * Below-cost promos need the owner at CREATION (REQ-M15-03); POS bills then sell at the promo price without asking
 * again (see ./pos.ts). Bills snapshot the promo, so closing or editing never changes issued bills (REQ-M15-04).
 */
import { searchTokens } from '@erp/core';
import type { Tx } from '@erp/db';
import type { Promo, PromoInput } from '@erp/contracts';
import { z } from 'zod';
import { PromoUpdate } from '@erp/contracts';
import {
  addDays, approverRoles, bundleAlloc, bundleNormalPrice, bundleSetsAvailable, d, fmtTHB, money, priceExVat, promoBelowCost, promoState, promoUnitPrice,
  qty4, sum, type PromoMode, type PromoState, type VatMode,
} from '@erp/core';
import { verifyApproval } from '../../lib/approval';
import { writeAudit, type AuditInput } from '../../lib/audit';
import { can, requirePerm, type Ctx, type Deps } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';
import { loadProducts, type ProductRow } from '../../services/master';
import { daysBetween, iso, onHand, peekCosts, posVatMode, posWarehouseId } from './common';

export interface PromoItemRow { productId: string; qtyPerSet?: string }
export interface PromoRow {
  id: string; code: string; name: string; kind: 'disc' | 'bundle'; mode: PromoMode | null; value: string | null; set_price: string | null; sku: string | null;
  items: PromoItemRow[]; channels: ('pos' | 'b2b')[]; start_date: string; end_date: string; status: 'draft' | 'active' | 'closed'; below_cost: boolean;
  below_cost_by_name: string | null; created_by_name: string; created_at: Date; updated_by_name: string | null; updated_at: Date | null;
  closed_by_name: string | null; closed_at: Date | null;
}

const PROMO_SELECT = `select p.id, p.code, p.name, p.kind, p.mode, p.value::text, p.set_price::text, p.sku, p.items, p.channels, p.start_date, p.end_date,
    p.status, p.below_cost, bu.name below_cost_by_name, cu.name created_by_name, p.created_at, uu.name updated_by_name, p.updated_at,
    xu.name closed_by_name, p.closed_at
  from retail_promos p join users cu on cu.id = p.created_by left join users bu on bu.id = p.below_cost_by
  left join users uu on uu.id = p.updated_by left join users xu on xu.id = p.closed_by`;

/** SQL predicate (on alias p, date param $n) for each user-visible state. */
const stateSql = (s: PromoState, n: number): string => ({
  draft: `p.status = 'draft'`,
  closed: `p.status = 'closed'`,
  scheduled: `p.status = 'active' and p.start_date > $${n}::date`,
  expired: `p.status = 'active' and p.end_date < $${n}::date`,
  live: `p.status = 'active' and p.start_date <= $${n}::date and p.end_date >= $${n}::date`,
}[s]);

/** Active promos live today on a channel (POS by default). */
export async function livePromos(tx: Tx, today: string, channel: 'pos' | 'b2b' = 'pos'): Promise<PromoRow[]> {
  const r = await tx.query<PromoRow>(`${PROMO_SELECT} where ${stateSql('live', 1)} and $2 = any(p.channels) order by p.code`, [today, channel]);
  return r.rows;
}

export async function getPromoRow(tx: Tx, id: string, forUpdate = false): Promise<PromoRow> {
  if (!isUuid(id)) throw E.notFound('Promotion not found');
  if (forUpdate) await tx.query(`select id from retail_promos where id = $1 for update`, [id]);
  const r = await tx.query<PromoRow>(`${PROMO_SELECT} where p.id = $1`, [id]);
  if (!r.rows[0]) throw E.notFound('Promotion not found');
  return r.rows[0];
}

// ---------- evaluation: promo prices, FIFO cost, below-cost lines ----------

interface Shape { kind: 'disc' | 'bundle'; mode?: PromoMode | null; value?: string | null; setPrice?: string | null; items: PromoItemRow[] }
interface Evaluated {
  lines: Promo['lines']; belowCost: string[]; normalSetPrice: string | null; setCost: string | null; products: Map<string, ProductRow>;
}

/** Prices every product of a promo against the cost the next POS sale would take (mockup `promoLow`). */
async function evaluate(tx: Tx, ctx: Ctx, s: Shape, vatMode: VatMode, wh: string | null): Promise<Evaluated> {
  const products = await loadProducts(tx, s.items.map((i) => i.productId));
  const seeCost = can(ctx, 'data.cost') === 1;
  if (s.kind === 'disc') {
    const costs = await peekCosts(tx, wh, s.items.map((i) => ({ productId: i.productId, qty: '1' })));
    const lines = s.items.map((it, i) => {
      const p = products.get(it.productId)!;
      const promoPrice = promoUnitPrice(s.mode ?? 'pct', s.value ?? '0', p.price, 1);
      const cost = p.kind === 'stock' ? costs[i] ?? null : null;
      const below = promoBelowCost(priceExVat(promoPrice, vatMode, p.vat), cost);
      return { productId: p.id, name: p.name, sku: p.sku, unitName: p.units[0]!.name, qtyPerSet: null, normalPrice: money(p.price), promoPrice, unitCost: seeCost ? cost : null, belowCost: below };
    });
    return { lines, belowCost: lines.filter((l) => l.belowCost).map((l) => l.name), normalSetPrice: null, setCost: null, products };
  }
  const comps = s.items.map((it) => ({ p: products.get(it.productId)!, qty: it.qtyPerSet ?? '0' }));
  const costs = await peekCosts(tx, wh, comps.map((c) => ({ productId: c.p.id, qty: c.qty })));
  const alloc = bundleAlloc(comps.map((c) => ({ productId: c.p.id, qtyPerSet: c.qty, normalPrice: c.p.price })), 1, s.setPrice ?? '0');
  const setCost = sum(comps.map((c, i) => (c.p.kind === 'stock' && costs[i] ? d(costs[i]!).times(d(c.qty)) : d(0))));
  const setExVat = sum(comps.map((c, i) => priceExVat(alloc[i]!.amount, vatMode, c.p.vat)));
  const below = setCost.gt(0) && setExVat.lt(setCost.minus('0.005'));
  const lines = comps.map((c, i) => ({
    productId: c.p.id, name: c.p.name, sku: c.p.sku, unitName: c.p.units[0]!.name, qtyPerSet: qty4(c.qty), normalPrice: money(c.p.price),
    promoPrice: d(c.qty).gt(0) ? money(d(alloc[i]!.amount).div(d(c.qty))) : null,
    unitCost: seeCost && c.p.kind === 'stock' ? costs[i] ?? null : null, belowCost: below,
  }));
  return {
    lines, belowCost: below ? ['ทั้งชุด'] : [],
    normalSetPrice: bundleNormalPrice(comps.map((c) => ({ qtyPerSet: c.qty, normalPrice: c.p.price }))),
    setCost: seeCost ? money(setCost) : null, products,
  };
}

function validateShape(s: Shape & { start: string; end: string; name?: string }): void {
  if (s.end < s.start) throw E.validation('End date must not be before the start date');
  const ids = s.items.map((i) => i.productId);
  if (new Set(ids).size !== ids.length) throw E.validation('A product appears twice in the promotion');
  if (s.kind === 'disc') {
    if (!s.mode || s.value == null) throw E.validation('A discount promotion needs mode and value');
    if (!d(s.value).gt(0)) throw E.validation('Discount must be > 0');
    if (s.mode === 'pct' && d(s.value).gt(100)) throw E.validation('Percent discount must be 0..100');
  } else {
    if (!s.setPrice || !d(s.setPrice).gt(0)) throw E.validation('A bundle needs a set price > 0');
    if (s.items.some((i) => !i.qtyPerSet || !d(i.qtyPerSet).gt(0))) throw E.validation('Every bundle component needs qty per set > 0');
    const pieces = sum(s.items.map((i) => i.qtyPerSet ?? '0'));
    if (s.items.length < 2 && !pieces.gt(1)) throw E.validation('A bundle needs at least 2 pieces');
  }
}

/** REQ: one product may be in only one active discount promo for overlapping dates (mockup clash rule). */
async function clashes(tx: Tx, s: Shape & { start: string; end: string }, selfId: string | null) {
  if (s.kind !== 'disc') return [];
  const r = await tx.query<{ code: string; name: string; items: PromoItemRow[] }>(
    `select code, name, items from retail_promos where kind = 'disc' and status = 'active' and id is distinct from $1::uuid
        and not (end_date < $2::date or start_date > $3::date)`,
    [selfId, s.start, s.end],
  );
  const mine = new Set(s.items.map((i) => i.productId));
  return r.rows.filter((x) => x.items.some((i) => mine.has(i.productId))).map((x) => ({ code: x.code, name: x.name }));
}

async function checkSku(tx: Tx, sku: string | null | undefined, selfId: string | null): Promise<void> {
  if (!sku) return;
  const p = await tx.query(`select 1 from products where sku = $1`, [sku]);
  const q = await tx.query(`select 1 from retail_promos where sku = $1 and id is distinct from $2::uuid`, [sku, selfId]);
  if (p.rowCount || q.rowCount) throw E.conflict(`SKU ${sku} is already used`);
}

/** Owner saving confirms it; anyone else needs the owner's PIN (owner only, BR-16). Returns the confirming owner. */
async function confirmBelowCost(tx: Tx, deps: Deps, ctx: Ctx, ev: Evaluated, name: string, approval?: { approverUserId: string; pin: string }): Promise<{ id: string; name: string }> {
  const seeCost = can(ctx, 'data.cost') === 1;
  const detail = ev.lines.filter((l) => l.belowCost).map((l) => ({ productId: l.productId, name: l.name, ...(seeCost ? { sell: l.promoPrice, cost: l.unitCost } : {}) }));
  if (ctx.role === 'owner') return { id: ctx.userId, name: ctx.name };
  if (!approval) throw E.belowCost(`Promotion "${name}" sells below cost; the owner must confirm it`, { lines: detail, belowCost: ev.belowCost });
  const a = await verifyApproval(tx, deps.pool, ctx, approval, approverRoles('sales.belowCost'), `โปรต่ำกว่าทุน ${name}`);
  if (!a.ok) throw E.belowCost('Below-cost promotion needs the owner\'s PIN', { lines: detail, belowCost: ev.belowCost, approvalError: a.reason });
  return a.approver;
}

// ---------- reads ----------

interface Stats { bills: number; qty: string; sales: string }
async function statsFor(tx: Tx, ids: string[]): Promise<Map<string, Stats>> {
  if (!ids.length) return new Map();
  const r = await tx.query<{ promo_id: string; bills: number; qty: string; sales: string }>(
    `select l.retail_promo_id promo_id, count(distinct l.doc_id)::int bills,
            coalesce(sum(case when l.retail_bundle_no is null then l.qty - l.returned_qty end), 0)
              + coalesce((select sum(b.sets) from (select distinct x.doc_id, x.retail_bundle_no, x.retail_bundle_sets * (1 - x.returned_qty / x.qty) sets
                     from doc_lines x join docs y on y.id = x.doc_id
                    where x.retail_promo_id = l.retail_promo_id and x.retail_bundle_no is not null and y.status = 'active' and y.type in ('ABB','INV','RC')) b), 0) qty,
            coalesce(sum(l.net_after_bill * (l.qty - l.returned_qty) / l.qty), 0)::numeric(14,2)::text sales
       from doc_lines l join docs dd on dd.id = l.doc_id
      where l.retail_promo_id = any($1::uuid[]) and dd.status = 'active' and dd.type in ('ABB','INV','RC')
      group by l.retail_promo_id`,
    [ids],
  );
  return new Map(r.rows.map((x) => [x.promo_id, { bills: x.bills, qty: qty4(x.qty), sales: money(x.sales) }]));
}

async function toPromos(tx: Tx, ctx: Ctx, deps: Deps, rows: PromoRow[]): Promise<Promo[]> {
  const vatMode = await posVatMode(tx, ctx.tenantId);
  const wh = await posWarehouseId(tx);
  const stats = await statsFor(tx, rows.map((r) => r.id));
  const today = deps.today();
  const out: Promo[] = [];
  for (const r of rows) {
    const ev = await evaluate(tx, ctx, { kind: r.kind, mode: r.mode, value: r.value, setPrice: r.set_price, items: r.items }, vatMode, wh);
    let setsAvailable: number | null = null;
    if (r.kind === 'bundle') {
      const have = await onHand(tx, wh, r.items.map((i) => i.productId));
      setsAvailable = bundleSetsAvailable(r.items.map((i) => ({
        qtyPerSet: i.qtyPerSet ?? '0', have: ev.products.get(i.productId)?.kind === 'stock' ? have.get(i.productId) ?? '0' : '1e9',
      })));
    }
    out.push({
      id: r.id, code: r.code, name: r.name, kind: r.kind, mode: r.mode, value: r.value != null ? qty4(r.value) : null,
      setPrice: r.set_price != null ? money(r.set_price) : null, normalSetPrice: ev.normalSetPrice, sku: r.sku,
      lines: ev.lines, channels: r.channels, start: r.start_date, end: r.end_date, status: r.status,
      state: promoState({ status: r.status, start: r.start_date, end: r.end_date }, today),
      belowCost: r.below_cost, belowCostBy: r.below_cost_by_name,
      createdBy: r.created_by_name, createdAt: r.created_at.toISOString(), updatedBy: r.updated_by_name, updatedAt: iso(r.updated_at),
      closedBy: r.closed_by_name, closedAt: iso(r.closed_at), setsAvailable,
      stats: stats.get(r.id) ?? { bills: 0, qty: '0', sales: '0.00' },
    });
  }
  return out;
}

export async function listPromos(tx: Tx, deps: Deps, ctx: Ctx, q: { q?: string; limit: number; cursor?: string; state?: PromoState; kind?: 'disc' | 'bundle' }) {
  requirePerm(ctx, 'promo.manage', { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [deps.today()];
  const where: string[] = [];
  if (q.state) where.push(stateSql(q.state, 1));
  if (q.kind) {
    params.push(q.kind);
    where.push(`p.kind = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(p.name ilike $${params.length} or p.code ilike $${params.length} or coalesce(p.sku,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  // $1 (today) is referenced only by state filters; keep it typed when unused.
  where.push(`$1::date is not null`);
  const r = await tx.query<PromoRow>(`${PROMO_SELECT} where ${where.join(' and ')} order by p.created_at desc, p.id desc limit $${params.length}`, params);
  const pg = pageOf(r.rows, q.limit, (x) => [x.created_at.toISOString(), x.id], (x) => x);
  return { items: await toPromos(tx, ctx, deps, pg.items), nextCursor: pg.nextCursor };
}

export async function getPromo(tx: Tx, deps: Deps, ctx: Ctx, id: string): Promise<Promo> {
  requirePerm(ctx, 'promo.manage', { readOnly: true });
  return (await toPromos(tx, ctx, deps, [await getPromoRow(tx, id)]))[0]!;
}

/** Preview for the promo form: promo prices, cost, below-cost lines and clashes (nothing is saved). */
export async function checkPromo(tx: Tx, ctx: Ctx, body: PromoInput) {
  requirePerm(ctx, 'promo.manage');
  const s = shapeOf(body);
  validateShape({ ...s, start: body.start, end: body.end });
  const ev = await evaluate(tx, ctx, s, await posVatMode(tx, ctx.tenantId), await posWarehouseId(tx));
  return { lines: ev.lines, belowCost: ev.belowCost, clashes: await clashes(tx, { ...s, start: body.start, end: body.end }, null), normalSetPrice: ev.normalSetPrice, setCost: ev.setCost };
}

const shapeOf = (b: { kind: 'disc' | 'bundle'; mode?: PromoMode; value?: string; setPrice?: string; items: { productId: string; qtyPerSet?: string }[] }): Shape => ({
  kind: b.kind, mode: b.kind === 'disc' ? b.mode ?? null : null, value: b.kind === 'disc' ? b.value ?? null : null,
  setPrice: b.kind === 'bundle' ? b.setPrice ?? null : null,
  items: b.items.map((i) => (b.kind === 'bundle' ? { productId: i.productId, qtyPerSet: qty4(i.qtyPerSet ?? '0') } : { productId: i.productId })),
});

const promoText = (s: Shape, name: string) => `${name} · ${s.kind === 'bundle' ? `ชุดโปร ฿${fmtTHB(s.setPrice ?? 0)}` : s.mode === 'pct' ? `ลด ${qty4(s.value ?? 0)}%` : s.mode === 'amt' ? `ลด ${fmtTHB(s.value ?? 0)} บาท/หน่วย` : `ราคาโปร ${fmtTHB(s.value ?? 0)}`}`;

// ---------- writes ----------

export async function createPromo(tx: Tx, deps: Deps, ctx: Ctx, body: PromoInput): Promise<Promo> {
  requirePerm(ctx, 'promo.manage');
  const s = shapeOf(body);
  validateShape({ ...s, start: body.start, end: body.end });
  if (s.kind === 'bundle') await checkSku(tx, body.sku, null);
  const ev = await evaluate(tx, ctx, s, await posVatMode(tx, ctx.tenantId), await posWarehouseId(tx));
  for (const p of ev.products.values()) if (!p.active) throw E.validation(`Product ${p.sku} is inactive`);
  const status = body.draft ? 'draft' : 'active';
  if (status === 'active') {
    const c = await clashes(tx, { ...s, start: body.start, end: body.end }, null);
    if (c.length) throw E.conflict(`Products already in an overlapping promotion: ${c.map((x) => x.code).join(', ')}`, { clashes: c });
  }
  const audits: AuditInput[] = [];
  let by: { id: string; name: string } | null = null;
  if (status === 'active' && ev.belowCost.length) {
    by = await confirmBelowCost(tx, deps, ctx, ev, body.name, body.belowCostApproval);
    audits.push({ action: 'approve', object: 'below-cost', detail: `โปร "${body.name}" ราคาต่ำกว่าทุน: ${ev.belowCost.join(', ')} · ${by.id === ctx.userId ? 'เจ้าของร้าน (ยืนยันเอง)' : 'อนุมัติโดย ' + by.name}` });
  }
  const code = await nextDocNo(tx, ctx.tenantId, 'PR', deps.today());
  const r = await tx.query<{ id: string }>(
    `insert into retail_promos (tenant_id, code, name, kind, mode, value, set_price, sku, items, channels, start_date, end_date, status, below_cost, below_cost_by, below_cost_detail, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
    [ctx.tenantId, code, body.name, s.kind, s.mode, s.value, s.setPrice, s.kind === 'bundle' ? body.sku ?? null : null, JSON.stringify(s.items), body.channels,
      body.start, body.end, status, !!by, by?.id ?? null, by ? ev.belowCost.join(', ') : null, ctx.userId],
  );
  audits.push({ action: 'create', object: 'promotion', ref: code, detail: `${promoText(s, body.name)} · ${body.start}–${body.end} · ${body.channels.join('/')}${status === 'draft' ? ' · ร่าง' : ''}` });
  await writeAudit(tx, ctx, audits);
  return getPromo(tx, deps, ctx, r.rows[0]!.id);
}

export async function updatePromo(tx: Tx, deps: Deps, ctx: Ctx, id: string, body: z.infer<typeof PromoUpdate>): Promise<Promo> {
  requirePerm(ctx, 'promo.manage');
  const row = await getPromoRow(tx, id, true);
  if (row.status === 'closed') throw E.conflict(`${row.code} is closed; create a new promotion instead`);
  const next = {
    name: body.name ?? row.name,
    mode: body.mode ?? row.mode ?? undefined,
    value: body.value ?? row.value ?? undefined,
    setPrice: body.setPrice ?? row.set_price ?? undefined,
    items: body.items ?? row.items,
    channels: body.channels ?? row.channels,
    start: body.start ?? row.start_date,
    end: body.end ?? row.end_date,
    sku: body.sku ?? row.sku,
  };
  const s = shapeOf({ kind: row.kind, mode: next.mode, value: next.value, setPrice: next.setPrice, items: next.items });
  validateShape({ ...s, start: next.start, end: next.end });
  if (row.kind === 'bundle' && next.sku !== row.sku) await checkSku(tx, next.sku, row.id);
  const status = body.draft === false && row.status === 'draft' ? 'active' : row.status;
  if (status === 'active') {
    const c = await clashes(tx, { ...s, start: next.start, end: next.end }, row.id);
    if (c.length) throw E.conflict(`Products already in an overlapping promotion: ${c.map((x) => x.code).join(', ')}`, { clashes: c });
  }
  const ev = await evaluate(tx, ctx, s, await posVatMode(tx, ctx.tenantId), await posWarehouseId(tx));
  const priceChanged = JSON.stringify([s.mode, s.value && qty4(s.value), s.setPrice && money(s.setPrice), s.items])
    !== JSON.stringify([row.mode, row.value && qty4(row.value), row.set_price && money(row.set_price), row.items]);
  const audits: AuditInput[] = [];
  let belowCost = row.below_cost && !priceChanged;
  let belowBy: string | null = null;
  if (status === 'active' && ev.belowCost.length && !belowCost) {
    const by = await confirmBelowCost(tx, deps, ctx, ev, next.name, body.belowCostApproval);
    belowCost = true;
    belowBy = by.id;
    audits.push({ action: 'approve', object: 'below-cost', detail: `โปร "${next.name}" ราคาต่ำกว่าทุน: ${ev.belowCost.join(', ')} · ${by.id === ctx.userId ? 'เจ้าของร้าน (ยืนยันเอง)' : 'อนุมัติโดย ' + by.name}` });
  }
  if (!ev.belowCost.length) belowCost = false;
  const diffs: string[] = [];
  const diff = (label: string, a: unknown, b: unknown) => { if (String(a ?? '') !== String(b ?? '')) diffs.push(`${label}: ${a ?? '-'} → ${b ?? '-'}`); };
  diff('ชื่อ', row.name, next.name);
  diff('ช่วง', `${row.start_date}–${row.end_date}`, `${next.start}–${next.end}`);
  diff('ส่วนลด', row.mode && `${row.mode} ${qty4(row.value ?? 0)}`, s.mode && `${s.mode} ${qty4(s.value ?? 0)}`);
  diff('ราคาชุด', row.set_price && money(row.set_price), s.setPrice && money(s.setPrice));
  diff('ช่องทาง', row.channels.join('/'), next.channels.join('/'));
  if (JSON.stringify(row.items) !== JSON.stringify(s.items)) diffs.push('แก้รายการสินค้า');
  if (status !== row.status) diffs.push('ร่าง → ใช้งาน');
  await tx.query(
    `update retail_promos set name = $2, mode = $3, value = $4, set_price = $5, sku = $6, items = $7, channels = $8, start_date = $9, end_date = $10, status = $11,
       below_cost = $12, below_cost_by = case when $12 then coalesce($13::uuid, below_cost_by) else null end,
       below_cost_detail = case when $12 then $14 else null end, updated_by = $15, updated_at = now() where id = $1`,
    [row.id, next.name, s.mode, s.value, s.setPrice, row.kind === 'bundle' ? next.sku : null, JSON.stringify(s.items), next.channels, next.start, next.end, status,
      belowCost, belowBy, ev.belowCost.join(', '), ctx.userId],
  );
  audits.push({ action: 'update', object: 'promotion', ref: row.code, detail: diffs.join(' · ') || 'ไม่มีการเปลี่ยนแปลง' });
  await writeAudit(tx, ctx, audits);
  return getPromo(tx, deps, ctx, row.id);
}

/** draft → active (runs the clash and below-cost checks). */
export async function activatePromo(tx: Tx, deps: Deps, ctx: Ctx, id: string, approval?: { approverUserId: string; pin: string }): Promise<Promo> {
  const row = await getPromoRow(tx, id);
  if (row.status !== 'draft') throw E.conflict(`${row.code} is not a draft`);
  return updatePromo(tx, deps, ctx, id, { draft: false, belowCostApproval: approval });
}

/** REQ-M15-04: close early. New bills stop using it at once; issued bills keep their snapshot. */
export async function closePromo(tx: Tx, deps: Deps, ctx: Ctx, id: string, reason?: string): Promise<Promo> {
  requirePerm(ctx, 'promo.manage');
  const row = await getPromoRow(tx, id, true);
  if (row.status === 'closed') throw E.conflict(`${row.code} is already closed`);
  await tx.query(`update retail_promos set status = 'closed', closed_by = $2, closed_at = now() where id = $1`, [row.id, ctx.userId]);
  const st = promoState({ status: row.status, start: row.start_date, end: row.end_date }, deps.today());
  await writeAudit(tx, ctx, [{ action: 'close', object: 'promotion', ref: row.code, detail: `${row.name} · ปิดก่อนกำหนด (เดิม ${st}, ถึง ${row.end_date})${reason ? ' · ' + reason : ''}` }]);
  return getPromo(tx, deps, ctx, row.id);
}

// ---------- REQ-M11-07 / REQ-M15-05 promo P&L (data for group E) ----------

interface PnlAgg { bills: number; sets: string; qty: string; sales: string; sales_ex: string; discount: string; cogs: string }

export async function promoPnl(tx: Tx, deps: Deps, ctx: Ctx, q: { from?: string; to?: string; promoId?: string }) {
  if (![can(ctx, 'rep.view'), can(ctx, 'promo.manage')].some((v) => v === 1 || v === 'ro')) throw E.forbidden('Permission rep.view or promo.manage is required');
  const seeCost = can(ctx, 'data.cost') === 1;
  const params: unknown[] = [];
  const where: string[] = [`p.status <> 'draft'`];
  if (q.promoId) {
    if (!isUuid(q.promoId)) throw E.notFound('Promotion not found');
    params.push(q.promoId);
    where.push(`p.id = $${params.length}`);
  }
  if (q.from) {
    params.push(q.from);
    where.push(`p.end_date >= $${params.length}::date`);
  }
  if (q.to) {
    params.push(q.to);
    where.push(`p.start_date <= $${params.length}::date`);
  }
  const promos = (await tx.query<PromoRow>(`${PROMO_SELECT} where ${where.join(' and ')} order by p.start_date desc, p.code`, params)).rows;
  const today = deps.today();
  const lineAgg = (filter: string) => `
    select count(distinct l.doc_id)::int bills,
      coalesce((select sum(b.sets) from (select distinct x.doc_id, x.retail_bundle_no, x.retail_bundle_sets * (1 - x.returned_qty / x.qty) sets from doc_lines x
                join docs y on y.id = x.doc_id where ${filter.replace(/\bl\./g, 'x.').replace(/\bdd\./g, 'y.')} and x.retail_bundle_no is not null) b), 0)::text sets,
      coalesce(sum(l.base_qty * (l.qty - l.returned_qty) / l.qty), 0)::text qty,
      coalesce(sum(l.net_after_bill * (l.qty - l.returned_qty) / l.qty), 0)::text sales,
      coalesce(sum(case when dd.vat_mode = 'inc' and l.vat = 'v7' then l.net_after_bill / 1.07 else l.net_after_bill end * (l.qty - l.returned_qty) / l.qty), 0)::text sales_ex,
      coalesce(sum((coalesce(l.retail_list_price, l.unit_price) * l.qty - l.net) * (l.qty - l.returned_qty) / l.qty), 0)::text discount,
      coalesce(sum(coalesce(l.cogs, 0) * (l.qty - l.returned_qty) / l.qty), 0)::text cogs
    from doc_lines l join docs dd on dd.id = l.doc_id where ${filter}`;
  const items = [];
  for (const p of promos) {
    const from = q.from && q.from > p.start_date ? q.from : p.start_date;
    const to = q.to && q.to < p.end_date ? q.to : p.end_date;
    const a = (await tx.query<PnlAgg>(lineAgg(`l.retail_promo_id = $1 and dd.status = 'active' and dd.type in ('ABB','INV','RC') and dd.date between $2::date and $3::date`), [p.id, from, to])).rows[0]!;
    const len = daysBetween(from, to) + 1;
    const bFrom = addDays(p.start_date, -len);
    const bTo = addDays(p.start_date, -1);
    const b = (await tx.query<PnlAgg>(
      lineAgg(`l.product_id = any($1::uuid[]) and dd.status = 'active' and dd.type in ('ABB','INV','RC') and dd.date between $2::date and $3::date`),
      [p.items.map((i) => i.productId), bFrom, bTo],
    )).rows[0]!;
    const salesEx = money(a.sales_ex);
    const bSalesEx = money(b.sales_ex);
    items.push({
      promoId: p.id, code: p.code, name: p.name, kind: p.kind, state: promoState({ status: p.status, start: p.start_date, end: p.end_date }, today),
      start: p.start_date, end: p.end_date, bills: a.bills, sets: qty4(a.sets), qty: qty4(a.qty), sales: money(a.sales), salesExVat: salesEx,
      discount: money(a.discount), cogs: seeCost ? money(a.cogs) : null, grossProfit: seeCost ? money(d(salesEx).minus(d(a.cogs))) : null,
      before: { from: bFrom, to: bTo, qty: qty4(b.qty), salesExVat: bSalesEx, grossProfit: seeCost ? money(d(bSalesEx).minus(d(b.cogs))) : null },
    });
  }
  return { items };
}
