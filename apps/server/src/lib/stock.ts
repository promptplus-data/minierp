/**
 * Stock primitives shared by POS sales, transfers, issues, adjustments, voids and returns.
 * BR-07: every stock-out locks the lots it may consume (SELECT … FOR UPDATE) in the caller's transaction
 * and plans the consumption with core.takeLots; a shortage aborts before anything is written.
 * BR-21: every move records the lots / qty / unit cost it touched (stock_move_lots).
 *
 * Lock order: lots are always locked ordered by (product_id, received_at, id), so two transactions
 * touching overlapping lots can never deadlock on them.
 */
import type { Tx } from '@erp/db';
import { d, money, qty4, sum, takeLots, type Lot, type LotTake } from '@erp/core';
import type { Ctx } from './context';
import { E } from './errors';

export interface LockedLot extends Lot { id: string; productId: string; warehouseId: string; receivedAt: string; qty: string; unitCost: string; ref: string }

const LOT_COLS = `id::text as id, product_id as "productId", warehouse_id as "warehouseId",
  to_char(received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as "receivedAt",
  remaining::text as qty, unit_cost::text as "unitCost", ref`;

/** Locks every lot with remaining > 0 of these products in one warehouse. */
export async function lockLots(tx: Tx, warehouseId: string, productIds: string[]): Promise<Map<string, LockedLot[]>> {
  const out = new Map<string, LockedLot[]>();
  if (productIds.length === 0) return out;
  const r = await tx.query<LockedLot>(
    `select ${LOT_COLS} from stock_lots
      where warehouse_id = $1 and product_id = any($2::uuid[]) and remaining > 0
      order by product_id, received_at, id
      for update`,
    [warehouseId, [...new Set(productIds)]],
  );
  for (const l of r.rows) {
    const list = out.get(l.productId) ?? [];
    list.push(l);
    out.set(l.productId, list);
  }
  return out;
}

export interface Need { productId: string; qty: string }
export interface Planned { productId: string; qty: string; takes: LotTake[]; cogs: string }

/**
 * Plans FIFO consumption for each need in order (several needs may hit the same product).
 * Throws INSUFFICIENT_STOCK with every shortage (aggregated per product) before any write.
 */
export function planTakes(lots: Map<string, LockedLot[]>, warehouseId: string, needs: Need[]): Planned[] {
  const total = new Map<string, ReturnType<typeof d>>();
  for (const n of needs) total.set(n.productId, (total.get(n.productId) ?? d(0)).plus(d(n.qty)));
  const shortages = [...total.entries()]
    .map(([productId, need]) => ({ productId, need, have: sum((lots.get(productId) ?? []).map((l) => l.qty)) }))
    .filter((x) => x.have.lt(x.need))
    .map((x) => ({ productId: x.productId, warehouseId, need: qty4(x.need), have: qty4(x.have) }));
  if (shortages.length) throw E.insufficientStock(shortages);

  // Working copy so consecutive needs of one product continue where the previous one stopped.
  const work = new Map([...lots.entries()].map(([k, v]) => [k, v.map((l) => ({ ...l }))]));
  return needs.map((n) => {
    const ls = work.get(n.productId) ?? [];
    const { takes, cogs } = takeLots(ls, n.qty);
    for (const t of takes) {
      const l = ls.find((x) => x.id === t.lotId)!;
      l.qty = qty4(d(l.qty).minus(d(t.qty)));
    }
    return { productId: n.productId, qty: n.qty, takes, cogs };
  });
}

export interface MoveRef { docType: string; docNo: string; docId: string; docLineId?: string | null; note: string }

/** Writes a stock-out: decrements the lots, one ledger row (negative qty), one stock_move_lots row per lot. */
export async function applyOut(tx: Tx, ctx: Ctx, warehouseId: string, plan: Planned, ref: MoveRef): Promise<string> {
  for (const t of plan.takes) {
    await tx.query(`update stock_lots set remaining = remaining - $1 where id = $2`, [t.qty, t.lotId]);
  }
  return insertMove(tx, ctx, warehouseId, plan.productId, d(plan.qty).neg().toFixed(), plan.cogs, plan.takes, ref);
}

/** Creates a new lot (receipt, transfer-in, good return, positive adjustment). Returns the lot id. */
export async function addLot(
  tx: Tx,
  ctx: Ctx,
  l: { productId: string; warehouseId: string; qty: string; unitCost: string; ref: string; receivedAt?: string; sourceLotId?: string | null },
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `insert into stock_lots (tenant_id, product_id, warehouse_id, received_at, qty_in, remaining, unit_cost, ref, source_lot_id)
     values ($1,$2,$3,coalesce($4::timestamptz, now()),$5,$5,$6,$7,$8) returning id::text`,
    [ctx.tenantId, l.productId, l.warehouseId, l.receivedAt ? l.receivedAt + 'Z' : null, l.qty, l.unitCost, l.ref, l.sourceLotId ?? null],
  );
  return r.rows[0]!.id;
}

/** Writes a stock-in ledger row for lots that were already created or restored. */
export async function recordIn(tx: Tx, ctx: Ctx, warehouseId: string, productId: string, takes: LotTake[], ref: MoveRef): Promise<string> {
  const q = sum(takes.map((t) => t.qty));
  const cost = money(sum(takes.map((t) => d(t.qty).times(d(t.unitCost)))));
  return insertMove(tx, ctx, warehouseId, productId, qty4(q), cost, takes, ref);
}

async function insertMove(tx: Tx, ctx: Ctx, warehouseId: string, productId: string, qty: string, cost: string, takes: LotTake[], ref: MoveRef): Promise<string> {
  const m = await tx.query<{ id: string }>(
    `insert into stock_moves (tenant_id, doc_type, doc_no, doc_id, doc_line_id, product_id, warehouse_id, qty, cost, note, user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [ctx.tenantId, ref.docType, ref.docNo, ref.docId, ref.docLineId ?? null, productId, warehouseId, qty, cost, ref.note, ctx.userId],
  );
  const moveId = m.rows[0]!.id;
  for (const t of takes) {
    await tx.query(`insert into stock_move_lots (tenant_id, move_id, lot_id, qty, unit_cost) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, moveId, t.lotId, t.qty, t.unitCost]);
  }
  return moveId;
}

/**
 * Reverses every stock-out of a document back into the ORIGINAL lots (same unit cost and FIFO position), BR-22.
 * Locks those lots first in the global lot order.
 */
export async function reverseOuts(tx: Tx, ctx: Ctx, docId: string, ref: MoveRef): Promise<void> {
  const moves = await tx.query<{ id: string; product_id: string; warehouse_id: string; doc_line_id: string | null }>(
    `select id, product_id, warehouse_id, doc_line_id from stock_moves where doc_id = $1 and qty < 0 order by id`,
    [docId],
  );
  if (!moves.rowCount) return;
  const ml = await tx.query<{ move_id: string; lot_id: string; qty: string; unit_cost: string }>(
    `select move_id, lot_id::text, qty::text, unit_cost::text from stock_move_lots where move_id = any($1::uuid[])`,
    [moves.rows.map((m) => m.id)],
  );
  const lotIds = [...new Set(ml.rows.map((r) => r.lot_id))];
  await tx.query(`select id from stock_lots where id = any($1::bigint[]) order by product_id, received_at, id for update`, [lotIds]);
  for (const m of moves.rows) {
    const takes = ml.rows.filter((r) => r.move_id === m.id).map((r) => ({ lotId: r.lot_id, qty: r.qty, unitCost: r.unit_cost }));
    for (const t of takes) await tx.query(`update stock_lots set remaining = remaining + $1 where id = $2`, [t.qty, t.lotId]);
    await recordIn(tx, ctx, m.warehouse_id, m.product_id, takes, { ...ref, docLineId: m.doc_line_id });
  }
}

/** FIFO value / qty of what is left of a product (all warehouses): the cost used for positive adjustments. */
export async function currentAvgCost(tx: Tx, productId: string): Promise<string> {
  const r = await tx.query<{ q: string | null; v: string | null; cost: string }>(
    `select sum(l.remaining)::text q, sum(l.remaining * l.unit_cost)::text v, p.cost::text cost
       from products p left join stock_lots l on l.product_id = p.id and l.remaining > 0
      where p.id = $1 group by p.cost`,
    [productId],
  );
  const row = r.rows[0];
  if (!row) return '0';
  return row.q && d(row.q).gt(0) ? qty4(d(row.v).div(d(row.q))) : qty4(row.cost);
}
