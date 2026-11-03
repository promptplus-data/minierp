/**
 * REQ-M11-03: monthly output / input VAT reports in the Revenue Department layout.
 * SQL aggregates (ABB per day per POS device); core.buildVatReport applies the row rules (voids at 0, credit
 * notes negative, per-document VAT).
 */
import type { Tx } from '@erp/db';
import type { ReportSource, ReportVat, ReportVatQuery } from '@erp/contracts';
import { buildVatReport, d, money, purchaseVat, thaiDateBE, type AbbDayIn, type VatDocIn } from '@erp/core';
import { Sources, monthRange, nextOffset, offsetOf } from './sources';

export interface PurchaseDocRow {
  source: 'stock_docs' | 'plugin'; id: string; date: string; no: string; vendorInvoiceNo: string; vendorCode: string; vendorName: string; taxId: string | null; branch: string | null;
  base7: string; exempt: string; vat: string; total: string; status: 'active' | 'void'; discount: string;
}

/**
 * Purchase documents of a period. With the M18 plug-in view (AP bills) present it is the only source; otherwise
 * manual goods receipts (GR, amounts ex VAT) with 7% input VAT per document when the vendor has a tax ID.
 */
export async function purchaseDocs(tx: Tx, src: Sources, from: string, to: string): Promise<PurchaseDocRow[]> {
  if (await src.has('purchaseDocs')) {
    const r = await tx.query<PurchaseDocRow>(
      `select 'plugin' source, id::text, date::text, no, coalesce(vendor_invoice_no, no) "vendorInvoiceNo", vendor_code "vendorCode", vendor_name "vendorName",
              tax_id "taxId", branch, base7::text, exempt::text, vat::text, total::text, status, coalesce(discount, 0)::text discount
         from rpt_purchase_docs where tenant_id = erp_current_tenant() and date between $1::date and $2::date order by date, no`,
      [from, to],
    );
    return r.rows;
  }
  const r = await tx.query<{ id: string; date: string; no: string; inv: string | null; code: string; name: string; tax_id: string | null; branch: string | null; total: string | null }>(
    `select s.id, s.date::text, s.no, s.vendor_invoice_no inv, v.code, v.name, v.tax_id, v.branch, s.total::text
       from stock_docs s join vendors v on v.id = s.vendor_id
      where s.type = 'GR' and s.date between $1::date and $2::date order by s.date, s.no`,
    [from, to],
  );
  return r.rows.map((x) => {
    const base = x.total ?? '0';
    const vat = purchaseVat(base, !!x.tax_id);
    return {
      source: 'stock_docs', id: x.id, date: x.date, no: x.no, vendorInvoiceNo: x.inv ?? x.no, vendorCode: x.code, vendorName: x.name, taxId: x.tax_id, branch: x.branch,
      base7: x.tax_id ? base : '0', exempt: x.tax_id ? '0' : base, vat, total: money(d(base).plus(d(vat))), status: 'active', discount: '0',
    };
  });
}

export async function vatReport(tx: Tx, q: ReportVatQuery, all = false): Promise<ReportVat> {
  const { from, to } = monthRange(q.month);
  const src = new Sources(tx);
  const shop = (await tx.query<{ name: string; tax_id: string; branch: string }>(`select name, tax_id, branch from tenants`)).rows[0]!;
  let items: (VatDocIn | AbbDayIn)[];
  let sources: ReportSource[];
  if (q.kind === 'sales') {
    const abb = await tx.query<{ date: string; device: string; first_no: string; last_no: string; n: number; voids: string[]; base7: string; exempt: string; vat: string }>(
      `select d.date::text date, coalesce(nullif(d.device_id, ''), '-') device, min(d.no) first_no, max(d.no) last_no, count(*)::int n,
              coalesce(array_agg(d.no order by d.no) filter (where d.status = 'void'), '{}') voids,
              coalesce(sum(d.base7) filter (where d.status = 'active'), 0)::text base7,
              coalesce(sum(d.exempt) filter (where d.status = 'active'), 0)::text exempt,
              coalesce(sum(d.vat) filter (where d.status = 'active'), 0)::text vat
         from docs d where d.type = 'ABB' and d.vat_mode <> 'none' and d.date between $1::date and $2::date
        group by 1, 2`,
      [from, to],
    );
    const docs = await tx.query<{ date: string; no: string; type: string; status: 'active' | 'void'; name: string; tax_id: string | null; branch: string | null; base7: string; exempt: string; vat: string; ref_no: string | null; void_reason: string | null }>(
      `select d.date::text date, d.no, d.type, d.status, coalesce(c.name, d.customer_name) name, c.tax_id, c.branch,
              d.base7::text, d.exempt::text, d.vat::text, d.ref_no, d.void_reason
         from docs d left join customers c on c.id = d.customer_id
        where d.type in ('INV','CN') and d.vat_mode <> 'none' and d.date between $1::date and $2::date`,
      [from, to],
    );
    items = [
      ...abb.rows.map((x): AbbDayIn => ({ kind: 'abb', date: x.date, device: x.device, firstNo: x.first_no, lastNo: x.last_no, count: x.n, voidNos: x.voids, base7: x.base7, exempt: x.exempt, vat: x.vat })),
      ...docs.rows.map((x): VatDocIn => ({ kind: 'doc', date: x.date, no: x.no, type: x.type, status: x.status, name: x.name, taxId: x.tax_id, branch: x.branch, base7: x.base7, exempt: x.exempt, vat: x.vat, refNo: x.ref_no, voidReason: x.void_reason })),
    ];
    sources = [{ key: 'docs', label: 'ใบกำกับภาษี / ใบกำกับอย่างย่อ / ใบลดหนี้', available: true, note: '' }];
  } else {
    const rows = await purchaseDocs(tx, src, from, to);
    items = rows.map((x): VatDocIn => ({
      kind: 'doc', date: x.date, no: x.vendorInvoiceNo, type: 'GR', status: x.status, name: x.vendorName, taxId: x.taxId, branch: x.branch,
      base7: x.base7, exempt: x.exempt, vat: x.vat, voidReason: null,
    }));
    sources = [await src.status('purchaseDocs', 'ยังไม่มีโมดูลเจ้าหนี้: ใช้ใบรับสินค้าที่บันทึกเอง (ราคาทุนไม่รวม VAT) คิดภาษีซื้อ 7% ต่อใบเมื่อผู้ขายมีเลขผู้เสียภาษี')];
  }
  const rep = buildVatReport(items);
  const offset = all ? 0 : offsetOf(q.cursor);
  return {
    month: q.month, kind: q.kind, shop: { name: shop.name, taxId: shop.tax_id, branch: shop.branch },
    rows: all ? rep.rows : rep.rows.slice(offset, offset + q.limit),
    nextCursor: all ? null : nextOffset(offset, q.limit, rep.rows.length),
    totals: rep.totals, sources,
  };
}

const TH_MONTH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
export const thMonth = (month: string) => `${TH_MONTH[Number(month.slice(5, 7)) - 1]} ${Number(month.slice(0, 4)) + 543}`;

export function vatSheet(r: ReportVat): (string | number)[][] {
  const sales = r.kind === 'sales';
  return [
    [sales ? 'รายงานภาษีขาย' : 'รายงานภาษีซื้อ'],
    [`เดือนภาษี ${thMonth(r.month)}`],
    [`ชื่อผู้ประกอบการ ${r.shop.name}`, '', '', '', `เลขประจำตัวผู้เสียภาษีอากร ${r.shop.taxId}`],
    [`ชื่อสถานประกอบการ ${r.shop.name}`, '', '', '', r.shop.branch || 'สำนักงานใหญ่'],
    ['ลำดับที่', 'วัน เดือน ปี', 'เลขที่ใบกำกับภาษี', sales ? 'ชื่อผู้ซื้อสินค้า/ผู้รับบริการ' : 'ชื่อผู้ขายสินค้า/ผู้ให้บริการ', 'เลขประจำตัวผู้เสียภาษีอากร', 'สถานประกอบการ',
      'มูลค่าสินค้าหรือบริการ', 'ยกเว้น / อัตราศูนย์', 'จำนวนเงินภาษีมูลค่าเพิ่ม', 'รวม', 'หมายเหตุ'],
    ...r.rows.map((x) => [x.seq, thaiDateBE(x.date), x.no, x.name, x.taxId, x.branch, x.base7, x.exempt, x.vat, x.total, x.note]),
    ['', '', '', 'รวม', '', '', r.totals.base7, r.totals.exempt, r.totals.vat, r.totals.total, `${r.totals.docs} ฉบับ · ยกเลิก ${r.totals.voided}`],
  ];
}
