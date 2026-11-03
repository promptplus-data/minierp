/**
 * Demo data for group B "purchasing" on top of seedDemo(): three confirmed goods receipts with lots, ledger rows,
 * GR lines and AP bills (one due within 7 days, one overdue and partly paid, one with a vendor return), a payment
 * voucher, a delivery-file draft older than 2 days (BR-10 banner, one unmapped line), a remembered column mapping
 * and an import batch in the history. Dates are relative to `today` so the alerts stay live in the demo.
 *
 * Idempotent: does nothing when the marker invoice (IV-DEMO-0451) already exists or the demo master data is missing.
 * Writes with explicit tenant_id, so it runs on a superuser connection or inside withTenant().
 */
import type pg from 'pg';
import { addDays, d, DEFAULT_DOC_PATTERN, docPeriodKey, dueDate, formatDocNo, money, purchaseBill, qty4, sum, type PaymentTerm } from '@erp/core';

type Q = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

const bangkokToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const bkk = (date: string, hhmm = '10:00') => `${date}T${hhmm}:00+07:00`;

async function docNo(c: Q, tenantId: string, type: string, date: string): Promise<string> {
  const period = docPeriodKey(DEFAULT_DOC_PATTERN, date);
  const r = await c.query<{ seq: number }>(
    `insert into doc_counters (tenant_id, type, period, device, seq) values ($1,$2,$3,'',1)
     on conflict (tenant_id, type, period, device) do update set seq = doc_counters.seq + 1 returning seq`, [tenantId, type, period]);
  return formatDocNo(DEFAULT_DOC_PATTERN, { type, date, seq: r.rows[0]!.seq, device: '' });
}

export async function seedPurchasing(c: Q, tenantId: string, opts: { today?: string } = {}): Promise<void> {
  const today = opts.today ?? bangkokToday();
  if ((await c.query(`select 1 from ap_bills where tenant_id = $1 and vendor_invoice_no = 'IV-DEMO-0451'`, [tenantId])).rowCount) return;
  const one = async <T extends pg.QueryResultRow>(sql: string, args: unknown[]) => (await c.query<T>(sql, args)).rows[0];
  const prod = async (sku: string) => one<{ id: string; units: { name: string; factor: string }[] }>(`select id, units from products where tenant_id = $1 and sku = $2`, [tenantId, sku]);
  const vend = async (code: string) => one<{ id: string; term: PaymentTerm }>(`select id, term from vendors where tenant_id = $1 and code = $2`, [tenantId, code]);
  const user = async (username: string) => (await one<{ id: string }>(`select id from users where tenant_id = $1 and username = $2`, [tenantId, username]))?.id
    ?? (await one<{ id: string }>(`select id from users where tenant_id = $1 and role = 'owner' limit 1`, [tenantId]))?.id;
  const [cem, aac, rb9, pvc, ridgeless] = await Promise.all([prod('SCG-CEM-T50'), prod('SCG-AAC-75'), prod('RB9-10'), prod('PVC-4-85'), prod('SCG-ROOF-LK')]);
  const [v1, v2, v3] = await Promise.all([vend('V00001'), vend('V00002'), vend('V00003')]);
  const wh = await one<{ id: string }>(`select id from warehouses where tenant_id = $1 and code = 'WH2'`, [tenantId]);
  const keeper = await user('chai');
  const acct = await user('suda');
  if (!cem || !aac || !rb9 || !pvc || !ridgeless || !v1 || !v2 || !v3 || !wh || !keeper || !acct) return;
  const vat = (await one<{ vat_registered: boolean }>(`select vat_registered from tenants where id = $1`, [tenantId]))?.vat_registered ?? true;

  interface Line { p: { id: string; units: { name: string; factor: string }[] }; unitIdx: number; qty: string; price: string }
  async function receipt(o: { date: string; vendor: { id: string; term: PaymentTerm }; inv: string; dn: string; lines: Line[]; billDiscount?: string }) {
    const no = await docNo(c, tenantId, 'GR', o.date);
    const docId = (await one<{ id: string }>(`select gen_random_uuid() id`, []))!.id;
    const amounts = o.lines.map((l) => money(d(l.qty).times(d(l.price))));
    const out: { productId: string; qty: string; unitCost: string }[] = [];
    const lots: string[] = [];
    for (const [i, l] of o.lines.entries()) {
      const unit = l.p.units[l.unitIdx]!;
      const baseQty = qty4(d(l.qty).times(d(unit.factor)));
      const unitCost = qty4(d(amounts[i]!).div(d(baseQty))); // BR-19 default: bill discount kept out of lot cost
      const lot = (await one<{ id: string }>(
        `insert into stock_lots (tenant_id, product_id, warehouse_id, received_at, qty_in, remaining, unit_cost, ref) values ($1,$2,$3,$4,$5,$5,$6,$7) returning id::text`,
        [tenantId, l.p.id, wh!.id, bkk(o.date), baseQty, unitCost, no]))!.id;
      const mv = (await one<{ id: string }>(
        `insert into stock_moves (tenant_id, at, doc_type, doc_no, doc_id, product_id, warehouse_id, qty, cost, note, user_id) values ($1,$2,'GR',$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [tenantId, bkk(o.date), no, docId, l.p.id, wh!.id, baseQty, amounts[i], `รับสินค้า · ${o.inv}`, keeper]))!.id;
      await c.query(`insert into stock_move_lots (tenant_id, move_id, lot_id, qty, unit_cost) values ($1,$2,$3,$4,$5)`, [tenantId, mv, lot, baseQty, unitCost]);
      out.push({ productId: l.p.id, qty: baseQty, unitCost });
      lots.push(lot);
    }
    const disc = o.billDiscount ?? '0';
    await c.query(
      `insert into stock_docs (id, tenant_id, no, type, date, warehouse_id, vendor_id, vendor_invoice_no, delivery_no, lines, total, created_by, created_at)
       values ($1,$2,$3,'GR',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [docId, tenantId, no, o.date, wh!.id, o.vendor.id, o.inv, o.dn, JSON.stringify(out), money(sum(amounts).minus(d(disc))), keeper, bkk(o.date)]);
    const grLines: string[] = [];
    for (const [i, l] of o.lines.entries()) {
      const unit = l.p.units[l.unitIdx]!;
      grLines.push((await one<{ id: string }>(
        `insert into gr_lines (tenant_id, gr_doc_id, gr_no, line_no, product_id, warehouse_id, unit_idx, unit_name, unit_factor, qty, base_qty, unit_price, amount, lot_unit_cost, lot_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [tenantId, docId, no, i + 1, l.p.id, wh!.id, l.unitIdx, unit.name, unit.factor, l.qty, out[i]!.qty, l.price, amounts[i], out[i]!.unitCost, lots[i]]))!.id);
    }
    const bill = purchaseBill(amounts, disc, vat);
    const apNo = await docNo(c, tenantId, 'AP', o.date);
    const billId = (await one<{ id: string }>(
      `insert into ap_bills (tenant_id, no, source, vendor_id, vendor_invoice_no, gr_doc_id, gr_no, date, due_date, base, discount, vat, total, created_by, created_at)
       values ($1,$2,'gr',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [tenantId, apNo, o.vendor.id, o.inv, docId, no, o.date, dueDate(o.date, o.vendor.term), bill.base, bill.discount, bill.vat, bill.total, keeper, bkk(o.date)]))!.id;
    return { no, docId, billId, total: bill.total, grLines, lots, out };
  }

  // 1) SCG goods from the dealer, 25 days ago, 30-day term → due in 5 days (home card), with a bill discount (BR-19)
  await receipt({
    date: addDays(today, -25), vendor: v1, inv: 'IV-DEMO-0451', dn: '8100229871',
    lines: [{ p: cem, unitIdx: 0, qty: '100', price: '118.00' }, { p: aac, unitIdx: 1, qty: '1', price: '3900.00' }], billDiscount: '200.00',
  });
  // 2) steel, 50 days ago, end-of-month term → overdue; partly paid by transfer
  const g2 = await receipt({ date: addDays(today, -50), vendor: v3, inv: 'SM-6909-118', dn: 'SM-DN-0918', lines: [{ p: rb9, unitIdx: 0, qty: '50', price: '140.00' }] });
  const pvDate = addDays(today, -20);
  const pvNo = await docNo(c, tenantId, 'PV', pvDate);
  const pv = (await one<{ id: string }>(
    `insert into ap_payments (tenant_id, no, date, vendor_id, method, ref, amount, wht_rate, wht, net, note, created_by, created_at)
     values ($1,$2,$3,$4,'transfer','KBANK 6910-2231','3000.00',0,'0.00','3000.00','จ่ายบางส่วน',$5,$6) returning id`,
    [tenantId, pvNo, pvDate, v3.id, acct, bkk(pvDate, '14:00')]))!.id;
  await c.query(`insert into ap_payment_allocs (tenant_id, payment_id, bill_id, amount) values ($1,$2,$3,'3000.00')`, [tenantId, pv, g2.billId]);
  await c.query(`update ap_bills set paid = paid + 3000 where id = $1`, [g2.billId]);
  // 3) pipes, 10 days ago; 5 cracked pipes returned to the vendor (stock out from this GR's lot, AP reduced)
  const g3 = await receipt({ date: addDays(today, -10), vendor: v2, inv: 'TT-6910-0077', dn: 'TT-DN-0077', lines: [{ p: pvc, unitIdx: 1, qty: '2', price: '1380.00' }] });
  const prDate = addDays(today, -8);
  const prNo = await docNo(c, tenantId, 'PR', prDate);
  const unitPrice = '1380.00';
  const retQty = '0.25'; // ¼ มัด = 5 เส้น
  const retBase = money(d(retQty).times(unitPrice));
  const retVat = vat ? money(d(retBase).times('0.07')) : '0.00';
  const retTotal = money(d(retBase).plus(d(retVat)));
  const cogs = money(d(5).times(d(g3.out[0]!.unitCost)));
  const prId = (await one<{ id: string }>(
    `insert into vendor_returns (tenant_id, no, date, vendor_id, gr_doc_id, gr_no, ap_bill_id, reason, vendor_cn_no, base, vat, total, ap_applied, unapplied, cogs, created_by, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,'ท่อแตกระหว่างขนส่ง','TT-CN-0012',$8,$9,$10,$10,0,$11,$12,$13) returning id`,
    [tenantId, prNo, prDate, v2.id, g3.docId, g3.no, g3.billId, retBase, retVat, retTotal, cogs, acct, bkk(prDate)]))!.id;
  await c.query(`insert into vendor_return_lines (tenant_id, return_id, gr_line_id, product_id, qty, base_qty, unit_price, amount, cogs) values ($1,$2,$3,$4,$5,5,$6,$7,$8)`,
    [tenantId, prId, g3.grLines[0], pvc.id, retQty, unitPrice, retBase, cogs]);
  await c.query(`update gr_lines set returned_base_qty = 5 where id = $1`, [g3.grLines[0]]);
  await c.query(`update ap_bills set returned = $2 where id = $1`, [g3.billId, retTotal]);
  await c.query(`update stock_lots set remaining = remaining - 5 where id = $1`, [g3.lots[0]]);
  const mv = (await one<{ id: string }>(
    `insert into stock_moves (tenant_id, at, doc_type, doc_no, doc_id, doc_line_id, product_id, warehouse_id, qty, cost, note, user_id) values ($1,$2,'PR',$3,$4,$5,$6,$7,-5,$8,$9,$10) returning id`,
    [tenantId, bkk(prDate), prNo, prId, g3.grLines[0], pvc.id, wh.id, cogs, `ส่งคืนผู้ขาย · ${g3.no}`, acct]))!.id;
  await c.query(`insert into stock_move_lots (tenant_id, move_id, lot_id, qty, unit_cost) values ($1,$2,$3,5,$4)`, [tenantId, mv, g3.lots[0], g3.out[0]!.unitCost]);

  // 4) a delivery-file import 3 days ago that nobody confirmed yet (BR-10 banner) with one unmapped SCG code
  const impDate = addDays(today, -3);
  const impNo = await docNo(c, tenantId, 'IMP', impDate);
  const batch = (await one<{ id: string }>(
    `insert into import_batches (tenant_id, no, kind, mode, source, file_name, file_sha256, rows_total, rows_created, created_by, created_at)
     values ($1,$2,'delivery','delivery','ไฟล์ทวีพัฒนา','delivery-8100230001.csv',md5('demo-delivery-8100230001') || md5('x'),2,2,$3,$4) returning id`,
    [tenantId, impNo, keeper, bkk(impDate, '09:30')]))!.id;
  const draft = (await one<{ id: string }>(
    `insert into gr_drafts (tenant_id, batch_id, dn_no, po_no, dealer_name, vendor_id, warehouse_id, delivery_date, received_on, vat_flag, created_by, created_at)
     values ($1,$2,'8100230001','PO-2610-0021','หจก. ทวีพัฒนาวัสดุ',$3,$4,$5,$5,'exc',$6,$7) returning id`,
    [tenantId, batch, v1.id, wh.id, impDate, keeper, bkk(impDate, '09:30')]))!.id;
  await c.query(
    `insert into gr_draft_lines (tenant_id, draft_id, line_no, row_no, external_code, external_name, unit_text, qty, unit_price, product_id, unit_idx, received_qty, warnings) values
       ($1,$2,1,2,'SCG-ROOF-LK','กระเบื้องหลังคาลอนคู่ 50×120 ซม. สีเทา','แผ่น',300,43.50,$3,0,300,'[]'),
       ($1,$2,2,3,'SCG-RIDGE-C','ครอบสันโค้ง ลอนคู่ สีเทา','ชิ้น',40,38.00,null,null,40,'["ยังไม่ผูกกับสินค้าของร้าน"]')`,
    [tenantId, draft, ridgeless.id]);
  await c.query(
    `insert into import_profiles (tenant_id, kind, name, header_signature, mapping, encoding, delimiter, vat_flag_default, vendor_id, created_by)
     values ($1,'delivery','ไฟล์ทวีพัฒนา',md5('demo-profile') || md5('y'),$2,'utf8',',','exc',$3,$4) on conflict do nothing`,
    [tenantId, JSON.stringify({ product_code: 0, product_name: 1, qty: 2, unit: 3, unit_price: 4, dn_no: 5, po_no: 6, delivery_date: 7, dealer_name: 8, vat_flag: 9 }), v1.id, keeper]);
  await c.query(`insert into audit_log (tenant_id, user_name, action, object, detail) values ($1,'system','seed','purchasing','demo AP / receipts / delivery draft')`, [tenantId]);
}
