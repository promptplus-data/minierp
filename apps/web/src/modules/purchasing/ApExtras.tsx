/** M18 additions: มัดจำซื้อ (deposits paid to vendors) and รับวางบิลซื้อ (vendor billing notes with the payment date). */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApBill, ApBillingNote, ApDeposit, page } from '@erp/contracts';
import { d, sum } from '@erp/core';
import { api, errText } from '../../api';
import { useVendors } from '../../data';
import { fmt, Modal, Pill, SkeletonRows, th, useDebounced, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { NoteField } from '../../ui/NoteField';
import { DocLink, DocLinks } from '../../doclink';

const METHOD_TH = { transfer: 'โอนเงิน', cheque: 'เช็ค', cash: 'เงินสด' } as const;
const DEP_ST = { active: ['ใช้ได้', 'ok'], refunded: ['รับคืนแล้ว', 'mut'], void: ['ยกเลิก', 'mut'] } as const;
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

export function DepositList({ canWrite, onChanged }: { canWrite: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [form, setForm] = useState(false);
  const [closing, setClosing] = useState<ApDeposit | null>(null);
  const dq = useDebounced(q.trim());
  const r = useLoadMore(['pu', 'deposits'], '/api/ap/deposits', ApDeposit, { q: dq, status }, 10);
  return (
    <div className="card">
      <h2><span>มัดจำซื้อ (จ่ายมัดจำให้ผู้ขาย)</span>{canWrite && <button className="btn sm" onClick={() => setForm(true)} data-testid="btn-ap-deposit">+ จ่ายมัดจำ</button>}</h2>
      <div className="pu-filters">
        <input type="search" placeholder="ค้นหาเลขที่ ผู้ขาย หรือใบสั่งซื้อ" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหามัดจำซื้อ" />
        <select value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'all')} aria-label="สถานะมัดจำ"><option value="open">ยังมียอดให้ใช้</option><option value="all">ทั้งหมด</option></select>
      </div>
      <div className="tw">
        <table data-testid="ap-deposits">
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>ผู้ขาย</th><th>วิธีจ่าย</th><th className="n">มัดจำ</th><th className="n">ใช้หักแล้ว</th><th className="n">คงเหลือ</th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {r.isLoading ? <SkeletonRows cols={9} rows={2} /> : r.rows.map((x) => (
              <tr key={x.id}>
                <td className="mono">{x.no}</td><td>{th(x.date)}</td>
                <td>{x.vendorName}{x.poNo && <div className="small muted">ใบสั่งซื้อ <DocLink no={x.poNo} type="PO" /></div>}{x.note && <div className="small muted">{x.note}</div>}</td>
                <td className="small">{METHOD_TH[x.method]}{x.ref && <div className="muted">{x.ref}</div>}</td>
                <td className="n">{fmt(x.amount)}</td>
                <td className="n">{d(x.used).gt(0) ? fmt(x.used) : '-'}{x.payments.length > 0 && <div className="small muted"><DocLinks nos={x.payments.map((p) => p.no)} type="PV" /></div>}</td>
                <td className="n"><b>{fmt(x.remaining)}</b></td>
                <td><Pill k={DEP_ST[x.status][1]}>{DEP_ST[x.status][0]}</Pill>{x.closedNote && <div className="small muted">{x.closedNote}</div>}</td>
                <td>{canWrite && x.status === 'active' && <button className="btn sm" onClick={() => setClosing(x)} data-testid={`apdep-close-${x.no}`}>{d(x.used).gt(0) ? 'รับคืนส่วนที่เหลือ' : 'รับคืน / ยกเลิก'}</button>}</td>
              </tr>
            ))}
            {!r.isLoading && !r.rows.length && <tr><td colSpan={9} className="empty">ไม่มีมัดจำซื้อ</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="apdep-more" />
      <p className="small muted" style={{ margin: '8px 0 0' }}>มัดจำที่จ่ายไปแล้วใช้หักตอนจ่ายเงินตามใบแจ้งหนี้ของผู้ขายรายเดียวกัน ระบบตัดเจ้าหนี้เต็มยอดและจ่ายจริงเฉพาะส่วนที่เหลือ</p>
      {form && <DepositModal onClose={() => setForm(false)} onDone={(no) => { setForm(false); toast(`บันทึกมัดจำซื้อ ${no} แล้ว`); onChanged(); }} />}
      {closing && <CloseDepositModal dep={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); onChanged(); }} />}
    </div>
  );
}

function DepositModal({ onClose, onDone }: { onClose: () => void; onDone: (no: string) => void }) {
  const vendors = useVendors();
  const [vendorId, setVendorId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'transfer' | 'cheque' | 'cash'>('transfer');
  const [ref, setRef] = useState('');
  const [poNo, setPoNo] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!vendorId) return setErr('เลือกผู้ขาย');
    if (!/^\d+(\.\d+)?$/.test(amount) || !d(amount).gt(0)) return setErr('ใส่ยอดมัดจำ');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/ap/deposits', { body: { vendorId, amount, method, ref: ref.trim() || undefined, poNo: poNo.trim() || undefined, note }, schema: ApDeposit });
      onDone(r.no);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="จ่ายมัดจำให้ผู้ขาย">
      <h3>จ่ายมัดจำให้ผู้ขาย</h3>
      <div className="fgrid">
        <label className="f">ผู้ขาย *<select value={vendorId} onChange={(e) => setVendorId(e.target.value)} data-testid="apdep-vendor"><option value="">เลือกผู้ขาย</option>{(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <label className="f">ยอดมัดจำ (บาท) *<input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="apdep-amount" /></label>
        <label className="f">วิธีจ่าย<select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}><option value="transfer">โอนเงิน</option><option value="cheque">เช็ค</option><option value="cash">เงินสด</option></select></label>
        <label className="f">{method === 'cheque' ? 'เลขที่เช็ค *' : 'เลขอ้างอิง (ถ้ามี)'}<input type="text" value={ref} onChange={(e) => setRef(e.target.value)} /></label>
        <label className="f">ใบสั่งซื้อ (ถ้ามี)<input type="text" value={poNo} onChange={(e) => setPoNo(e.target.value)} placeholder="เช่น PO2611-0003" data-testid="apdep-po" /></label>
        <NoteField value={note} onChange={setNote} testId="apdep-note" placeholder="เช่น มัดจำ 30% ก่อนผลิต" />
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy} onClick={() => void save()} data-testid="apdep-save">บันทึกจ่ายมัดจำ</button></div>
    </Modal>
  );
}

function CloseDepositModal({ dep, onClose, onDone }: { dep: ApDeposit; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const unused = !d(dep.used).gt(0);
  const [action, setAction] = useState<'refund' | 'void'>('refund');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    if (!reason.trim()) return setErr('ระบุเหตุผล');
    try {
      await api('POST', `/api/ap/deposits/${dep.no}/close`, { body: { action, reason }, schema: ApDeposit });
      toast(action === 'void' ? `ยกเลิก ${dep.no} แล้ว` : `บันทึกรับคืนมัดจำ ฿${fmt(dep.remaining)} แล้ว`);
      onDone();
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <Modal onClose={onClose} label="ปิดมัดจำซื้อ">
      <h3>{dep.no} · {dep.vendorName}</h3>
      <p className="small">คงเหลือ ฿{fmt(dep.remaining)} จาก ฿{fmt(dep.amount)}</p>
      <label className="row"><input type="radio" checked={action === 'refund'} onChange={() => setAction('refund')} /> ผู้ขายคืนเงินส่วนที่เหลือ ฿{fmt(dep.remaining)}</label>
      {unused && <label className="row"><input type="radio" checked={action === 'void'} onChange={() => setAction('void')} data-testid="apdep-void" /> ยกเลิก (บันทึกผิด)</label>}
      <label className="f">เหตุผล *<input type="text" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="apdep-reason" /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void go()} data-testid="apdep-close-save">บันทึก</button></div>
    </Modal>
  );
}

// ---------- รับวางบิล ----------
export function BillingNoteList({ canWrite, onPay, onChanged }: { canWrite: boolean; onPay: (n: ApBillingNote) => void; onChanged: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [form, setForm] = useState(false);
  const dq = useDebounced(q.trim());
  const r = useLoadMore(['pu', 'vb'], '/api/ap/billing-notes', ApBillingNote, { q: dq, status }, 10);
  const voidIt = async (n: ApBillingNote) => {
    const reason = window.prompt(`เหตุผลที่ยกเลิก ${n.no}`);
    if (!reason?.trim()) return;
    try {
      await api('POST', `/api/ap/billing-notes/${n.no}/void`, { body: { reason }, schema: ApBillingNote });
      toast(`ยกเลิก ${n.no} แล้ว`);
      onChanged();
    } catch (e) {
      toast(errText(e));
    }
  };
  return (
    <div className="card">
      <h2><span>รับวางบิลซื้อ</span>{canWrite && <button className="btn sm" onClick={() => setForm(true)} data-testid="btn-ap-vb">+ รับวางบิล</button>}</h2>
      <div className="pu-filters">
        <input type="search" placeholder="ค้นหาเลขที่ ผู้ขาย หรือเลขใบวางบิลผู้ขาย" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาใบรับวางบิล" />
        <select value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'all')} aria-label="สถานะใบรับวางบิล"><option value="open">รอจ่าย</option><option value="all">ทั้งหมด</option></select>
      </div>
      <div className="tw">
        <table data-testid="ap-vb">
          <thead><tr><th>เลขที่</th><th>รับวางบิล</th><th>ผู้ขาย</th><th>ใบแจ้งหนี้</th><th>นัดจ่าย</th><th className="n">ยอดวางบิล</th><th className="n">คงค้าง</th><th /></tr></thead>
          <tbody>
            {r.isLoading ? <SkeletonRows cols={8} rows={2} /> : r.rows.map((n) => (
              <tr key={n.id}>
                <td className="mono">{n.no}{n.vendorDocNo && <div className="small muted">ผู้ขาย {n.vendorDocNo}</div>}</td><td>{th(n.date)}</td><td>{n.vendorName}{n.note && <div className="small muted">{n.note}</div>}</td>
                <td className="small"><DocLinks nos={n.bills.map((b) => b.billNo)} type="AP" /></td>
                <td>{th(n.dueDate)} {n.status === 'void' ? <Pill k="mut">ยกเลิก</Pill> : n.paid ? <Pill k="ok">จ่ายครบ</Pill> : n.overdueDays > 0 ? <Pill k="bad">เลยนัด {n.overdueDays} วัน</Pill> : null}</td>
                <td className="n">{fmt(n.total)}</td><td className="n"><b>{fmt(n.balance)}</b></td>
                <td>
                  {canWrite && n.status === 'active' && !n.paid && (
                    <span className="row" style={{ flexWrap: 'nowrap' }}>
                      <button className="btn sm pri" onClick={() => onPay(n)} data-testid={`vb-pay-${n.no}`}>จ่ายตามใบวางบิล</button>
                      {!n.payments.length && <button className="btn sm" onClick={() => void voidIt(n)}>ยกเลิก</button>}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!r.isLoading && !r.rows.length && <tr><td colSpan={8} className="empty">ไม่มีใบรับวางบิล</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="vb-more" />
      <p className="small muted" style={{ margin: '8px 0 0' }}>รวมใบแจ้งหนี้ที่ผู้ขายมาวางบิลพร้อมวันนัดจ่าย ใบแจ้งหนี้หนึ่งใบอยู่ได้ในใบรับวางบิลเดียว</p>
      {form && <BillingNoteModal onClose={() => setForm(false)} onDone={(no) => { setForm(false); toast(`บันทึกรับวางบิล ${no} แล้ว`); onChanged(); }} />}
    </div>
  );
}

function BillingNoteModal({ onClose, onDone }: { onClose: () => void; onDone: (no: string) => void }) {
  const vendors = useVendors();
  const [vendorId, setVendorId] = useState('');
  const bills = useQuery({
    queryKey: ['pu', 'vb-bills', vendorId], enabled: !!vendorId,
    queryFn: async () => (await api('GET', '/api/ap/bills', { query: { vendorId, status: 'open', limit: 100 }, schema: page(ApBill) })).items,
  });
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [docNo, setDocNo] = useState('');
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = (bills.data ?? []).filter((b) => pick.has(b.id));
  const total = sum(chosen.map((b) => b.balance));
  const save = async () => {
    if (!chosen.length) return setErr('เลือกใบแจ้งหนี้อย่างน้อย 1 ใบ');
    if (!due) return setErr('ใส่วันนัดจ่าย');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/ap/billing-notes', { body: { vendorId, billIds: chosen.map((b) => b.id), vendorDocNo: docNo, dueDate: due, note }, schema: ApBillingNote });
      onDone(r.no);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="รับวางบิลซื้อ">
      <h3>รับวางบิลซื้อ</h3>
      <div className="fgrid">
        <label className="f">ผู้ขาย *<select value={vendorId} onChange={(e) => { setVendorId(e.target.value); setPick(new Set()); }} data-testid="vb-vendor"><option value="">เลือกผู้ขาย</option>{(vendors.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <label className="f">เลขที่ใบวางบิลของผู้ขาย<input type="text" value={docNo} onChange={(e) => setDocNo(e.target.value)} data-testid="vb-docno" /></label>
        <label className="f">วันนัดจ่าย *<input type="date" min={today()} value={due} onChange={(e) => setDue(e.target.value)} data-testid="vb-due" /></label>
        <NoteField value={note} onChange={setNote} testId="vb-note" placeholder="เช่น ผู้ขายมารับเช็ควันศุกร์" />
      </div>
      {vendorId && (
        <div className="tw">
          <table data-testid="vb-bills">
            <thead><tr><th /><th>เลขที่</th><th>ใบกำกับผู้ขาย</th><th>ครบกำหนด</th><th className="n">คงค้าง</th></tr></thead>
            <tbody>
              {bills.isLoading ? <SkeletonRows cols={5} rows={2} /> : (bills.data ?? []).map((b) => (
                <tr key={b.id}>
                  <td><input type="checkbox" checked={pick.has(b.id)} aria-label={`เลือก ${b.no}`} data-testid={`vb-pick-${b.vendorInvoiceNo}`}
                    onChange={(e) => { const s = new Set(pick); if (e.target.checked) s.add(b.id); else s.delete(b.id); setPick(s); }} /></td>
                  <td className="mono">{b.no}</td><td className="mono small">{b.vendorInvoiceNo}</td><td>{th(b.dueDate)}</td><td className="n">{fmt(b.balance)}</td>
                </tr>
              ))}
              {!bills.isLoading && !bills.data?.length && <tr><td colSpan={5} className="empty">ผู้ขายรายนี้ไม่มีใบแจ้งหนี้ค้างจ่าย</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <div className="tot"><span style={{ fontWeight: 600 }}>ยอดวางบิล</span><span className="big">฿{fmt(total)}</span></div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy || !chosen.length} onClick={() => void save()} data-testid="vb-save">บันทึกรับวางบิล</button></div>
    </Modal>
  );
}

/** Open purchase deposits of a vendor, for the payment voucher. */
export function useOpenDeposits(vendorId: string) {
  return useQuery({
    queryKey: ['pu', 'pay-deposits', vendorId],
    queryFn: async () => (await api('GET', '/api/ap/deposits', { query: { vendorId, status: 'open', limit: 50 }, schema: page(ApDeposit) })).items,
  });
}
