/**
 * M18 "เจ้าหนี้ / จ่ายเงิน": aging KPIs (REQ-M18-04), open / all vendor bills, payment voucher for several bills or
 * part of a bill with WHT (REQ-M18-02), vendor returns against a goods receipt (REQ-M18-03), purchase discounts (BR-19).
 */
import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApAging, ApBill, ApPayment, GrDetail, GrSummary, PurchaseDiscount, VendorReturn, page } from '@erp/contracts';
import { d, sum } from '@erp/core';
import { z } from 'zod';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useMeta, useVendors } from '../../data';
import { fmt, fq, Modal, Pager, Pill, SkeletonRows, th, useCursorPager, useDebounced, useToast } from '../../ui';
import { ApDueCard } from './shared';
import { DocLink, DocLinks } from '../../doclink';

const METHOD_TH = { transfer: 'โอนเงิน', cheque: 'เช็ค', cash: 'เงินสด' } as const;
const RET_REASONS = ['สินค้าชำรุด / แตก', 'ส่งผิดรุ่น / ผิดสี', 'ส่งเกินจำนวนที่สั่ง', 'คุณภาพไม่ได้มาตรฐาน'];

export default function Ap() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const aging = useQuery({ queryKey: ['pu', 'aging'], queryFn: () => api('GET', '/api/ap/aging', { schema: ApAging }) });
  const [pay, setPay] = useState<string | null>(null);
  const [ret, setRet] = useState(false);
  const canWrite = can('fin.ap') === 1;
  const a = aging.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['pu'] });
  return (
    <>
      <div className="grid g4 pu-kpis">
        {([['current', 'ยังไม่ครบกำหนด'], ['d1_30', 'เกิน 1–30 วัน'], ['d31_60', 'เกิน 31–60 วัน'], ['over60', 'เกิน 60 วัน']] as const).map(([k, l], i) => (
          <div className="card kpi" key={k}><div className="l">เจ้าหนี้ {l}</div><div className="v" style={{ color: i && a && d(a.buckets[k]).gt(0) ? 'var(--bad)' : undefined }}>{a ? `฿${fmt(a.buckets[k])}` : '…'}</div></div>
        ))}
        <ApDueCard />
        <div className="card kpi"><div className="l">ส่วนลดรับ (ท้ายบิล) เดือนนี้</div><div className="v">{a ? `฿${fmt(a.purchaseDiscountMonth)}` : '…'}</div><div className="s">บันทึกแยก ไม่รวมในทุนสินค้า</div></div>
      </div>
      <div className="card">
        <h2>
          <span>เจ้าหนี้ค้างจ่ายตามผู้ขาย</span>
          <span className="small muted">รวม ฿{a ? fmt(a.total) : '…'}</span>
        </h2>
        <div className="tw">
          <table data-testid="ap-vendors">
            <thead><tr><th>ผู้ขาย</th><th className="n">ใบค้าง</th><th className="n">คงค้าง</th><th /></tr></thead>
            <tbody>
              {!a ? <SkeletonRows cols={4} rows={3} /> : a.vendors.map((v) => (
                <tr key={v.vendorId}>
                  <td>{v.vendorName}</td><td className="n">{v.bills}</td><td className="n"><b>{fmt(v.balance)}</b></td>
                  <td><button className="btn sm pri" disabled={!canWrite} onClick={() => setPay(v.vendorId)} data-testid={`pay-${v.vendorName}`}>จ่ายเงิน</button></td>
                </tr>
              ))}
              {a && !a.vendors.length && <tr><td colSpan={4} className="empty">ไม่มีเจ้าหนี้ค้างจ่าย</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <BillList />
      <PaymentList />
      <ReturnList canWrite={canWrite} onNew={() => setRet(true)} />
      <DiscountList />
      {pay && <PayModal vendorId={pay} onClose={() => setPay(null)} onDone={() => { setPay(null); void refresh(); }} />}
      {ret && <ReturnModal onClose={() => setRet(false)} onDone={() => { setRet(false); void refresh(); }} />}
    </>
  );
}

function BillList() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const dq = useDebounced(q.trim());
  const pager = useCursorPager(`${dq}|${status}`);
  const r = useQuery({
    queryKey: ['pu', 'bills', dq, status, pager.cursor],
    queryFn: () => api('GET', '/api/ap/bills', { query: { q: dq, status, cursor: pager.cursor }, schema: page(ApBill) }),
    placeholderData: keepPreviousData,
  });
  const loading = r.isLoading || (r.isFetching && r.isPlaceholderData);
  return (
    <div className="card">
      <h2>ใบแจ้งหนี้ผู้ขาย</h2>
      <div className="pu-filters">
        <input type="search" placeholder="ค้นหาเลขที่ ผู้ขาย ใบกำกับ หรือใบรับสินค้า" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาใบแจ้งหนี้ผู้ขาย" />
        <select value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'all')} aria-label="สถานะ"><option value="open">ค้างจ่าย (ครบกำหนดก่อน)</option><option value="all">ทั้งหมด (ล่าสุดก่อน)</option></select>
      </div>
      <div className="tw">
        <table data-testid="ap-bills">
          <thead><tr><th>เลขที่</th><th>ผู้ขาย</th><th>ใบกำกับผู้ขาย</th><th>ใบรับสินค้า</th><th>วันที่</th><th>ครบกำหนด</th><th className="n">ยอด</th><th className="n">ส่วนลดท้ายบิล</th><th className="n">จ่ายแล้ว</th><th className="n">คืนสินค้า</th><th className="n">คงค้าง</th><th>บันทึกโดย</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={12} rows={5} /> : (r.data?.items ?? []).map((b) => (
              <tr key={b.id}>
                <td className="mono"><DocLink no={b.no} type="AP" /></td><td>{b.vendorName}</td><td className="mono small">{b.vendorInvoiceNo}</td><td className="mono small">{b.grNo ? <DocLink no={b.grNo} type="GR" /> : b.source === 'opening' ? 'ยอดยกมา' : '-'}</td>
                <td>{th(b.date)}</td><td>{th(b.dueDate)}<div className="small muted">{b.termLabel}</div></td>
                <td className="n">{fmt(b.total)}</td><td className="n">{d(b.discount).gt(0) ? fmt(b.discount) : '-'}</td><td className="n">{fmt(b.paid)}</td><td className="n">{d(b.returned).gt(0) ? fmt(b.returned) : '-'}</td>
                <td className="n"><b>{fmt(b.balance)}</b> {d(b.balance).gt(0) ? (b.overdueDays > 0 ? <Pill k="bad">เกิน {b.overdueDays} วัน</Pill> : null) : <Pill k="ok">จ่ายครบ</Pill>}</td>
                <td className="small">{b.createdBy}</td>
              </tr>
            ))}
            {!loading && !r.data?.items.length && <tr><td colSpan={12} className="empty">ไม่มีใบแจ้งหนี้</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!r.data?.nextCursor} count={r.data?.items.length} loading={r.isFetching} onPrev={pager.prev} onNext={() => pager.next(r.data?.nextCursor ?? null)} />
      <p className="small muted" style={{ margin: '8px 0 0' }}>ระบบสร้างใบแจ้งหนี้ผู้ขายอัตโนมัติเมื่อยืนยันรับของ · ครบกำหนดคิดจากเงื่อนไขชำระของผู้ขาย</p>
    </div>
  );
}

function usePaged<T>(key: string, path: string, item: z.ZodType<T, z.ZodTypeDef, unknown>, q: string) {
  const pager = useCursorPager(q);
  const r = useQuery({
    queryKey: ['pu', key, q, pager.cursor],
    queryFn: () => api('GET', path, { query: { q, cursor: pager.cursor }, schema: page(item) }),
    placeholderData: keepPreviousData,
  });
  return { r, pager, loading: r.isLoading || (r.isFetching && r.isPlaceholderData) };
}

function ReturnList({ canWrite, onNew }: { canWrite: boolean; onNew: () => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const { r, pager, loading } = usePaged('returns', '/api/ap/vendor-returns', VendorReturn, dq);
  return (
    <div className="card">
      <h2><span>คืนสินค้าให้ผู้ขาย</span><button className="btn sm" disabled={!canWrite} onClick={onNew} data-testid="btn-new-return">+ ส่งคืนสินค้า</button></h2>
      <input type="search" placeholder="ค้นหาเลขที่ ผู้ขาย ใบรับ หรือใบลดหนี้" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาใบส่งคืน" style={{ width: '100%', marginBottom: 10 }} />
      <div className="tw">
        <table data-testid="ap-returns">
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>ผู้ขาย</th><th>อ้างอิง</th><th>เหตุผล</th><th className="n">ยอด</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} rows={3} /> : (r.data?.items ?? []).map((x) => (
              <tr key={x.id}>
                <td className="mono"><DocLink no={x.no} type="PR" /></td><td>{th(x.date)}</td><td>{x.vendorName}</td>
                <td className="mono small"><DocLink no={x.grNo} type="GR" />{x.vendorCnNo && <div className="muted">ใบลดหนี้ผู้ขาย {x.vendorCnNo}</div>}</td>
                <td className="small">{x.reason}<div className="muted">{x.lines.map((l) => `${l.name} × ${fq(l.qty)} ${l.unitName}`).join(', ')}</div></td>
                <td className="n">{fmt(x.total)}{d(x.unapplied).gt(0) && <div className="small muted">เครดิตคงเหลือ {fmt(x.unapplied)}</div>}</td>
              </tr>
            ))}
            {!loading && !r.data?.items.length && <tr><td colSpan={6} className="empty">ยังไม่มีการคืนสินค้า</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!r.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(r.data?.nextCursor ?? null)} />
      <p className="small muted" style={{ margin: '8px 0 0' }}>ตัดสต็อกจากล็อตของใบรับสินค้านั้นก่อน และลดยอดเจ้าหนี้ของใบเดียวกัน</p>
    </div>
  );
}

function PaymentList() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const { r, pager, loading } = usePaged('payments', '/api/ap/payments', ApPayment, dq);
  return (
    <div className="card">
      <h2>ใบสำคัญจ่าย</h2>
      <input type="search" placeholder="ค้นหาเลขที่ ผู้ขาย หรือเลขอ้างอิง" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาใบสำคัญจ่าย" style={{ width: '100%', marginBottom: 10 }} />
      <div className="tw">
        <table data-testid="ap-payments">
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>ผู้ขาย</th><th>วิธีจ่าย</th><th className="n">ยอดจ่าย</th><th className="n">หัก ณ ที่จ่าย</th><th>โดย</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={7} rows={3} /> : (r.data?.items ?? []).map((p) => (
              <tr key={p.id}>
                <td className="mono"><DocLink no={p.no} type="PV" /></td><td>{th(p.date)}</td><td>{p.vendorName}<div className="small muted"><DocLinks nos={p.bills.map((b) => b.billNo)} type="AP" /></div></td>
                <td className="small">{METHOD_TH[p.method]}{p.ref && <div className="muted">{p.ref}</div>}</td>
                <td className="n">{fmt(p.amount)}</td><td className="n">{d(p.wht).gt(0) ? fmt(p.wht) : '-'}</td><td className="small">{p.createdBy}</td>
              </tr>
            ))}
            {!loading && !r.data?.items.length && <tr><td colSpan={7} className="empty">ยังไม่มีการจ่าย</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!r.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(r.data?.nextCursor ?? null)} />
    </div>
  );
}

function DiscountList() {
  const { r, pager, loading } = usePaged('discounts', '/api/ap/purchase-discounts', PurchaseDiscount, '');
  return (
    <div className="card">
      <h2>ส่วนลดรับจากผู้ขาย (ส่วนลดท้ายบิล)</h2>
      <div className="tw">
        <table>
          <thead><tr><th>วันที่</th><th>ใบรับสินค้า</th><th>ผู้ขาย</th><th className="n">ส่วนลด (ก่อน VAT)</th><th>บันทึกโดย</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={5} rows={2} /> : (r.data?.items ?? []).map((x) => (
              <tr key={x.billNo}><td>{th(x.date)}</td><td className="mono">{x.grNo ? <DocLink no={x.grNo} type="GR" /> : <DocLink no={x.billNo} type="AP" />}</td><td>{x.vendorName}</td><td className="n">{fmt(x.amount)}</td><td className="small">{x.createdBy}</td></tr>
            ))}
            {!loading && !r.data?.items.length && <tr><td colSpan={5} className="empty">ยังไม่มี</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!r.data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(r.data?.nextCursor ?? null)} />
      <p className="small muted" style={{ margin: '8px 0 0' }}>ส่วนลดท้ายบิลที่ไม่ได้ระบุรายสินค้า ไม่นำไปลดทุนรายสินค้า แต่บันทึกเป็น "ส่วนลดรับ" แยกไว้ (BR-19) · ยอดเจ้าหนี้และภาษีซื้อคิดจากยอดหลังหักส่วนลด</p>
    </div>
  );
}

// ---------- payment voucher ----------
function PayModal({ vendorId, onClose, onDone }: { vendorId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const meta = useMeta();
  const vendors = useVendors();
  const v = vendors.data?.find((x) => x.id === vendorId);
  const bills = useQuery({
    queryKey: ['pu', 'pay-bills', vendorId],
    queryFn: async () => (await api('GET', '/api/ap/bills', { query: { vendorId, status: 'open', limit: 100 }, schema: page(ApBill) })).items,
  });
  const [amounts, setAmounts] = useState<Record<string, string> | null>(null);
  const [method, setMethod] = useState<'transfer' | 'cheque' | 'cash'>('transfer');
  const [ref, setRef] = useState('');
  const [wht, setWht] = useState<0 | 1 | 3>(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const am = amounts ?? Object.fromEntries((bills.data ?? []).map((b) => [b.id, b.balance]));
  const sel = (bills.data ?? []).filter((b) => /^\d+(\.\d+)?$/.test(am[b.id] ?? '') && d(am[b.id]!).gt(0));
  const total = sum(sel.map((b) => am[b.id]!));
  const vat = meta.data?.shop.vatRegistered ?? true;
  const whtAmt = wht ? (vat ? total.div('1.07') : total).times(wht).div(100).toDecimalPlaces(2) : d(0);
  const save = async () => {
    if (!sel.length) return setErr('เลือกใบแจ้งหนี้อย่างน้อย 1 ใบ');
    if (method === 'cheque' && !ref.trim()) return setErr('กรอกเลขที่เช็ค');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/ap/payments', { body: { vendorId, method, ref: ref.trim() || undefined, whtRate: wht, allocations: sel.map((b) => ({ billId: b.id, amount: d(am[b.id]!).toFixed(2) })) }, schema: ApPayment });
      toast(`บันทึกจ่าย ${r.no} · จ่ายจริง ฿${fmt(r.net)}`);
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="จ่ายเงินผู้ขาย">
      <h3>จ่ายเงินผู้ขาย · {v?.name ?? ''}</h3>
      <div className="tw">
        <table data-testid="pay-bills">
          <thead><tr><th /><th>เลขที่</th><th>ใบกำกับผู้ขาย</th><th>ครบกำหนด</th><th className="n">คงค้าง</th><th className="n">จ่ายครั้งนี้</th></tr></thead>
          <tbody>
            {bills.isLoading ? <SkeletonRows cols={6} rows={2} /> : (bills.data ?? []).map((b) => (
              <tr key={b.id}>
                <td><input type="checkbox" checked={sel.includes(b)} aria-label={`เลือก ${b.no}`} onChange={(e) => setAmounts({ ...am, [b.id]: e.target.checked ? b.balance : '0' })} /></td>
                <td className="mono">{b.no}</td><td className="mono small">{b.vendorInvoiceNo}</td><td>{th(b.dueDate)}{b.overdueDays > 0 && <> <Pill k="bad">เกิน {b.overdueDays} วัน</Pill></>}</td>
                <td className="n">{fmt(b.balance)}</td>
                <td className="n"><input className="pu-qty-in" type="text" inputMode="decimal" value={am[b.id] ?? ''} aria-label={`ยอดจ่าย ${b.no}`} onChange={(e) => setAmounts({ ...am, [b.id]: e.target.value })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="fgrid">
        <label className="f">วิธีจ่าย<select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} data-testid="pay-method"><option value="transfer">โอนเงิน</option><option value="cheque">เช็ค</option><option value="cash">เงินสด</option></select></label>
        <label className="f">{method === 'cheque' ? 'เลขที่เช็ค *' : 'เลขอ้างอิง (ถ้ามี)'}<input type="text" value={ref} onChange={(e) => setRef(e.target.value)} /></label>
        <label className="f">หัก ณ ที่จ่าย<select value={wht} onChange={(e) => setWht(Number(e.target.value) as 0 | 1 | 3)} data-testid="pay-wht"><option value={0}>ไม่มี (ซื้อสินค้า)</option><option value={1}>1% ค่าขนส่ง</option><option value={3}>3% ค่าบริการ</option></select></label>
      </div>
      <div className="tot">
        <span className="muted">ยอดที่ตัดเจ้าหนี้</span><span>{fmt(total)}</span>
        <span className="muted">หัก ณ ที่จ่าย{wht ? ` ${wht}%${vat ? ' (จากยอดก่อน VAT)' : ''}` : ''}</span><span>−{fmt(whtAmt)}</span>
        <span style={{ fontWeight: 600 }}>โอน / จ่ายจริง</span><span className="big">฿{fmt(total.minus(whtAmt))}</span>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy || !sel.length} onClick={() => void save()} data-testid="pay-save">บันทึกจ่ายและออกใบสำคัญจ่าย</button></div>
    </Modal>
  );
}

// ---------- vendor return ----------
function ReturnModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const meta = useMeta();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const grs = useQuery({ queryKey: ['pu', 'returnable', dq], queryFn: () => api('GET', '/api/purchasing/receipts', { query: { q: dq, returnable: 'true', limit: 20 }, schema: page(GrSummary) }) });
  const [grNo, setGrNo] = useState<string | null>(null);
  const gr = useQuery({ queryKey: ['pu', 'gr', grNo], enabled: !!grNo, queryFn: () => api('GET', `/api/purchasing/receipts/${grNo}`, { schema: GrDetail }) });
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(RET_REASONS[0]!);
  const [other, setOther] = useState('');
  const [cn, setCn] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const vat = meta.data?.shop.vatRegistered ?? true;
  const lines = gr.data?.lines ?? [];
  const base = useMemo(() => lines.reduce((a, l) => a.plus(/^\d+(\.\d+)?$/.test(qty[l.id] ?? '') && l.unitPrice ? d(qty[l.id]!).times(d(l.unitPrice)) : 0), d(0)), [lines, qty]);
  const vatAmt = vat ? base.times('0.07').toDecimalPlaces(2) : d(0);
  const why = reason === '__o' ? other.trim() : reason;
  const save = async () => {
    const ls = lines.filter((l) => /^\d+(\.\d+)?$/.test(qty[l.id] ?? '') && d(qty[l.id]!).gt(0)).map((l) => ({ grLineId: l.id, qty: qty[l.id]! }));
    if (!ls.length) return setErr('ใส่จำนวนคืนอย่างน้อย 1 รายการ');
    if (!why) return setErr('ระบุเหตุผล');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/ap/vendor-returns', { body: { grNo, lines: ls, reason: why, vendorCnNo: cn.trim() || undefined }, schema: VendorReturn });
      toast(`บันทึกส่งคืน ${r.no} · ลดเจ้าหนี้ ฿${fmt(r.apApplied)}`);
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="ส่งคืนสินค้าให้ผู้ขาย">
      <h3>ส่งคืนสินค้าให้ผู้ขาย</h3>
      {!grNo ? (
        <>
          <input type="search" placeholder="ค้นหาใบรับสินค้า: เลขที่ ผู้ขาย ใบกำกับ ใบส่งของ" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาใบรับสินค้า" autoFocus />
          <div className="tw">
            <table data-testid="ret-grs">
              <thead><tr><th>ใบรับสินค้า</th><th>วันที่</th><th>ผู้ขาย</th><th>สินค้า</th><th /></tr></thead>
              <tbody>
                {grs.isLoading ? <SkeletonRows cols={5} rows={3} /> : (grs.data?.items ?? []).map((g) => (
                  <tr key={g.id}><td className="mono">{g.no}<div className="small muted">{g.vendorInvoiceNo}</div></td><td>{th(g.date)}</td><td>{g.vendorName}</td><td className="small pu-cell-wrap">{g.itemsPreview}</td><td><button className="btn sm pri" onClick={() => setGrNo(g.no)}>เลือก</button></td></tr>
                ))}
                {!grs.isLoading && !grs.data?.items.length && <tr><td colSpan={5} className="empty">ไม่มีใบรับสินค้าที่คืนได้</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div className="row"><b className="mono">{grNo}</b><span className="muted">{gr.data?.vendorName}</span><button className="btn sm" onClick={() => { setGrNo(null); setQty({}); }}>เปลี่ยนใบรับ</button></div>
          <div className="tw">
            <table data-testid="ret-lines">
              <thead><tr><th>สินค้า</th><th className="n">รับเข้า</th><th className="n">คืนแล้ว</th><th className="n">ราคา/หน่วย</th><th className="n">คืนครั้งนี้</th></tr></thead>
              <tbody>
                {gr.isLoading ? <SkeletonRows cols={5} rows={2} /> : lines.map((l) => {
                  const left = d(l.qty).minus(d(l.returnedQty));
                  return (
                    <tr key={l.id}>
                      <td>{l.name}</td><td className="n">{fq(l.qty)} {l.unitName}</td><td className="n">{fq(l.returnedQty)}</td><td className="n">{l.unitPrice ? fmt(l.unitPrice) : '-'}</td>
                      <td className="n"><input className="pu-qty-in" type="text" inputMode="decimal" placeholder="0" value={qty[l.id] ?? ''} disabled={left.lte(0)} aria-label={`คืน ${l.name}`} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} /><div className="small muted">ได้ไม่เกิน {fq(left)}</div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="fgrid">
            <label className="f">เหตุผล<select value={reason} onChange={(e) => setReason(e.target.value)} data-testid="ret-reason">{RET_REASONS.map((x) => <option key={x}>{x}</option>)}<option value="__o">อื่น ๆ (ระบุเอง)</option></select></label>
            {reason === '__o' && <label className="f">ระบุเหตุผล *<input type="text" value={other} onChange={(e) => setOther(e.target.value)} /></label>}
            <label className="f">เลขที่ใบลดหนี้จากผู้ขาย (ถ้าได้รับแล้ว)<input type="text" value={cn} onChange={(e) => setCn(e.target.value)} data-testid="ret-cn" /></label>
          </div>
          <div className="tot">
            <span className="muted">มูลค่าคืน</span><span>{fmt(base)}</span>
            {vat && <><span className="muted">VAT</span><span>{fmt(vatAmt)}</span></>}
            <span style={{ fontWeight: 600 }}>ลดยอดเจ้าหนี้</span><span className="big">฿{fmt(base.plus(vatAmt))}</span>
          </div>
        </>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button>{grNo && <button className="btn pri" disabled={busy || base.lte(0)} onClick={() => void save()} data-testid="ret-save">บันทึกส่งคืน</button>}</div>
    </Modal>
  );
}
