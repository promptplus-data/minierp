/** Customer returns (REQ-M08-06): searchable bill picker + credit note with stock back at original cost. */
import type { Tx } from '@erp/db';
import { addDays, approverRoles, calcDoc, d, fmtTHB, money, qty4 } from '@erp/core';
import { z } from 'zod';
import type { EligibleQuery, ReturnReq, SalesDoc } from '@erp/contracts';
import { verifyApproval } from '../lib/approval';
import { writeAudit } from '../lib/audit';
import { can, type Ctx, type Deps } from '../lib/context';
import { nextDocNo } from '../lib/docno';
import { E } from '../lib/errors';
import { decodeCursor, likeEscape } from '../lib/paging';
import { addLot, recordIn } from '../lib/stock';
import { requireWarehouse } from './master';
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
  for (const w of (q.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)) {
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

export async function createReturn(tx: Tx, deps: Deps, ctx: Ctx, req: ReturnBody): Promise<SalesDoc> {
  const p = can(ctx, 'sales.return');
  let approvedBy = '';
  if (p === 'apv') {
    if (!req.approval) throw E.forbidden('A return needs a manager or owner PIN', { need: 'approval' });
    const a = await verifyApproval(tx, req.approval, approverRoles('sales.return'));
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
  const picked = req.lines.map((r) => {
    if (seen.has(r.lineId)) throw E.validation(`Line ${r.lineId} appears twice`);
    seen.add(r.lineId);
    const l = srcLines.find((x) => x.id === r.lineId);
    if (!l) throw E.validation(`Line ${r.lineId} is not on ${src.no}`);
    if (!d(r.qty).gt(0)) throw E.validation('Return qty must be > 0');
    const max = d(l.qty).minus(d(l.returned_qty));
    if (d(r.qty).gt(max)) throw E.conflict(`Return qty ${qty4(r.qty)} is more than sold − already returned (${qty4(max)})`, { lineId: l.id, max: qty4(max) });
    return { l, qty: r.qty, completes: d(r.qty).eq(max) };
  });

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
  const totals = calcDoc(picked.map((x, i) => ({ qty: 1, unitPrice: amounts[i]!, vat: x.l.vat })), src.vat_mode);

  let shiftId: string | null = null;
  if (req.refund === 'cash') shiftId = (await requireOwnOpenShift(tx, ctx)).id; // cash refund is counted in the shift (BR-20)
  if (req.refund === 'credit' && d(src.ar_balance).lt(d(totals.total))) {
    throw E.conflict(`Credit refund needs an outstanding balance on ${src.no} (${src.ar_balance})`, { arBalance: src.ar_balance });
  }
  const wh = req.condition === 'good' ? await requireWarehouse(tx, req.warehouseId ?? src.warehouse_id ?? undefined) : null;

  const date = deps.today();
  const no = await nextDocNo(tx, ctx.tenantId, 'CN', date);
  const products = await tx.query<{ id: string; name: string; sku: string; kind: string }>(`select id, name, sku, kind from products where id = any($1::uuid[])`, [picked.map((x) => x.l.product_id)]);
  const prod = new Map(products.rows.map((r) => [r.id, r]));
  const payments = req.refund === 'credit' ? [] : [{ method: req.refund, amount: totals.total }];
  const docId = (await tx.query<{ id: string }>(
    `insert into docs (tenant_id, no, type, date, customer_id, customer_name, customer_phone, vat_mode, warehouse_id, shift_id,
       gross, line_disc, bill_disc, base7, exempt, vat, total, payments, created_by, ref_doc_id, ref_no, refund, condition, reason, search_text)
     values ($1,$2,'CN',$3,$4,$5,$6,$7,$8,$9,$10,'0','0',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) returning id`,
    [ctx.tenantId, no, date, src.customer_id, src.customer_name, src.customer_phone, src.vat_mode, wh?.id ?? null, shiftId,
      totals.gross, totals.base7, totals.exempt, totals.vat, totals.total, JSON.stringify(payments), ctx.userId, src.id, src.no,
      req.refund, req.condition, req.reason,
      searchText({ no, customer: { name: src.customer_name, phone: src.customer_phone }, products: picked.map((x) => prod.get(x.l.product_id)!), total: totals.total })],
  )).rows[0]!.id;

  for (const [i, x] of picked.entries()) {
    const baseQty = qty4(d(x.qty).times(d(x.l.unit_factor)));
    const isStock = prod.get(x.l.product_id)?.kind === 'stock';
    // Original FIFO unit cost of the sold line: Σ(lot qty × lot cost) / Σ qty over its stock_move_lots (BR-21).
    let unitCost: string | null = null;
    if (isStock) {
      const c = await tx.query<{ q: string | null; v: string | null }>(
        `select sum(ml.qty)::text q, sum(ml.qty * ml.unit_cost)::text v from stock_moves m join stock_move_lots ml on ml.move_id = m.id
          where m.doc_line_id = $1 and m.qty < 0`,
        [x.l.id],
      );
      const row = c.rows[0];
      unitCost = row?.q && d(row.q).gt(0) ? qty4(d(row.v).div(d(row.q))) : x.l.cogs != null && d(x.l.base_qty).gt(0) ? qty4(d(x.l.cogs).div(d(x.l.base_qty))) : '0';
    }
    const lineId = (await tx.query<{ id: string }>(
      `insert into doc_lines (tenant_id, doc_id, line_no, product_id, name, unit_name, unit_factor, qty, base_qty, unit_price, discount, net, net_after_bill, vat, cogs, src_line_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'0',$11,$11,$12,$13,$14) returning id`,
      [ctx.tenantId, docId, i + 1, x.l.product_id, x.l.name, x.l.unit_name, x.l.unit_factor, x.qty, baseQty, qty4(d(amounts[i]!).div(d(x.qty))),
        amounts[i], x.l.vat, unitCost != null ? money(d(unitCost).times(d(baseQty))) : null, x.l.id],
    )).rows[0]!.id;
    if (isStock && wh && unitCost != null) {
      const lotId = await addLot(tx, ctx, { productId: x.l.product_id, warehouseId: wh.id, qty: baseQty, unitCost, ref: no });
      await recordIn(tx, ctx, wh.id, x.l.product_id, [{ lotId, qty: baseQty, unitCost }], { docType: 'CN', docNo: no, docId, docLineId: lineId, note: `รับคืนจากลูกค้า · ${src.no}` });
    }
    await tx.query(`update doc_lines set returned_qty = returned_qty + $1 where id = $2`, [x.qty, x.l.id]);
  }
  if (req.refund === 'credit') await tx.query(`update docs set ar_balance = ar_balance - $1 where id = $2`, [totals.total, src.id]);

  await deps.hooks.beforeCommit?.('createReturn', tx);
  await writeAudit(tx, ctx, [{
    action: 'create', object: 'CN', ref: no,
    detail: `อ้างอิง ${src.no} · ฿${fmtTHB(totals.total)} · ${req.refund} · ${wh ? 'คืนเข้า ' + wh.name : 'ชำรุด'} · ${req.reason}${approvedBy}`,
  }]);
  return getDoc(tx, ctx, no);
}
