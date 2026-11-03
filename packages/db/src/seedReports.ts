/**
 * Demo data for M11 reports / M12 export on top of seedDemo(): two weeks of POS sales (ABB, a few full tax
 * invoices, one voided bill, one credit note), each consuming FIFO lots with ledger rows exactly like the server
 * does, plus the shop GL mapping. Idempotent: does nothing when the first demo bill already exists.
 *
 *   await seedReports(client, tenantId)                     // inside withTenant(...) or as a superuser
 *   await seedReports(client, tenantId, { today: '2026-10-26' })
 *
 * CLI (browser tests): DATABASE_URL=... tsx src/seedReports.ts [tenant-code]   (default tenant code: charoen)
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  DEFAULT_DOC_PATTERN, addDays, calcDoc, d, docPeriodKey, formatDocNo, money, qty4, takeLots,
} from '@erp/core';

type Q = Pick<pg.ClientBase, 'query'>;

const bangkokToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const key = (i: number) => `5eed0e00-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** Bills: [days ago, customer key or null, kind, lines [sku, qty]]; prices are the product's retail price incl VAT. */
const BILLS: [number, string | null, 'abb' | 'inv', [string, number][]][] = [
  [27, null, 'abb', [['SCG-CEM-T50', 4], ['PVC-4-85', 2]]], [27, null, 'abb', [['SCG-AAC-75', 40]]],
  [26, 'C00003', 'abb', [['SCG-TA-20', 2]]], [25, null, 'abb', [['SCG-CEM-T50', 2], ['SV-DLV', 1]]],
  [24, 'C00001', 'inv', [['SCG-CEM-T50', 6], ['RB9-10', 10], ['SV-DLV', 1]]], [23, null, 'abb', [['SCG-ROOF-LK', 20]]],
  [22, null, 'abb', [['PVC-4-85', 3]]], [21, null, 'abb', [['SCG-CEM-T50', 3], ['SCG-TA-20', 1]]],
  [20, 'C00002', 'inv', [['SCG-AAC-75', 60], ['SCG-ROOF-LK', 25]]], [19, null, 'abb', [['PNT-PR9', 1]]],
  [18, null, 'abb', [['RB9-10', 6]]], [17, 'C00003', 'abb', [['SCG-CEM-T50', 2], ['PVC-4-85', 4]]],
  [16, null, 'abb', [['SCG-AAC-75', 30]]], [15, null, 'abb', [['SCG-TA-20', 2], ['SV-DLV', 1]]],
  [14, 'C00001', 'inv', [['RB9-10', 12], ['SCG-CEM-T50', 4]]], [13, null, 'abb', [['SCG-ROOF-LK', 15]]],
  [12, null, 'abb', [['SCG-CEM-T50', 3]]], [11, null, 'abb', [['PVC-4-85', 2], ['RB9-10', 2]]],
  [10, null, 'abb', [['SCG-AAC-75', 25], ['SCG-TA-20', 1]]], [9, 'C00002', 'inv', [['SCG-CEM-T50', 5], ['SCG-ROOF-LK', 30]]],
  [8, null, 'abb', [['PNT-PR9', 1], ['PVC-4-85', 1]]], [7, null, 'abb', [['SCG-CEM-T50', 2]]],
  [6, null, 'abb', [['RB9-10', 4]]], [5, 'C00003', 'abb', [['SCG-AAC-75', 20], ['SV-DLV', 1]]],
  [4, null, 'abb', [['SCG-TA-20', 2]]], [3, null, 'abb', [['SCG-CEM-T50', 2], ['SCG-ROOF-LK', 10]]],
  [2, null, 'abb', [['PVC-4-85', 2]]], [1, null, 'abb', [['SCG-CEM-T50', 1], ['RB9-10', 3]]],
];
/** Index into BILLS of the bill that is voided, and of the bill partly returned with a credit note. */
const VOID_AT = 6;
const RETURN_AT = 12;

export async function seedReports(c: Q, tenantId: string, opts: { today?: string } = {}): Promise<{ docs: number }> {
  if ((await c.query(`select 1 from docs where tenant_id = $1 and idempotency_key = $2`, [tenantId, key(0)])).rowCount) return { docs: 0 };
  const today = opts.today ?? bangkokToday();
  const one = async <T extends pg.QueryResultRow>(sql: string, p: unknown[]) => (await c.query<T>(sql, p)).rows[0]!;
  const owner = await one<{ id: string }>(`select id from users where tenant_id = $1 and role = 'owner' order by created_at limit 1`, [tenantId]);
  const cashier = (await c.query<{ id: string }>(`select id from users where tenant_id = $1 and username = 'prae'`, [tenantId])).rows[0] ?? owner;
  const wh = await one<{ id: string }>(`select id from warehouses where tenant_id = $1 and is_pos order by code limit 1`, [tenantId]);
  const prods = new Map((await c.query<{ id: string; sku: string; name: string; price: string; vat: 'v7' | 'exempt'; kind: string; units: { name: string }[] }>(
    `select id, sku, name, price::text, vat, kind, units from products where tenant_id = $1`, [tenantId])).rows.map((p) => [p.sku, p]));
  const custs = new Map((await c.query<{ id: string; code: string; name: string; phone: string | null }>(`select id, code, name, phone from customers where tenant_id = $1`, [tenantId])).rows.map((x) => [x.code, x]));

  await c.query(`insert into report_gl_map (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId]);

  // continue after whatever the shop already issued (any POS device), so the demo never collides with real documents
  const counters = new Map<string, number>();
  const used = await c.query<{ type: string; period: string; seq: number }>(`select type, period, max(seq)::int seq from doc_counters where tenant_id = $1 group by 1, 2`, [tenantId]);
  for (const u of used.rows) counters.set(`${u.type}|${u.period}`, u.seq);
  const nextNo = (type: string, date: string) => {
    const k = `${type}|${docPeriodKey(DEFAULT_DOC_PATTERN, date)}`;
    const n = (counters.get(k) ?? 0) + 1;
    counters.set(k, n);
    return formatDocNo(DEFAULT_DOC_PATTERN, { type, date, seq: n });
  };
  const at = (date: string, i: number) => `${date}T${String(9 + (i % 9)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}:00+07:00`;
  const made: { id: string; no: string; date: string; lines: { id: string; productId: string; qty: string; net: string; vat: 'v7' | 'exempt'; moveLots: { lotId: string; qty: string; unitCost: string }[] }[] }[] = [];

  for (const [i, [ago, cust, kind, items]] of BILLS.entries()) {
    const date = addDays(today, -Math.ceil(ago / 2)); // two weeks, after the opening lots
    const shift = await one<{ id: string }>(
      `insert into shifts (tenant_id, no, user_id, device_id, opened_at, closed_at, float, counted, expected, diff)
       values ($1,$2,$3,'POS-1',$4,$5,1000,1000,1000,0) on conflict (tenant_id, no) do update set no = excluded.no returning id`,
      [tenantId, `SHD-${date}`, cashier.id, `${date}T08:30:00+07:00`, `${date}T19:00:00+07:00`],
    );
    const lines = items.map(([sku, q]) => ({ p: prods.get(sku)!, qty: String(q) }));
    const t = calcDoc(lines.map((l) => ({ qty: l.qty, unitPrice: l.p.price, vat: l.p.vat })), 'inc');
    const customer = cust ? custs.get(cust)! : null;
    const type = kind === 'inv' ? 'INV' : 'ABB';
    const no = nextNo(type, date);
    const when = at(date, i);
    const doc = await one<{ id: string }>(
      `insert into docs (tenant_id, no, type, date, customer_id, customer_name, customer_phone, vat_mode, warehouse_id, shift_id, device_id,
         gross, line_disc, bill_disc, base7, exempt, vat, total, payments, created_by, idempotency_key, search_text, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,'inc',$8,$9,'POS-1',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`,
      [tenantId, no, type, date, customer?.id ?? null, customer?.name ?? 'ลูกค้าทั่วไป', customer?.phone ?? null, wh.id, shift.id,
        t.gross, t.lineDisc, t.billDisc, t.base7, t.exempt, t.vat, t.total, JSON.stringify([{ method: i % 3 ? 'cash' : 'transfer', amount: t.total }]), cashier.id, key(i),
        [no, customer?.name, ...lines.flatMap((l) => [l.p.name, l.p.sku]), t.total].filter(Boolean).join(' ').toLowerCase(), when],
    );
    const out: (typeof made)[number] = { id: doc.id, no, date, lines: [] };
    for (const [j, l] of lines.entries()) {
      let takes: { lotId: string; qty: string; unitCost: string }[] = [];
      let cogs: string | null = null;
      if (l.p.kind === 'stock') {
        const lots = (await c.query<{ id: string; receivedAt: string; qty: string; unitCost: string }>(
          `select id::text, received_at::text "receivedAt", remaining::text qty, unit_cost::text "unitCost" from stock_lots
            where tenant_id = $1 and product_id = $2 and warehouse_id = $3 and remaining > 0 order by received_at, id`, [tenantId, l.p.id, wh.id])).rows;
        const plan = takeLots(lots, l.qty);
        takes = plan.takes;
        cogs = plan.cogs;
      }
      const line = await one<{ id: string }>(
        `insert into doc_lines (tenant_id, doc_id, line_no, product_id, name, unit_name, unit_factor, qty, base_qty, unit_price, discount, net, net_after_bill, vat, cogs)
         values ($1,$2,$3,$4,$5,$6,1,$7,$7,$8,0,$9,$10,$11,$12) returning id`,
        [tenantId, doc.id, j + 1, l.p.id, l.p.name, l.p.units[0]?.name ?? '', l.qty, l.p.price, t.lines[j]!.net, t.lines[j]!.after, l.p.vat, cogs],
      );
      if (takes.length) {
        for (const tk of takes) await c.query(`update stock_lots set remaining = remaining - $1 where id = $2`, [tk.qty, tk.lotId]);
        const mv = await one<{ id: string }>(
          `insert into stock_moves (tenant_id, at, doc_type, doc_no, doc_id, doc_line_id, product_id, warehouse_id, qty, cost, note, user_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ขายหน้าร้าน',$11) returning id`,
          [tenantId, when, type, no, doc.id, line.id, l.p.id, wh.id, d(l.qty).neg().toFixed(), cogs, cashier.id],
        );
        for (const tk of takes) await c.query(`insert into stock_move_lots (tenant_id, move_id, lot_id, qty, unit_cost) values ($1,$2,$3,$4,$5)`, [tenantId, mv.id, tk.lotId, tk.qty, tk.unitCost]);
      }
      out.lines.push({ id: line.id, productId: l.p.id, qty: l.qty, net: t.lines[j]!.after, vat: l.p.vat, moveLots: takes });
    }
    made.push(out);
  }

  // A voided bill: stock back into the same lots, number kept (BR-03 / BR-22).
  const v = made[VOID_AT]!;
  const vAt = `${v.date}T18:00:00+07:00`;
  for (const l of v.lines.filter((x) => x.moveLots.length)) {
    for (const tk of l.moveLots) await c.query(`update stock_lots set remaining = remaining + $1 where id = $2`, [tk.qty, tk.lotId]);
    const cost = money(l.moveLots.reduce((a, tk) => a.plus(d(tk.qty).times(d(tk.unitCost))), d(0)));
    const mv = await one<{ id: string }>(
      `insert into stock_moves (tenant_id, at, doc_type, doc_no, doc_id, doc_line_id, product_id, warehouse_id, qty, cost, note, user_id)
       values ($1,$2,'ABB',$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [tenantId, vAt, v.no, v.id, l.id, l.productId, wh.id, l.qty, cost, `คืนสต็อก · ยกเลิก ${v.no}`, owner.id],
    );
    for (const tk of l.moveLots) await c.query(`insert into stock_move_lots (tenant_id, move_id, lot_id, qty, unit_cost) values ($1,$2,$3,$4,$5)`, [tenantId, mv.id, tk.lotId, tk.qty, tk.unitCost]);
  }
  await c.query(`update docs set status = 'void', void_by = $2, void_at = $3, void_reason = 'ออกบิลผิด (ราคา / จำนวน / สินค้า)' where id = $1`, [v.id, owner.id, vAt]);

  // A credit note for 5 of the 30 AAC blocks of one bill, restocked at the original FIFO cost (BR-21).
  const src = made[RETURN_AT]!;
  const sl = src.lines[0]!;
  const back = '5';
  const amount = money(d(sl.net).times(d(back)).div(d(sl.qty)));
  const t = calcDoc([{ qty: '1', unitPrice: amount, vat: sl.vat }], 'inc');
  const cnDate = addDays(src.date, 2);
  const cnNo = nextNo('CN', cnDate);
  const srcRow = await one<{ customer_id: string | null; customer_name: string; customer_phone: string | null }>(`select customer_id, customer_name, customer_phone from docs where id = $1`, [src.id]);
  const unitCost = qty4(sl.moveLots.reduce((a, tk) => a.plus(d(tk.qty).times(d(tk.unitCost))), d(0)).div(d(sl.qty)));
  const cn = await one<{ id: string }>(
    `insert into docs (tenant_id, no, type, date, customer_id, customer_name, customer_phone, vat_mode, warehouse_id, gross, line_disc, bill_disc, base7, exempt, vat, total,
       payments, created_by, ref_doc_id, ref_no, refund, condition, reason, search_text, created_at)
     values ($1,$2,'CN',$3,$4,$5,$6,'inc',$7,$8,0,0,$9,$10,$11,$12,$13,$14,$15,$16,'cash','good','ลูกค้าซื้อเกิน ใช้ไม่หมด',$17,$18) returning id`,
    [tenantId, cnNo, cnDate, srcRow.customer_id, srcRow.customer_name, srcRow.customer_phone, wh.id, t.gross, t.base7, t.exempt, t.vat, t.total,
      JSON.stringify([{ method: 'cash', amount: t.total }]), owner.id, src.id, src.no, `${cnNo} ${src.no}`, `${cnDate}T16:00:00+07:00`],
  );
  const cogs = money(d(unitCost).times(d(back)));
  const cnLine = await one<{ id: string }>(
    `insert into doc_lines (tenant_id, doc_id, line_no, product_id, name, unit_name, unit_factor, qty, base_qty, unit_price, discount, net, net_after_bill, vat, cogs, src_line_id)
     select $1, $2, 1, product_id, name, unit_name, 1, $3, $3, $4, 0, $5, $5, vat, $6, id from doc_lines where id = $7 returning id`,
    [tenantId, cn.id, back, qty4(d(amount).div(d(back))), amount, cogs, sl.id],
  );
  await c.query(`update doc_lines set returned_qty = returned_qty + $1 where id = $2`, [back, sl.id]);
  const lot = await one<{ id: string }>(
    `insert into stock_lots (tenant_id, product_id, warehouse_id, received_at, qty_in, remaining, unit_cost, ref) values ($1,$2,$3,$4,$5,$5,$6,$7) returning id::text`,
    [tenantId, sl.productId, wh.id, `${cnDate}T16:00:00+07:00`, back, unitCost, cnNo],
  );
  const mv = await one<{ id: string }>(
    `insert into stock_moves (tenant_id, at, doc_type, doc_no, doc_id, doc_line_id, product_id, warehouse_id, qty, cost, note, user_id)
     values ($1,$2,'CN',$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [tenantId, `${cnDate}T16:00:00+07:00`, cnNo, cn.id, cnLine.id, sl.productId, wh.id, back, cogs, `รับคืนจากลูกค้า · ${src.no}`, owner.id],
  );
  await c.query(`insert into stock_move_lots (tenant_id, move_id, lot_id, qty, unit_cost) values ($1,$2,$3,$4,$5)`, [tenantId, mv.id, lot.id, back, unitCost]);

  for (const [k, seq] of counters) {
    const [type, period] = k.split('|') as [string, string];
    await c.query(
      `insert into doc_counters (tenant_id, type, period, device, seq) values ($1,$2,$3,'',$4)
       on conflict (tenant_id, type, period, device) do update set seq = greatest(doc_counters.seq, excluded.seq)`,
      [tenantId, type, period, seq],
    );
    await c.query(`update doc_counters set seq = greatest(seq, $4) where tenant_id = $1 and type = $2 and period = $3`, [tenantId, type, period, seq]);
  }
  // Two products whose shelf stock is below the reorder point after the sales above (home card, "low stock" report).
  await c.query(
    `update products p set reorder_point = greatest(10, ceil(coalesce((select sum(remaining) from stock_lots l where l.product_id = p.id), 0) * 1.5))
      where p.tenant_id = $1 and p.sku = any($2::text[])`, [tenantId, ['PNT-PR9', 'SCG-TA-20']]);
  await c.query(`insert into audit_log (tenant_id, user_name, action, object, detail) values ($1,'system','seed','reports',$2)`, [tenantId, `demo sales ${BILLS.length} bills`]);
  return { docs: BILLS.length + 1 };
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (/seedReports\.(ts|mjs|js)$/.test(entry) && import.meta.url === pathToFileURL(entry).href) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  (async () => {
    const t = await pool.query<{ id: string }>(`select id from tenants where code = $1`, [process.argv[2] ?? 'charoen']);
    if (!t.rows[0]) throw new Error('tenant not found');
    const r = await seedReports(pool, t.rows[0].id);
    console.log(r.docs ? `[seed] reports demo: ${r.docs} documents` : '[seed] reports demo already present');
  })()
    .catch((err) => { console.error('[seed] failed:', err); process.exitCode = 1; })
    .finally(() => pool.end());
}
