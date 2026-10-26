/** 80 mm slip (mockup receiptHtml) for ABB / INV / RC / CN. Wrapped in .print-area so window.print() prints only the slip. */
import { d } from '@erp/core';
import type { SalesDoc, Shift } from '@erp/contracts';
import { useMeta } from '../data';
import { fmt, fq, th, thTime } from '../ui';

export const METHOD_TH: Record<string, string> = { cash: 'เงินสด', transfer: 'โอนเงิน', promptpay: 'PromptPay QR', card: 'บัตรเครดิต/เดบิต', credit: 'ลดหนี้' };

export const DOC_TITLE: Record<SalesDoc['type'], string> = {
  ABB: 'ใบกำกับภาษีอย่างย่อ/ใบเสร็จรับเงิน', INV: 'ใบกำกับภาษี/ใบเสร็จรับเงิน', RC: 'ใบเสร็จรับเงิน', CN: 'ใบลดหนี้ / รับคืนสินค้า',
  QT: 'ใบเสนอราคา', SO: 'ใบสั่งขาย', DO: 'ใบส่งของ',
};

export function Slip({ doc }: { doc: SalesDoc }) {
  const meta = useMeta();
  const shop = meta.data?.shop;
  const nv = doc.vatMode === 'none';
  const t = doc.totals;
  const title = doc.type === 'CN' && nv ? 'ใบรับคืนสินค้า / ใบคืนเงิน' : DOC_TITLE[doc.type];
  const R = ({ l, r, b }: { l: string; r: string; b?: boolean }) => (b ? <div className="r"><b>{l}</b><b>{r}</b></div> : <div className="r"><span>{l}</span><span>{r}</span></div>);
  return (
    <div className="receipt print-area" data-testid="receipt">
      {doc.status === 'void' && <div className="c" style={{ color: 'var(--bad)', fontWeight: 700 }}>*** ยกเลิกแล้ว ***</div>}
      <div className="c">
        <b>{shop?.name}</b><br />
        {!nv && <>เลขประจำตัวผู้เสียภาษี {shop?.taxId}<br />{shop?.branch}<br /></>}
        {title}
      </div>
      <hr />
      <R l={doc.no} r={th(doc.date)} />
      {doc.type === 'INV' && <div>ลูกค้า: {doc.customer.name}</div>}
      {doc.type === 'CN' && doc.ref && <div>อ้างอิง: {doc.ref}</div>}
      <hr />
      {doc.lines.map((l) => (
        <div key={l.id}>
          <div>{l.name}</div>
          <R l={`${fq(l.qty)} ${l.unitName} × ${fmt(l.unitPrice)}`} r={fmt(d(l.qty).times(d(l.unitPrice)))} />
          {d(l.discount).gt(0) && <R l="  ส่วนลด" r={`−${fmt(l.discount)}`} />}
        </div>
      ))}
      <hr />
      <R l="รวม" r={fmt(d(t.gross).minus(d(t.lineDisc)))} />
      {d(t.billDisc).gt(0) && <R l="ส่วนลดท้ายบิล" r={`−${fmt(t.billDisc)}`} />}
      <R l="สุทธิ" r={fmt(t.total)} b />
      {!nv && (
        <>
          <R l="มูลค่าสินค้า (ก่อน VAT)" r={fmt(t.base7)} />
          {d(t.exempt).gt(0) && <R l="สินค้ายกเว้น / 0%" r={fmt(t.exempt)} />}
          <R l="VAT 7%" r={fmt(t.vat)} />
        </>
      )}
      {doc.payments.length > 0 && <hr />}
      {doc.payments.map((p, i) => <R key={i} l={METHOD_TH[p.method] ?? p.method} r={fmt(p.amount)} />)}
      <div className="c" style={{ marginTop: 6 }}>ขอบคุณที่ใช้บริการ</div>
    </div>
  );
}

/** X (live) or Z (closed) shift report, slip-shaped like the mockup shiftReport(). */
export function ShiftSlip({ shift, userName, note }: { shift: Shift; userName: string; note?: string }) {
  const final = !!shift.closedAt;
  const R = ({ l, r, b }: { l: string; r: string; b?: boolean }) => (b ? <div className="r"><b>{l}</b><b>{r}</b></div> : <div className="r"><span>{l}</span><span>{r}</span></div>);
  const sales = Object.values(shift.byMethod).reduce((a, v) => a.plus(d(v)), d(0));
  const diff = shift.diff != null ? d(shift.diff) : null;
  return (
    <div className="receipt print-area" data-testid={final ? 'z-report' : 'x-report'}>
      <div className="c"><b>{final ? 'รายงานปิดกะ (Z)' : 'รายงานระหว่างกะ (X)'}</b><br />{shift.no}</div>
      <hr />
      <R l="ผู้เปิดกะ" r={userName} />
      <R l="เปิด" r={thTime(shift.openedAt)} />
      {final ? <R l="ปิด" r={thTime(shift.closedAt!)} /> : <R l="พิมพ์เมื่อ" r={thTime(new Date().toISOString())} />}
      <R l="เครื่อง" r={shift.deviceId} />
      <hr />
      {Object.entries(shift.byMethod).map(([k, v]) => <R key={k} l={`ขาย · ${METHOD_TH[k] ?? k}`} r={fmt(v)} />)}
      <R l="คืนเงินสดลูกค้า" r={`−${fmt(shift.cashRefunds)}`} />
      <R l="นำเงินเข้าลิ้นชัก" r={fmt(shift.cashIn)} />
      <R l="นำเงินออกลิ้นชัก" r={`−${fmt(shift.cashOut)}`} />
      <hr />
      <R l="เงินทอนตั้งต้น" r={fmt(shift.float)} />
      <R l="ยอดขายรวม" r={fmt(sales)} />
      <R l="เงินสดที่ควรมี" r={fmt(shift.expected)} b />
      {final && shift.counted != null && <R l="นับได้จริง" r={fmt(shift.counted)} />}
      {final && diff && <R l="ขาด / เกิน" r={`${diff.gt(0) ? '+' : ''}${fmt(diff)}`} b />}
      {note && <div>หมายเหตุ: {note}</div>}
    </div>
  );
}
