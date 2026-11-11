/** Customer returns (REQ-M08-06): searchable bill picker + credit note with stock back at original cost. */
import type { Tx } from '@erp/db';
import { addDays, approverRoles, calcDoc, d, fmtTHB, money, qty4, returnArSplit, sum , searchTokens } from '@erp/core';
import { z } from 'zod';
import type { EligibleQuery, ReturnReq, SalesDoc } from '@erp/contracts';
import { verifyApproval } from '../lib/approval';
import { writeAudit } from '../lib/audit';
import { can, type Ctx, type Deps } from '../lib/context';
import { nextDocNo } from '../lib/docno';
import { E } from '../lib/errors';
import { decodeCursor, likeEscape } from '../lib/paging';
import { addLot, recordIn } from '../lib/stock';
import { damagedWarehouse, defaultSellableWarehouse, requireWarehouse } from './master';
import { getDoc, getDocRow, getLines, requireOwnOpenShift, searchText, summaries } from './sales';

type Eligible = z.infer<typeof EligibleQuery>;

/**
 * Active sales bills with something left to return. Every word of q must appear (AND) in the bill's
 * haystack: bill no, customer name / code / phone / tax ID, member id, product names / SKUs, total amount.
 * The ILIKE '%w%' predicates use the pg_trgm GIN index on docs.search_text. Newest first, cursor paged.
 */
export async function eligible(tx: Tx, deps: Deps, q: Eligible) {
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where = [`d.type in ('ABB','INV','RC')`, `d.status = 'active'`, `exists (select 1 from doc_lines l where l.doc_id = d.id and l.returned_qty < l.qty)`];
  if (q.days !== 'all') {
    params.push(addDays(deps.today(), -Number(q.days)));
    where.push(`d.date >= $${params.length}::date`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`d.search_text like $${params.length}`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(d.created_at, d.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  return summaries(tx, `where ${where.join(' and ')}`, params, q.limit);
}

type ReturnBody = z.infer<typeof ReturnReq>;

/** The warehouse the delivery orders of a B2B invoice cut stock from (invoices made from DOs carry no warehouse). */
async function deliveryWarehouse(tx: Tx, invoiceDocId: string): Promise<string | null> {
  const r = await tx.query<{ warehouse_id: string }>(
    `select dv.warehouse_id from sales_invoice_deliveries sid join sales_deliveries dv on dv.id = sid.delivery_id join warehouses w on w.id = dv.warehouse_id
      where sid.invoice_doc_id = $1 and w.active and w.kind = 'normal' order by dv.created_at limit 1`, [invoiceDocId]);
  return r.rows[0]?.warehouse_id ?? null;
}

export async function createReturn(tx: Tx, deps: Deps, ctx: Ctx, req: ReturnBody): Promise<SalesDoc> {
  const p = can(ctx, 'sales.return');
  let approvedBy = '';
  if (p === 'apv') {
    if (!req.approval) throw E.forbidden('A return needs a manager or owner PIN', { need: 'approval' });
    const a = await verifyApproval(tx, deps.pool, ctx, req.approval, approverRoles('sales.return'), `รับคืนจาก ${req.sourceDocNo}`);
    if (!a.ok) throw E.forbidden('Return approval rejected', { approvalError: a.reason });
    approvedBy = ` · อนุมัติโดย ${a.approver.name}`;
  } else if (p !== 1) {
    throw E.forbidden('Permission sales.return is required');
  }

  const src = await getDocRow(tx, req.sourceDocNo, { forUpdate: true });
  if (!['ABB', 'INV', 'RC'].includes(src.type)) throw E.validation(`${src.no} is not a sales bill`);
  if (src.status !== 'active') throw E.conflict(`${src.no} is void`);
  const srcLines = await getLines(tx, src.id);

  const seen = new Set<string>();
  // Line condition (ดี / ชำรุด); the top-level condition is the default ('bad' from older clients = damaged).
  const fallback = req.condition === 'bad' ? 'damaged' : 'good';
  const picked = req.lines.map((r) => {
    if (seen.has(r.lineId)) throw E.validation(`Line ${r.lineId} appears twice`);
    seen.add(r.lineId);
    const l = srcLines.find((x) => x.id === r.lineId);
    if (!l) throw E.validation(`Line ${r.lineId} is not on ${src.no}`);
    if (!d(r.qty).gt(0)) throw E.validation('Return qty must be > 0');
    const max = d(l.qty).minus(d(l.returned_qty));
    if (d(r.qty).gt(max)) throw E.conflict(`Return qty ${qty4(r.qty)} is more than sold − already returned (${qty4(max)})`, { lineId: l.id, max: qty4(max) });
    return { l, qty: r.qty, completes: d(r.qty).eq(max), cond: r.condition ?? fallback };
  });

  // Module C (M15, BR-17): bundle components come back as whole sets only — every item of the set, the same number of sets.
  const bundles = new Map<number, typeof srcLines>();
  for (const l of srcLines) if (l.retail_bundle_no != null) bundles.set(l.retail_bundle_no, [...(bundles.get(l.retail_bundle_no) ?? []), l]);
  for (const [no, comps] of bundles) {
    const chosen = comps.map((c) => picked.find((x) => x.l.id === c.id));
    if (chosen.every((x) => !x)) continue;
    const sets = chosen.map((x, k) => (x && d(comps[k]!.retail_bundle_qty ?? 0).gt(0) ? d(x.qty).div(d(comps[k]!.retail_bundle_qty!)) : d(0)));
    if (!sets.every((s) => s.eq(sets[0]!)) || !sets[0]!.isInteger() || !sets[0]!.gt(0)) {
      throw E.validation(`Bundle "${comps[0]!.retail_promo_name ?? ''}" is returned as whole sets: every item × the same number of sets`, {
        bundleNo: no, lines: comps.map((c) => ({ lineId: c.id, qtyPerSet: qty4(c.retail_bundle_qty ?? 0) })),
      });
    }
  }

  // Refund per line = its share of the line's net after bill discount; the last return of a line gets the remainder.
  const refunded = await tx.query<{ src_line_id: string; amt: string }>(
    `select cl.src_line_id, sum(cl.net)::text amt from doc_lines cl join docs c on c.id = cl.doc_id
      where c.type = 'CN' and c.status = 'active' and cl.src_line_id = any($1::uuid[]) group by cl.src_line_id`,
    [picked.map((x) => x.l.id)],
  );
  const already = new Map(refunded.rows.map((r) => [r.src_line_id, r.amt]));
  const amounts = picked.map((x) =>
    x.completes ? money(d(x.l.net_after_bill).minus(d(already.get(x.l.id) ?? 0))) : money(d(x.l.net_after_bill).times(d(x.qty)).div(d(x.l.qty))),
  );
  // Module C (BR-17): a partial bundle return refunds exactly its share of the set revenue (rounded once per bundle,
  // the satang difference on the last component), so returning 1 of 2 sets gives back the set price.
  for (const comps of bundles.values()) {
    const idx = comps.map((c) => picked.findIndex((x) => x.l.id === c.id));
    if (idx.some((i) => i < 0) || idx.every((i) => picked[i]!.completes)) continue;
    const share = d(picked[idx[0]!]!.qty).div(d(picked[idx[0]!]!.l.qty));
    const target = money(sum(idx.map((i) => d(picked[i]!.l.net_after_bill))).times(share));
    const last = idx[idx.length - 1]!;
    amounts[last] = money(d(amounts[last]!).plus(d(target).minus(sum(idx.map((i) => d(amounts[i]!))))));
  }
  const totals = calcDoc(picked.map((x, i) => ({ qty: 1, unitPrice: amounts[i]!, vat: x.l.vat })), src.vat_mode);

  // A bill still owed (credit invoice, POS credit bill) is credited first, up to what is still owed on it; only the
  // rest goes back as money (cash / transfer) or, with refund 'credit', stays as a customer credit on the statement.
  const split = returnArSplit(totals.total, src.ar_balance);
  const refundMoney = req.refund === 'credit' ? '0.00' : split.over;
  if (req.refund === 'credit' && d(split.over).gt(0)) {
    const sale = await tx.query<{ kind: string }>(`select kind from sales_invoices where doc_id = $1`, [src.id]);
    if (!src.customer_id || sale.rows[0]?.kind !== 'credit') {
      throw E.conflict(`Only ${split.toAr} is still owed on ${src.no}; refund the rest in cash or by transfer`, { arBalance: src.ar_balance, toAr: split.toAr, over: split.over });
    }
  }
  let shiftId: string | null = null;
  if (req.refund === 'cash' && d(refundMoney).gt(0)) shiftId = (await requireOwnOpenShift(tx, ctx)).id; // cash refund is counted in the shift (BR-20)
  const products = await tx.query<{ id: string; name: string; sku: string; kind: string }>(`select id, name, sku, kind from products where id = any($1::uuid[])`, [picked.map((x) => x.l.product_id)]);
  const prod = new Map(products.rows.map((r) => [r.id, r]));
  const isStock = (x: (typeof picked)[number]) => prod.get(x.l.product_id)?.kind === 'stock';

  // Good goods go back to a sellable warehouse: the one asked for, else the bill's, else the warehouse its delivery
  // orders cut (B2B invoice from DOs), else the default. Damaged goods go to the damaged-goods warehouse, created on
  // the first damaged return (system-created "คลังสินค้าชำรุด", audited with this credit note).
  const goodWh = picked.some((x) => x.cond === 'good' && isStock(x))
    ? await requireWarehouse(tx, req.warehouseId ?? src.warehouse_id ?? (await deliveryWarehouse(tx, src.id)) ?? (await defaultSellableWarehouse(tx)) ?? undefined)
    : null;
  const dmg = picked.some((x) => x.cond === 'damaged' && isStock(x)) ? await damagedWarehouse(tx, ctx) : null;
  const whOf = (x: (typeof picked)[number]) => (x.cond === 'damaged' ? dmg?.wh : goodWh) ?? null;
  const docCondition = picked.every((x) => x.cond === 'good') ? 'good' : picked.every((x) => x.cond === 'damaged') ? 'bad' : 'mixed';
  const note = req.note?.trim() ?? '';

  const date = deps.today();
  const no = await nextDocNo(tx, ctx.tenantId, 'CN', date);
  const payments = d(refundMoney).gt(0) ? [{ method: req.refund, amount: refundMoney }] : [];
  const docId = (await tx.query<{ id: string }>(
    `insert into docs (tenant_id, no, type, date, customer_id, customer_name, customer_phone, vat_mode, warehouse_id, shift_id,
       gross, line_disc, bill_disc, base7, exempt, vat, total, payments, created_by, ref_doc_id, ref_no, refund, condition, reason, search_text, note, ar_applied)
     values ($1,$2,'CN',$3,$4,$5,$6,$7,$8,$9,$10,'0','0',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id`,
    [ctx.tenantId, no, date, src.customer_id, src.customer_name, src.customer_phone, src.vat_mode, (goodWh ?? dmg?.wh)?.id ?? null, shiftId,
      totals.gross, totals.base7, totals.exempt, totals.vat, totals.total, JSON.stringify(payments), ctx.userId, src.id, src.no,
      req.refund, docCondition, req.reason,
      searchText({ no, customer: { name: src.customer_name, phone: src.customer_phone }, products: picked.map((x) => prod.get(x.l.product_id)!), total: totals.total }), note, split.toAr],
  )).rows[0]!.id;

  for (const [i, x] of picked.entries()) {
    const baseQty = qty4(d(x.qty).times(d(x.l.unit_factor)));
    const stock = isStock(x);
    const wh = whOf(x);
    // Original FIFO unit cost of the sold line: Σ(lot qty × lot cost) / Σ qty over its stock_move_lots (BR-21).
    let unitCost: string | null = null;
    if (stock) {
      const c = await tx.query<{ q: string | null; v: string | null }>(
        `select sum(ml.qty)::text q, sum(ml.qty * ml.unit_cost)::text v from stock_moves m join stock_move_lots ml on ml.move_id = m.id
          where m.doc_line_id = $1 and m.qty < 0`,
        [x.l.id],
      );
      const row = c.rows[0];
      unitCost = row?.q && d(row.q).gt(0) ? qty4(d(row.v).div(d(row.q))) : x.l.cogs != null && d(x.l.base_qty).gt(0) ? qty4(d(x.l.cogs).div(d(x.l.base_qty))) : '0';
    }
    const lineId = (await tx.query<{ id: string }>(
      `insert into doc_lines (tenant_id, doc_id, line_no, product_id, name, unit_name, unit_factor, qty, base_qty, unit_price, discount, net, net_after_bill, vat, cogs, src_line_id, return_condition, free)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'0',$11,$11,$12,$13,$14,$15,$16) returning id`,
      [ctx.tenantId, docId, i + 1, x.l.product_id, x.l.name, x.l.unit_name, x.l.unit_factor, x.qty, baseQty, qty4(d(amounts[i]!).div(d(x.qty))),
        amounts[i], x.l.vat, unitCost != null ? money(d(unitCost).times(d(baseQty))) : null, x.l.id, x.cond, x.l.free === true],
    )).rows[0]!.id;
    // Back into stock at the original FIFO cost as a new lot (BR-21); damaged goods into the damaged-goods warehouse.
    if (stock && wh && unitCost != null) {
      const lotId = await addLot(tx, ctx, { productId: x.l.product_id, warehouseId: wh.id, qty: baseQty, unitCost, ref: no });
      await recordIn(tx, ctx, wh.id, x.l.product_id, [{ lotId, qty: baseQty, unitCost }], {
        docType: 'CN', docNo: no, docId, docLineId: lineId, note: `${x.cond === 'damaged' ? 'รับคืนสินค้าชำรุด' : 'รับคืนจากลูกค้า'} · ${src.no}`,
      });
    }
    await tx.query(`update doc_lines set returned_qty = returned_qty + $1 where id = $2`, [x.qty, x.l.id]);
  }
  if (d(split.toAr).gt(0)) await tx.query(`update docs set ar_balance = ar_balance - $1 where id = $2`, [split.toAr, src.id]);

  await deps.hooks.beforeCommit?.('createReturn', tx);
  const where = [goodWh ? 'คืนเข้า ' + goodWh.name : '', dmg ? `ชำรุด → ${dmg.wh.name}` : ''].filter(Boolean).join(' · ');
  await writeAudit(tx, ctx, [
    ...(dmg?.created ? [{ action: 'create', object: 'warehouse', ref: dmg.wh.code, detail: `สร้าง${dmg.wh.name}อัตโนมัติ (คลังของเสีย ไม่ใช่คลังขาย) จากการรับคืนสินค้าชำรุด ${no}` }] : []),
    {
      action: 'create', object: 'CN', ref: no,
      detail: `อ้างอิง ${src.no} · ฿${fmtTHB(totals.total)} · ${d(split.toAr).gt(0) ? `ลดยอดค้าง ฿${fmtTHB(split.toAr)} · ` : ''}${d(refundMoney).gt(0) ? `คืนเงิน ${req.refund} ฿${fmtTHB(refundMoney)}` : req.refund === 'credit' && d(split.over).gt(0) ? `เครดิตลูกค้า ฿${fmtTHB(split.over)}` : req.refund} · ${where || 'ไม่มีสินค้าสต็อก'} · ${req.reason}${note ? ' · ' + note : ''}${approvedBy}`,
    },
  ]);
  return getDoc(tx, ctx, no);
}
