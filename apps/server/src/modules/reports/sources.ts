/**
 * Data sources for M11 / M12. Every report reads its data through one of these functions, so a table that
 * another module group adds later plugs in here without touching the report logic.
 *
 * Plug-in views (created by the owning module's migration, `WITH (security_invoker = true)` so RLS applies):
 * when a view exists the report uses it, otherwise the card / section says the source is not available yet.
 * Column lists: apps/server/src/modules/reports/README.md.
 */
import type { Tx } from '@erp/db';
import type { ReportSource } from '@erp/contracts';
import { addDays } from '@erp/core';
import { E } from '../../lib/errors';

export const PLUGIN_VIEWS = {
  purchaseDocs: { view: 'rpt_purchase_docs', label: 'ใบตั้งหนี้ / ใบซื้อ (M18 เจ้าหนี้)' },
  arOpen: { view: 'rpt_ar_open', label: 'ใบแจ้งหนี้ค้างชำระ (M10 ลูกหนี้)' },
  grPending: { view: 'rpt_gr_pending', label: 'ใบรับของรอยืนยัน (M05)' },
  approvals: { view: 'rpt_pending_approvals', label: 'รายการรออนุมัติของโมดูลอื่น' },
  payroll: { view: 'rpt_payroll_monthly', label: 'เงินเดือนและประกันสังคม (M17)' },
  promoLines: { view: 'rpt_promo_lines', label: 'ยอดขายตามโปรโมชั่น (M15)' },
  coupons: { view: 'rpt_coupon_redemptions', label: 'คูปอง SCG Family ที่ตัดใช้ (M13)' },
} as const;
export type PluginKey = keyof typeof PLUGIN_VIEWS;

/** Which plug-in views exist, looked up once per request. */
export class Sources {
  private cache = new Map<string, boolean>();
  constructor(private tx: Tx) {}
  async has(key: PluginKey): Promise<boolean> {
    const v = PLUGIN_VIEWS[key].view;
    if (!this.cache.has(v)) {
      const r = await this.tx.query<{ ok: boolean }>(`select to_regclass($1) is not null ok`, [`public.${v}`]);
      this.cache.set(v, r.rows[0]!.ok);
    }
    return this.cache.get(v)!;
  }
  async status(key: PluginKey, whenMissing: string): Promise<ReportSource> {
    const ok = await this.has(key);
    return { key, label: PLUGIN_VIEWS[key].label, available: ok, note: ok ? '' : whenMissing };
  }
}

// ---------- periods (business dates are Asia/Bangkok) ----------
export const monthRange = (month: string): { from: string; to: string } => {
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${month}-${String(last).padStart(2, '0')}` };
};
/** Start of the next Bangkok day after `date`, as a timestamptz literal: moves strictly before it are "as of" the date. */
export const endOfDay = (date: string): string => `${addDays(date, 1)}T00:00:00+07:00`;

export function checkRange(from: string, to: string, maxDays = 400): void {
  if (to < from) throw E.validation('to must not be before from');
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days > maxDays) throw E.validation(`A report covers at most ${maxDays} days`);
}

// ---------- offset cursor for aggregated report rows ----------
export function offsetOf(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(n) || n < 0) throw E.validation('Bad cursor');
  return n;
}
export const nextOffset = (offset: number, limit: number, total: number): string | null =>
  offset + limit < total ? Buffer.from(String(offset + limit)).toString('base64url') : null;

// ---------- sales lines (M11-01, M12) ----------
export const SALE_DOC_TYPES = ['ABB', 'INV', 'RC', 'CN'] as const;

/**
 * Live sales document lines of a period with ex-VAT value, VAT share and FIFO cost from the stock ledger.
 * Parameters: $1 from, $2 to. Columns: doc_id, no, type, date, sgn (−1 for credit notes), vat_mode, customer_id,
 * customer_name, created_by, sale_type, line_id, product_id, base_qty, ex, lvat, cogs (signed: a restocked
 * return gives negative cost).
 * - ex: inc → the document's base7 shared over 7% lines pro-rata, remainder on the last 7% line (core lineExVat);
 *   exc / none → net after bill discount. Σ ex per document = base7 + exempt.
 * - lvat: the document's VAT shared over 7% lines by ex, remainder on the last 7% line. Σ per document = vat.
 * - cogs: Σ ledger cost of the line's moves (out = +cost, in = −cost).
 * - sale_type: POS documents (with a shift; a credit note follows its source bill) are retail, others wholesale.
 *   Project sales come with M09.
 */
export const SALE_LINES_CTE = `
  sd as (
    select d.id, d.no, d.type, d.date, d.vat_mode, d.base7, d.exempt, d.vat, d.customer_id, d.customer_name, d.created_by,
           case when d.type = 'CN' then -1 else 1 end sgn,
           case when (case when d.type = 'CN' then src.shift_id else d.shift_id end) is not null then 'retail' else 'whole' end sale_type
      from docs d left join docs src on src.id = d.ref_doc_id
     where d.status = 'active' and d.type in ('ABB','INV','RC','CN') and d.date between $1::date and $2::date
  ),
  sl0 as (
    select sd.*, l.id line_id, l.product_id, l.base_qty, l.vat lv, l.line_no,
           case when sd.vat_mode = 'inc' and l.vat = 'v7'
                then coalesce(round(l.net_after_bill * sd.base7 / nullif(sum(l.net_after_bill) filter (where l.vat = 'v7') over (partition by l.doc_id), 0), 2), 0)
                else l.net_after_bill end ex0,
           row_number() over (partition by l.doc_id, l.vat order by l.line_no desc) rn
      from doc_lines l join sd on sd.id = l.doc_id
  ),
  sl1 as (
    select sl0.*,
           case when vat_mode = 'inc' and lv = 'v7' and rn = 1 then ex0 + base7 - sum(ex0) over (partition by id, lv) else ex0 end ex
      from sl0
  ),
  sl2 as (
    select sl1.*,
           case when lv = 'v7' and vat_mode <> 'none'
                then coalesce(round(ex * vat / nullif(sum(ex) over (partition by id, lv), 0), 2), 0) else 0 end v0
      from sl1
  ),
  smv as (
    select m.doc_line_id, sum(case when m.qty < 0 then m.cost else -m.cost end) cost
      from stock_moves m join sd on sd.id = m.doc_id
     where m.doc_line_id is not null
     group by m.doc_line_id
  ),
  sl as (
    select sl2.id doc_id, sl2.no, sl2.type, sl2.date, sl2.sgn, sl2.vat_mode, sl2.customer_id, sl2.customer_name, sl2.created_by, sl2.sale_type,
           sl2.line_id, sl2.product_id, sl2.base_qty, sl2.ex,
           case when lv = 'v7' and vat_mode <> 'none' and rn = 1 then v0 + vat - sum(v0) over (partition by id, lv) else v0 end lvat,
           coalesce(smv.cost, 0) cogs
      from sl2 left join smv on smv.doc_line_id = sl2.line_id
  )`;
