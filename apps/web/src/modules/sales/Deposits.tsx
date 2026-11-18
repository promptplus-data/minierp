/**
 * รับเงินมัดจำ / รับเงินล่วงหน้า from any customer (projects keep their own deposits), returning what is left
 * (คืนเงินล่วงหน้า = credit note on the advance tax invoice), and the picker that uses deposits on a new invoice.
 */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CustomerDeposit, page } from '@erp/contracts';
import { d } from '@erp/core';
import { ApiFail, api, errText } from '../../api';
import { useAuth } from '../../auth';
import { ApprovalModal, fmt, Modal, Pill, SkeletonRows, th, useToast, type ApprovalInput } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { NoteField } from '../../ui/NoteField';
import { CustomerSelect } from './pickers';
import { METHOD_TH, Paper, PrintModal, useSalesInvalidate, VoidDocModal } from './shared';
import { DocLink } from '../../doclink';

export const DEP_TYPE_TH = { guarantee: 'เงินมัดจำ', advance: 'เงินรับล่วงหน้า' } as const;
const ST: Record<CustomerDeposit['status'], [string, 'ok' | 'mut' | 'warn']> = { active: ['ใช้ได้', 'ok'], refunded: ['คืนแล้ว', 'mut'], forfeited: ['ริบแล้ว', 'warn'], void: ['ยกเลิก', 'mut'] };

export function DepositsTab({ q }: { q: string }) {
  const { can } = useAuth();
  const [status, setStatus] = useState<'open' | 'all'>('all');
  const r = useLoadMore(['ar', 'deposits', status], '/api/sales/deposits', CustomerDeposit, { q, status }, 20);
  const [m, setM] = useState<null | { act: 'refund' | 'void' | 'print'; dep: CustomerDeposit }>(null);
  const invalidate = useSalesInvalidate();
  const canDoc = can('sales.doc') === 1 || can('fin.ar') === 1;
  return (
    <>
      <div className="steps" style={{ marginBottom: 8 }}>
        {([['all', 'ทั้งหมด'], ['open', 'ยังมียอดให้ใช้']] as const).map(([k, l]) => <span key={k} role="button" tabIndex={0} className={status === k ? 'on' : ''} onClick={() => setStatus(k)} onKeyDown={(e) => { if (e.key === 'Enter') setStatus(k); }}>{l}</span>)}
      </div>
      <div className="tw">
        <table data-testid="deposit-table">
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>ประเภท</th><th className="n">รับมา</th><th className="n">ใช้แล้ว</th><th className="n">คงเหลือ</th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {r.isLoading ? <SkeletonRows cols={9} rows={4} /> : r.rows.map((x) => (
              <tr key={x.id} data-testid={`dep-row-${x.no}`}>
                <td className="mono">{x.no}{x.invoiceNo && <div className="small"><DocLink no={x.invoiceNo} type="INV" /></div>}</td><td>{th(x.date)}</td>
                <td>{x.customer.name}{x.soNo && <div className="small muted">ใบสั่งขาย <DocLink no={x.soNo} type="SO" /></div>}{x.project && <div className="small muted">โครงการ <Link to={`/projects/${x.project.id}`}>{x.project.name}</Link></div>}</td>
                <td>{DEP_TYPE_TH[x.type]}<div className="small muted">{x.type === 'advance' ? 'ออกใบกำกับแล้ว' : 'ยังไม่เกิด VAT'}</div></td>
                <td className="n">{fmt(x.amount)}<div className="small muted">{METHOD_TH[x.method] ?? x.method}</div></td>
                <td className="n">{d(x.applied).gt(0) ? fmt(x.applied) : '-'}{x.applications.map((a) => <div key={a.invoiceNo} className="small"><DocLink no={a.invoiceNo} type="INV" /></div>)}</td>
                <td className="n"><b>{fmt(x.remaining)}</b></td>
                <td><Pill k={ST[x.status][1]}>{ST[x.status][0]}</Pill>{x.refund && <div className="small muted">คืน {fmt(x.refund.amount)} · {METHOD_TH[x.refund.method] ?? x.refund.method}</div>}{x.refundCnNo && <div className="small"><DocLink no={x.refundCnNo} /></div>}</td>
                <td>
                  <span className="row" style={{ flexWrap: 'nowrap' }}>
                    {x.type === 'guarantee' && <button className="btn sm" onClick={() => setM({ act: 'print', dep: x })} data-testid={`dep-print-${x.no}`}>พิมพ์</button>}
                    {!x.project && x.status === 'active' && canDoc && d(x.remaining).gt(0) && <button className="btn sm" onClick={() => setM({ act: 'refund', dep: x })} data-testid={`dep-refund-${x.no}`}>คืนเงิน</button>}
                    {!x.project && x.status === 'active' && canDoc && !d(x.applied).gt(0) && <button className="btn sm bad" onClick={() => setM({ act: 'void', dep: x })}>ยกเลิก</button>}
                  </span>
                </td>
              </tr>
            ))}
            {!r.isLoading && !r.rows.length && <tr><td colSpan={9} className="empty">ยังไม่มีการรับมัดจำหรือเงินล่วงหน้า</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="dep-more" />
      <p className="small muted" style={{ margin: '8px 0 0' }}>เงินมัดจำยังไม่เกิด VAT ใช้ชำระบางส่วนตอนออกใบกำกับ · เงินรับล่วงหน้าออกใบกำกับภาษีทันที ตอนขายจริงหักออกจากใบกำกับพร้อม VAT · คืนเงินล่วงหน้าออกใบลดหนี้อ้างอิงใบกำกับเดิม</p>
      {m?.act === 'refund' && <RefundModal dep={m.dep} onClose={() => setM(null)} />}
      {m?.act === 'void' && <VoidDocModal what={m.dep.no} url={`/api/sales/deposits/${encodeURIComponent(m.dep.no)}/void`} total={m.dep.amount} onClose={() => setM(null)} onDone={() => void invalidate()}
        effects={m.dep.type === 'advance' ? [`ยกเลิกใบกำกับ ${m.dep.invoiceNo ?? ''} ที่ออกตอนรับเงินด้วย`] : []} />}
      {m?.act === 'print' && <PrintModal title={m.dep.no} onClose={() => setM(null)}><Paper {...guaranteePaper(m.dep)} /></PrintModal>}
    </>
  );
}

function guaranteePaper(x: CustomerDeposit) {
  return {
    title: 'ใบรับเงินมัดจำ', no: x.no, date: x.date, voided: x.status === 'void',
    party: { label: 'ได้รับเงินจาก', name: x.customer.name },
    refs: [...(x.soNo ? [['ใบสั่งขาย', x.soNo]] : []), ['รับโดย', METHOD_TH[x.method] ?? x.method]] as [string, ReactNode][],
    cols: 'amt' as const, rows: [{ name: `เงินมัดจำค่าสินค้า${x.soNo ? ` ตามใบสั่งขาย ${x.soNo}` : ''}`, amt: x.amount }],
    totals: [['รวม', fmt(x.amount), true]] as [string, string, boolean?][], baht: x.amount,
    note: [x.note, 'เงินมัดจำยังไม่ถือเป็นรายได้ จึงไม่มีภาษีมูลค่าเพิ่ม · หักเป็นค่าสินค้าเมื่อออกใบกำกับภาษี'].filter(Boolean).join(' · '), sign: ['ผู้รับเงิน', 'ผู้จ่ายเงิน'],
  };
}

export function ReceiveDepositModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [customerId, setCustomerId] = useState('');
  const [type, setType] = useState<'guarantee' | 'advance'>('guarantee');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'transfer' | 'promptpay' | 'card'>('transfer');
  const [soNo, setSoNo] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!customerId) return setErr('เลือกลูกค้า');
    if (!/^\d+(\.\d+)?$/.test(amount) || !d(amount).gt(0)) return setErr('ใส่ยอดเงิน');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/sales/deposits', { body: { customerId, type, amount, method, soNo: soNo.trim() || undefined, note }, schema: CustomerDeposit });
      await invalidate();
      toast(r.invoiceNo ? `รับเงินล่วงหน้า ${r.no} · ออกใบกำกับ ${r.invoiceNo}` : `รับเงินมัดจำ ${r.no} แล้ว`);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="รับมัดจำ / เงินล่วงหน้า">
      <h3>รับเงินมัดจำ / รับเงินล่วงหน้า</h3>
      <div className="f" role="group">ลูกค้า<CustomerSelect value={customerId} onChange={setCustomerId} noCash testId="dep-customer" requireTaxId={type === 'advance'} /></div>
      <div className="row" style={{ gap: 16, margin: '8px 0' }} role="radiogroup" aria-label="ประเภท">
        <label className="row"><input type="radio" checked={type === 'guarantee'} onChange={() => setType('guarantee')} data-testid="dep-type-guarantee" /> รับเงินมัดจำ (ยังไม่เกิด VAT)</label>
        <label className="row"><input type="radio" checked={type === 'advance'} onChange={() => setType('advance')} data-testid="dep-type-advance" /> รับเงินล่วงหน้า (ออกใบกำกับภาษีทันที)</label>
      </div>
      <div className="fgrid">
        <label className="f">ยอดเงิน (บาท) *<input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="dep-amount" /></label>
        <label className="f">รับชำระโดย<select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>{(['transfer', 'cash', 'promptpay', 'card'] as const).map((k) => <option key={k} value={k}>{METHOD_TH[k]}</option>)}</select></label>
        <label className="f">ใบสั่งขาย (ถ้ามี)<input type="text" value={soNo} onChange={(e) => setSoNo(e.target.value)} placeholder="เช่น SO2611-0004" data-testid="dep-so" /></label>
        <NoteField value={note} onChange={setNote} testId="dep-note" placeholder="เช่น มัดจำสั่งกระเบื้องสีพิเศษ" />
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy} onClick={() => void go()} data-testid="dep-save">บันทึกรับเงิน</button></div>
    </Modal>
  );
}

function RefundModal({ dep, onClose }: { dep: CustomerDeposit; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [method, setMethod] = useState<'transfer' | 'cash'>('transfer');
  const [reason, setReason] = useState('');
  const [apv, setApv] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (a?: ApprovalInput): Promise<string | null> => {
    try {
      const r = await api('POST', `/api/sales/deposits/${encodeURIComponent(dep.no)}/refund`, { body: { approval: a, reason, method }, schema: CustomerDeposit });
      await invalidate();
      toast(r.refundCnNo ? `คืนเงินล่วงหน้า ${dep.no} · ออกใบลดหนี้ ${r.refundCnNo}` : `คืนเงินมัดจำ ${dep.no} แล้ว`);
      onClose();
      return null;
    } catch (e) {
      if (e instanceof ApiFail && e.detail('approvalError')) return e.message;
      if (e instanceof ApiFail && e.detail('need') === 'approval') { setApv(true); return null; }
      const t = errText(e);
      setErr(t);
      return t;
    }
  };
  if (apv) return <ApprovalModal onClose={() => setApv(false)} onSubmit={submit} label={<p style={{ margin: 0 }}>"คืน{DEP_TYPE_TH[dep.type]} {dep.no} ฿{fmt(dep.remaining)}"</p>} />;
  return (
    <Modal onClose={onClose} label="คืนเงิน">
      <h3>คืน{DEP_TYPE_TH[dep.type]} {dep.no}</h3>
      <p className="small muted" style={{ margin: 0 }}>คืนยอดที่ยังไม่ได้ใช้ ฿{fmt(dep.remaining)} ให้ {dep.customer.name}{dep.type === 'advance' ? ` · ระบบออกใบลดหนี้อ้างอิงใบกำกับ ${dep.invoiceNo}` : ''}{can('sales.return') === 'apv' ? ' · ต้องให้ผู้จัดการอนุมัติ' : ''}</p>
      <label className="f">จ่ายคืนโดย<select value={method} onChange={(e) => setMethod(e.target.value as 'transfer' | 'cash')} data-testid="dep-refund-method"><option value="transfer">โอนเงิน</option><option value="cash">เงินสด</option></select></label>
      <label className="f">เหตุผล *<input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เช่น ลูกค้ายกเลิกคำสั่งซื้อ" data-testid="dep-refund-reason" /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={!reason.trim()} onClick={() => (can('sales.return') === 'apv' ? setApv(true) : void submit())} data-testid="dep-refund-ok">{can('sales.return') === 'apv' ? 'ขออนุมัติ' : 'บันทึกคืนเงิน'}</button>
      </div>
    </Modal>
  );
}

/** Open deposits of a customer to take off a new invoice (one kind per invoice). */
/** total null: the invoice total is not known yet (made from delivery orders): no cap, no amount-due line. */
export function DepositPicker({ customerId, total, value, onChange }: { customerId: string; total: string | null; value: { no: string; amount: string }[]; onChange: (v: { no: string; amount: string }[]) => void }) {
  const deps = useQuery({
    queryKey: ['ar', 'deposits', 'open', customerId], enabled: !!customerId,
    queryFn: async () => (await api('GET', '/api/sales/deposits', { query: { customerId, status: 'open', limit: 50 }, schema: page(CustomerDeposit) })).items,
  });
  if (!customerId || !deps.data?.length) return null;
  const used = value.reduce((a, v) => a.plus(d(/^\d+(\.\d+)?$/.test(v.amount) ? v.amount : 0)), d(0));
  const kind = deps.data.find((x) => value.some((v) => v.no === x.no))?.type;
  const set = (no: string, amount: string | null) => onChange(amount == null ? value.filter((v) => v.no !== no) : value.some((v) => v.no === no) ? value.map((v) => (v.no === no ? { no, amount } : v)) : [...value, { no, amount }]);
  return (
    <div className="note" data-testid="deposit-picker" style={{ marginTop: 8 }}>
      <b>หักมัดจำ / เงินรับล่วงหน้าของลูกค้า</b>
      <div className="tw">
        <table>
          <thead><tr><th /><th>เลขที่</th><th>ประเภท</th><th className="n">คงเหลือ</th><th className="n">หักครั้งนี้</th></tr></thead>
          <tbody>{deps.data.map((x) => {
            const on = value.find((v) => v.no === x.no);
            const other = !!kind && kind !== x.type;
            return (
              <tr key={x.no}>
                <td><input type="checkbox" checked={!!on} disabled={other} aria-label={`หัก ${x.no}`} data-testid={`use-dep-${x.no}`}
                  onChange={(e) => { const room = total == null ? d(x.remaining) : d(total).minus(used); set(x.no, e.target.checked ? (d(x.remaining).lt(room) ? x.remaining : room.gt(0) ? room.toFixed(2) : '0') : null); }} /></td>
                <td className="mono">{x.no}{x.soNo && <div className="small muted">{x.soNo}</div>}</td><td>{DEP_TYPE_TH[x.type]}</td><td className="n">{fmt(x.remaining)}</td>
                <td className="n">{on && <input className="pu-qty-in" type="text" inputMode="decimal" value={on.amount} aria-label={`ยอดหัก ${x.no}`} onChange={(e) => set(x.no, e.target.value)} />}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {used.gt(0) && <div className="small">หัก{kind ? DEP_TYPE_TH[kind] : ''} ฿{fmt(used.toFixed(2))}{total != null && <> · ยอดที่ต้องชำระ <b data-testid="deposit-due">฿{fmt(d(total).minus(used).toFixed(2))}</b></>}{kind === 'advance' ? ' (VAT ของเงินล่วงหน้าหักออกจากใบกำกับนี้)' : ''}</div>}
    </div>
  );
}
