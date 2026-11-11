/**
 * Detail pages of the purchasing documents so every number in a list opens somewhere:
 * goods receipt (/purchasing/gr/:no), AP bill (/ap/bill/:no), payment voucher (/ap/pv/:no), vendor return (/ap/pr/:no).
 * Each page lists the documents made from it and the one it came from (all as DocLink).
 */
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApBillDetail, ApPayment, GrDetail, VendorReturn } from '@erp/contracts';
import { d } from '@erp/core';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { EditableNote, NoteText } from '../../ui/NoteField';
import { DocLink, DocLinks } from '../../doclink';
import { useWarehouses } from '../../data';
import { ErrorBanner } from '../../errors';
import { fmt, fq, Pill, th } from '../../ui';
import { ReasonModal } from './shared';
import './purchasing.css';

const METHOD_TH = { transfer: 'โอนเงิน', cheque: 'เช็ค', cash: 'เงินสด' } as const;

function DetailShell({ back, backLabel, title, no, pill, q, children }: { back: string; backLabel: string; title: string; no: string; pill?: ReactNode; q: { isLoading: boolean; isError: boolean; error: unknown; isFetching: boolean; refetch: () => unknown; data: unknown }; children: ReactNode }) {
  if (q.isLoading) return <div className="card"><div className="sk" /><div className="sk" /><div className="sk" /></div>;
  if (q.isError || !q.data) return <div className="card"><ErrorBanner error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /><p><Link to={back}>‹ กลับไป{backLabel}</Link></p></div>;
  return (
    <>
      <div className="card">
        <h2><span className="row"><Link to={back} className="btn sm">‹ กลับ</Link> <span>{title}</span> <b className="mono" data-testid="doc-no">{no}</b> {pill}</span></h2>
        {children}
      </div>
    </>
  );
}

const Cost = ({ v }: { v: string | null | undefined }) => <>{v == null ? '-' : fmt(v)}</>;

export function GrDetailPage() {
  const { no = '' } = useParams();
  const whs = useWarehouses();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [voiding, setVoiding] = useState(false);
  const q = useQuery({ queryKey: ['pu', 'gr', no], queryFn: () => api('GET', `/api/purchasing/receipts/${encodeURIComponent(no)}`, { schema: GrDetail }) });
  const g = q.data;
  const live = g?.status !== 'void';
  return (
    <DetailShell back="/purchasing" backLabel="หน้ารับของ" title="ใบรับสินค้า" no={no} q={q} pill={g && !live ? <Pill k="bad">ยกเลิก</Pill> : undefined}>
      {g && (
        <>
          {live && can('inv.receive') === 1 && <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8 }}><button className="btn sm bad" onClick={() => setVoiding(true)} data-testid="gr-void">ยกเลิกใบรับ</button></div>}
          <div className="kv">
            {g.poNos.length > 0 && <><span>ตามใบสั่งซื้อ</span><span className="mono" data-testid="gr-po"><DocLinks nos={g.poNos} type="PO" /></span></>}
            <span>วันที่</span><span>{th(g.date)}</span>
            <span>ผู้ขาย</span><span>{g.vendorName ?? '-'}</span>
            <span>คลัง</span><span>{whs.data?.find((w) => w.id === g.warehouseId)?.name ?? '-'}</span>
            <span>ใบส่งของ (DN)</span><span className="mono">{g.deliveryNo ?? '-'}</span>
            <span>ใบกำกับผู้ขาย</span><span className="mono">{g.vendorInvoiceNo ?? '-'}</span>
            <span>บิลเจ้าหนี้</span><span className="mono"><DocLink no={g.apBillNo} type="AP" /></span>
            <span>ใบส่งคืนผู้ขาย</span><span className="mono"><DocLinks nos={g.returns.map((r) => r.no)} type="PR" /></span>
            <span>รับโดย</span><span>{g.createdBy}</span>
            <span>หมายเหตุ</span><NoteText note={g.note} dash />
            {g.total != null && <><span>ยอดรวม</span><span><b>{fmt(g.total)}</b>{g.billDiscount && d(g.billDiscount).gt(0) ? ` · ส่วนลดท้ายบิล ${fmt(g.billDiscount)}` : ''}</span></>}
          </div>
          <h3 style={{ marginTop: 14 }}>รายการ</h3>
          <div className="tw">
            <table data-testid="gr-lines">
              <thead><tr><th>สินค้า</th><th className="n">จำนวน</th><th className="n">ส่งคืนแล้ว</th>{g.lines.some((l) => l.unitPrice != null) && <><th className="n">ราคา/หน่วย</th><th className="n">จำนวนเงิน</th></>}</tr></thead>
              <tbody>
                {g.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td><td className="n">{fq(l.qty)} {l.unitName}</td><td className="n">{d(l.returnedQty).gt(0) ? fq(l.returnedQty) : '-'}</td>
                    {l.unitPrice != null && <><td className="n"><Cost v={l.unitPrice} /></td><td className="n"><Cost v={l.amount} /></td></>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {g.voided && <div className="note bad small" style={{ marginTop: 10 }} data-testid="voided">ยกเลิกโดย {g.voided.by} · เหตุผล: {g.voided.reason}</div>}
          {voiding && <ReasonModal title={`ยกเลิกใบรับสินค้า ${g.no}`} url={`/api/purchasing/receipts/${encodeURIComponent(g.no)}/void`} okLabel="ยืนยันยกเลิกใบรับ" testId="gr-void"
            effects={['ตัดสต็อกที่รับเข้าออกจากล็อตของใบนี้ (ต้องยังไม่ถูกขาย / โอน)', 'ยกเลิกบิลเจ้าหนี้ (ต้องยังไม่จ่ายเงินหรือส่งคืน)', ...(g.poNos.length ? [`คืนยอดค้างรับให้ใบสั่งซื้อ ${g.poNos.join(', ')}`] : [])]}
            onClose={() => setVoiding(false)} onDone={() => void qc.invalidateQueries({ queryKey: ['pu'] })} />}
          <p className="small muted" style={{ margin: '8px 0 0' }}>ล็อตสต็อกจากใบรับนี้ดูได้ที่ <Link to={`/stock-ledger?q=${encodeURIComponent(g.no)}`}>สมุดคุมสต็อก</Link></p>
        </>
      )}
    </DetailShell>
  );
}

export function ApBillDetailPage() {
  const { no = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pu', 'bill', no], queryFn: () => api('GET', `/api/ap/bills/${encodeURIComponent(no)}`, { schema: ApBillDetail }) });
  const b = q.data;
  return (
    <DetailShell back="/ap" backLabel="เจ้าหนี้" title="บิลเจ้าหนี้" no={no} q={q} pill={b ? (d(b.balance).gt(0) ? (b.overdueDays > 0 ? <Pill k="bad">เกิน {b.overdueDays} วัน</Pill> : <Pill k="warn">ค้างจ่าย</Pill>) : <Pill k="ok">จ่ายครบ</Pill>) : undefined}>
      {b && (
        <>
          <div className="kv">
            <span>ผู้ขาย</span><span>{b.vendorName}</span>
            <span>ใบกำกับผู้ขาย</span><span className="mono">{b.vendorInvoiceNo}</span>
            <span>ใบรับสินค้า</span><span className="mono">{b.grNo ? <DocLink no={b.grNo} type="GR" /> : b.source === 'opening' ? 'ยอดยกมา' : '-'}</span>
            <span>วันที่ / ครบกำหนด</span><span>{th(b.date)} / {th(b.dueDate)} ({b.termLabel})</span>
            <span>ใบสำคัญจ่าย</span><span className="mono"><DocLinks nos={b.payments.map((p) => p.no)} type="PV" /></span>
            <span>ใบส่งคืนผู้ขาย</span><span className="mono"><DocLinks nos={b.returns.map((r) => r.no)} type="PR" /></span>
            <span>หมายเหตุ</span>
            <EditableNote note={b.note} canEdit={can('fin.ap') === 1} testId="bill-note-edit" onSave={async (note) => {
              const out = await api('PATCH', `/api/ap/bills/${encodeURIComponent(no)}`, { body: { note }, schema: ApBillDetail });
              qc.setQueryData(['pu', 'bill', no], out);
              void qc.invalidateQueries({ queryKey: ['pu', 'bills'] });
            }} />
          </div>
          <div className="tot" style={{ maxWidth: 360, marginLeft: 'auto', marginTop: 12 }}>
            <span className="muted">มูลค่าก่อน VAT</span><span>{fmt(b.base)}</span>
            {d(b.discount).gt(0) && <><span className="muted">ส่วนลดท้ายบิล</span><span>−{fmt(b.discount)}</span></>}
            <span className="muted">VAT</span><span>{fmt(b.vat)}</span>
            <span className="muted">รวมทั้งสิ้น</span><span>{fmt(b.total)}</span>
            <span className="muted">จ่ายแล้ว</span><span>{fmt(b.paid)}</span>
            {d(b.returned).gt(0) && <><span className="muted">ส่งคืนแล้ว</span><span>{fmt(b.returned)}</span></>}
            <span style={{ fontWeight: 600 }}>คงค้าง</span><span className="big">฿{fmt(b.balance)}</span>
          </div>
          {b.payments.length > 0 && (
            <div className="tw" style={{ marginTop: 12 }}>
              <table data-testid="bill-payments">
                <thead><tr><th>ใบสำคัญจ่าย</th><th>วันที่</th><th className="n">จ่ายใบนี้</th></tr></thead>
                <tbody>{b.payments.map((p) => <tr key={p.no}><td className="mono"><DocLink no={p.no} type="PV" /></td><td>{th(p.date)}</td><td className="n">{fmt(p.amount)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </DetailShell>
  );
}

export function PvDetailPage() {
  const { no = '' } = useParams();
  const q = useQuery({ queryKey: ['pu', 'pv', no], queryFn: () => api('GET', `/api/ap/payments/${encodeURIComponent(no)}`, { schema: ApPayment }) });
  const p = q.data;
  return (
    <DetailShell back="/ap" backLabel="เจ้าหนี้" title="ใบสำคัญจ่าย" no={no} q={q}>
      {p && (
        <>
          <div className="kv">
            <span>วันที่</span><span>{th(p.date)}</span>
            <span>ผู้ขาย</span><span>{p.vendorName}</span>
            <span>จ่ายโดย</span><span>{METHOD_TH[p.method]}{p.ref ? ` · ${p.ref}` : ''}</span>
            <span>ยอดจ่าย</span><span>{fmt(p.amount)}</span>
            {d(p.wht).gt(0) && <><span>หัก ณ ที่จ่าย {fq(p.whtRate)}%</span><span>{fmt(p.wht)}</span></>}
            <span>โอนสุทธิ</span><span><b>{fmt(p.net)}</b></span>
            <span>หมายเหตุ</span><NoteText note={p.note} dash />
            <span>ทำโดย</span><span>{p.createdBy}</span>
          </div>
          <h3 style={{ marginTop: 14 }}>จ่ายบิลเจ้าหนี้</h3>
          <div className="tw">
            <table data-testid="pv-bills">
              <thead><tr><th>บิลเจ้าหนี้</th><th>ใบกำกับผู้ขาย</th><th className="n">จำนวนที่จ่าย</th></tr></thead>
              <tbody>{p.bills.map((b) => <tr key={b.billId}><td className="mono"><DocLink no={b.billNo} type="AP" /></td><td className="mono small">{b.vendorInvoiceNo}</td><td className="n">{fmt(b.amount)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </DetailShell>
  );
}

export function VendorReturnDetailPage() {
  const { no = '' } = useParams();
  const q = useQuery({ queryKey: ['pu', 'pr', no], queryFn: () => api('GET', `/api/ap/vendor-returns/${encodeURIComponent(no)}`, { schema: VendorReturn }) });
  const r = q.data;
  return (
    <DetailShell back="/ap" backLabel="เจ้าหนี้" title="ใบส่งคืนผู้ขาย" no={no} q={q}>
      {r && (
        <>
          <div className="kv">
            <span>วันที่</span><span>{th(r.date)}</span>
            <span>ผู้ขาย</span><span>{r.vendorName}</span>
            <span>ใบรับสินค้าเดิม</span><span className="mono"><DocLink no={r.grNo} type="GR" /></span>
            <span>บิลเจ้าหนี้ที่ลด</span><span className="mono"><DocLink no={r.apBillNo} type="AP" /></span>
            <span>เหตุผล</span><span>{r.reason}</span>
            {r.vendorCnNo && <><span>ใบลดหนี้ผู้ขาย</span><span className="mono">{r.vendorCnNo}</span></>}
            <span>หมายเหตุ</span><NoteText note={r.note} dash />
            <span>มูลค่าสินค้า + VAT</span><span>{fmt(r.base)} + {fmt(r.vat)} = <b>{fmt(r.total)}</b></span>
            <span>ลดเจ้าหนี้แล้ว</span><span>{fmt(r.apApplied)}{d(r.unapplied).gt(0) ? ` · ส่วนที่เกินยอดค้างของบิล ${fmt(r.unapplied)}` : ''}</span>
            <span>ทำโดย</span><span>{r.createdBy}</span>
          </div>
          <h3 style={{ marginTop: 14 }}>รายการที่ส่งคืน</h3>
          <div className="tw">
            <table>
              <thead><tr><th>สินค้า</th><th className="n">จำนวน</th><th className="n">ราคา/หน่วย</th><th className="n">จำนวนเงิน</th></tr></thead>
              <tbody>{r.lines.map((l, i) => <tr key={i}><td>{l.name}</td><td className="n">{fq(l.qty)} {l.unitName}</td><td className="n">{fmt(l.unitPrice)}</td><td className="n">{fmt(l.amount)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
    </DetailShell>
  );
}
