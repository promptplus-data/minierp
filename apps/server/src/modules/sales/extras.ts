/**
 * Pickers and live checks for the B2B forms:
 * - customer address book (ship-to picker): saved addresses + the customer's own address + project sites,
 * - salespeople (salesperson picker),
 * - line check: below cost per line for everyone, unit cost / profit only for data.cost users (BR-16, server is the authority).
 */
import type { Tx } from '@erp/db';
import type { CustomerAddress, SalesLineCheck, SalesPerson } from '@erp/contracts';
import { checkBelowCost, d, netUnitPricesExVat, type VatMode } from '@erp/core';
import type { z } from 'zod';
import type { SalesLineCheckReq } from '@erp/contracts';
import { writeAudit } from '../../lib/audit';
import { can, requireAny, type Ctx } from '../../lib/context';
import { isUuid } from '../../lib/errors';
import { requireWarehouse } from '../../services/master';
import { buildLines, coreLine, loadCustomer, peekUnitCosts, profitOf } from './common';

export async function customerAddresses(tx: Tx, customerId: string): Promise<{ items: CustomerAddress[] }> {
  const c = await loadCustomer(tx, customerId);
  const own = (await tx.query<{ address: string }>(`select address from customers where id = $1`, [c.id])).rows[0]?.address ?? '';
  const saved = await tx.query<{ id: string; label: string; address: string }>(
    `select id, label, address from customer_addresses where customer_id = $1 and active order by created_at desc limit 200`, [c.id]);
  const sites = await tx.query<{ id: string; name: string; site: string }>(
    `select id, name, site from sales_projects where customer_id = $1 and status = 'active' and site <> '' order by created_at desc limit 50`, [c.id]);
  const items: CustomerAddress[] = [];
  const seen = new Set<string>();
  const push = (x: CustomerAddress) => {
    const k = x.address.trim();
    if (!k || seen.has(k)) return;
    seen.add(k);
    items.push(x);
  };
  if (own.trim()) push({ id: `customer:${c.id}`, kind: 'customer', label: 'ที่อยู่ลูกค้า', address: own.trim() });
  for (const s of sites.rows) push({ id: `project:${s.id}`, kind: 'project', label: `หน้างาน ${s.name}`, address: s.site.trim() });
  for (const a of saved.rows) push({ id: a.id, kind: 'saved', label: a.label || 'ที่อยู่ที่บันทึกไว้', address: a.address });
  return { items };
}

export async function addCustomerAddress(tx: Tx, ctx: Ctx, customerId: string, req: { address: string; label: string }): Promise<CustomerAddress> {
  requireAny(ctx, ['sales.doc', 'data.master', 'inv.receive']);
  const c = await loadCustomer(tx, customerId);
  const address = req.address.trim().replace(/\s+/g, ' ');
  const have = await tx.query<{ id: string; label: string }>(`select id, label from customer_addresses where customer_id = $1 and address = $2 and active`, [c.id, address]);
  if (have.rows[0]) return { id: have.rows[0].id, kind: 'saved', label: have.rows[0].label || 'ที่อยู่ที่บันทึกไว้', address };
  const id = (await tx.query<{ id: string }>(
    `insert into customer_addresses (tenant_id, customer_id, label, address, created_by) values ($1,$2,$3,$4,$5) returning id`,
    [ctx.tenantId, c.id, req.label.trim(), address, ctx.userId],
  )).rows[0]!.id;
  await writeAudit(tx, ctx, [{ action: 'create', object: 'customer-address', ref: c.code, detail: `${c.name} · ${address}` }]);
  return { id, kind: 'saved', label: req.label.trim() || 'ที่อยู่ที่บันทึกไว้', address };
}

export async function salesPeople(tx: Tx): Promise<{ items: SalesPerson[] }> {
  const r = await tx.query<{ id: string; name: string; phone: string | null; role: string }>(
    `select id, name, phone, role from users where status = 'active' and role in ('owner','manager','sales','cashier') order by case role when 'sales' then 0 when 'manager' then 1 when 'owner' then 2 else 3 end, name`);
  return { items: r.rows };
}

/** Below cost per line against the FIFO cost the lines would take (warehouse given, else all warehouses). */
export async function lineCheck(tx: Tx, ctx: Ctx, req: z.infer<typeof SalesLineCheckReq>): Promise<SalesLineCheck> {
  const idx = req.lines.flatMap((l, i) => (l.productId && isUuid(l.productId) && d(l.qty).gt(0) ? [i] : []));
  const lines = await buildLines(tx, idx.map((i) => ({ ...req.lines[i]!, productId: req.lines[i]!.productId! })), { allowFree: false });
  const wh = req.warehouseId ? (await requireWarehouse(tx, req.warehouseId)).id : null;
  const vatMode = req.vatMode as VatMode;
  const costs = await peekUnitCosts(tx, wh, lines);
  const sell = netUnitPricesExVat(lines.map((l) => ({ ...coreLine(l), baseQty: l.baseQty })), vatMode, req.billDiscount);
  const below = new Set(checkBelowCost(lines.map((l, i) => ({ netUnitExVat: sell[i] ?? '0', unitCost: l.giveaway ? null : costs[i] }))));
  const seeCost = can(ctx, 'data.cost') === 1;
  const pr = seeCost ? profitOf(lines, vatMode, req.billDiscount, costs) : null;
  const out: SalesLineCheck['lines'] = req.lines.map(() => ({ belowCost: false, unitCost: null, profit: null }));
  idx.forEach((orig, k) => {
    out[orig] = { belowCost: below.has(k), unitCost: pr?.lines[k]?.unitCost ?? null, profit: pr?.lines[k]?.profit ?? null };
  });
  return { lines: out, profit: pr?.total ?? null };
}
