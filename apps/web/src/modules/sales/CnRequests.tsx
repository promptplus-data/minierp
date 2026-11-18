/** ขอลดหนี้ขาย: request a price-reduction credit note on an invoice; a manager / owner approves and the CN is issued. */
import { useState } from 'react';
import { CnRequest } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { fmt, Modal, Pill, SkeletonRows, th, thTime, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { NoteField } from '../../ui/NoteField';
import { useSalesInvalidate } from './shared';
import { DocLink } from '../../doclink';

const ST: Record<CnRequest['status'], [string, 'warn' | 'ok' | 'mut' | 'bad']> = { pending: ['รออนุมัติ', 'warn'], approved: ['อนุมัติ · ออกใบลดหนี้แล้ว', 'ok'], rejected: ['ไม่อนุมัติ', 'bad'], cancelled: ['ยกเลิกคำขอ', 'mut'] };
const REFUND_TH = { credit: 'เก็บเป็นเครดิตลูกค้า', transfer: 'โอนคืน', cash: 'คืนเงินสด' } as const;
const REASONS = ['สินค้ามีตำหนิ ลูกค้าไม่คืนของ ขอลดราคา', 'คิดราคาผิด / ราคาตามที่ตกลงต่ำกว่า', 'ส่วนลดตามยอดซื้อที่ตกลงภายหลัง', 'ค่าขนส่งที่คิดเกิน'];

export function CnRequestTab({ q }: { q: string }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [status, setStatus] = useState<'pending' | 'all'>('all');
  const r = useLoadMore(['ar', 'cn-requests', status], '/api/ar/cn-requests', CnRequest, { q, status }, 20);
  const [form, setForm] = useState(false);
  const [busy, setBusy] = useState('');
  const canApprove = can('sales.return') === 1;
  const canAsk = can('sales.doc') === 1 || can('fin.ar') === 1;
  const act = async (x: CnRequest, what: 'approve' | 'reject' | 'cancel') => {
    const note = what === 'reject' ? window.prompt('เหตุผลที่ไม่อนุมัติ') ?? '' : '';
    setBusy(x.no);
    try {
      const res = what === 'cancel'
        ? await api('POST', `/api/ar/cn-requests/${x.no}/cancel`, { schema: CnRequest })
        : await api('POST', `/api/ar/cn-requests/${x.no}/decide`, { body: { approve: what === 'approve', note }, schema: CnRequest });
      toast(what === 'approve' ? `อนุมัติ ${x.no} · ออกใบลดหนี้ ${res.cnNo}` : what === 'reject' ? `ไม่อนุมัติ ${x.no}` : `ยกเลิกคำขอ ${x.no}`);
      await invalidate();
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy('');
    }
  };
  return (
    <>
      <div className="row" style={{ marginBottom: 8, justifyContent: 'space-between' }}>
        <div className="steps">
          {([['all', 'ทั้งหมด'], ['pending', 'รออนุมัติ']] as const).map(([k, l]) => <span key={k} role="button" tabIndex={0} className={status === k ? 'on' : ''} onClick={() => setStatus(k)} onKeyDown={(e) => { if (e.key === 'Enter') setStatus(k); }}>{l}</span>)}
        </div>
        {canAsk && <button className="btn pri sm" onClick={() => setForm(true)} data-testid="btn-cn-request">+ ขอลดหนี้</button>}
      </div>
      <div className="tw">
        <table data-testid="cn-request-table">
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>ใบกำกับ / ลูกค้า</th><th className="n">ขอลดหนี้</th><th>เหตุผล</th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {r.isLoading ? <SkeletonRows cols={7} rows={3} /> : r.rows.map((x) => (
              <tr key={x.id} data-testid={`cr-${x.no}`}>
                <td className="mono">{x.no}</td><td>{th(x.date)}<div className="small muted">{x.requestedBy}</div></td>
                <td><DocLink no={x.invoiceNo} type="INV" /><div className="small">{x.customer.name}</div><div className="small muted">ยอด {fmt(x.invoiceTotal)} · ค้าง {fmt(x.invoiceBalance)}</div></td>
                <td className="n"><b>{fmt(x.amount)}</b><div className="small muted">{REFUND_TH[x.refundMethod]}</div></td>
                <td className="small">{x.reason}{x.note && <div className="muted">{x.note}</div>}{x.decideNote && <div className="muted">ผู้อนุมัติ: {x.decideNote}</div>}</td>
                <td><Pill k={ST[x.status][1]}>{ST[x.status][0]}</Pill>{x.cnNo && <div className="small"><DocLink no={x.cnNo} /></div>}{x.decidedBy && <div className="small muted">{x.decidedBy} · {thTime(x.decidedAt!)}</div>}</td>
                <td>{x.status === 'pending' && (
                  <span className="row" style={{ flexWrap: 'nowrap' }}>
                    {canApprove && <button className="btn sm pri" disabled={!!busy} onClick={() => void act(x, 'approve')} data-testid={`cr-approve-${x.no}`}>อนุมัติ</button>}
                    {canApprove && <button className="btn sm bad" disabled={!!busy} onClick={() => void act(x, 'reject')}>ไม่อนุมัติ</button>}
                    {(x.requestedBy === user?.name || canApprove) && <button className="btn sm" disabled={!!busy} onClick={() => void act(x, 'cancel')}>ยกเลิกคำขอ</button>}
                  </span>
                )}</td>
              </tr>
            ))}
            {!r.isLoading && !r.rows.length && <tr><td colSpan={7} className="empty">ยังไม่มีคำขอลดหนี้</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="cr-more" />
      <p className="small muted" style={{ margin: '8px 0 0' }}>ลดราคาหลังออกใบกำกับโดยไม่รับของคืน · ผู้จัดการหรือเจ้าของร้านอนุมัติ (อนุมัติคำขอของตัวเองไม่ได้ ยกเว้นเจ้าของร้าน) · ใบลดหนี้ลดยอดค้างของใบกำกับก่อน ส่วนที่เกินคืนตามวิธีที่เลือก</p>
      {form && <CnRequestModal onClose={() => setForm(false)} onDone={(no) => { setForm(false); toast(`ส่งคำขอ ${no} รออนุมัติ`); void invalidate(); }} />}
    </>
  );
}

export function CnRequestModal({ invoiceNo, onClose, onDone }: { invoiceNo?: string; onClose: () => void; onDone: (no: string) => void }) {
  const [inv, setInv] = useState(invoiceNo ?? '');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState(REASONS[0]!);
  const [other, setOther] = useState('');
  const [refund, setRefund] = useState<'credit' | 'transfer' | 'cash'>('credit');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const why = reason === '__o' ? other.trim() : reason;
  const go = async () => {
    if (!inv.trim()) return setErr('ใส่เลขที่ใบกำกับ');
    if (!/^\d+(\.\d+)?$/.test(amount) || !d(amount).gt(0)) return setErr('ใส่ยอดลดหนี้ (รวม VAT)');
    if (!why) return setErr('ระบุเหตุผล');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/ar/cn-requests', { body: { invoiceNo: inv.trim(), amount, reason: why, note, refundMethod: refund }, schema: CnRequest });
      onDone(r.no);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="ขอลดหนี้">
      <h3>ขอลดหนี้ (ลดราคาหลังขาย ไม่รับของคืน)</h3>
      <div className="fgrid">
        <label className="f">ใบกำกับภาษี *<input type="text" value={inv} onChange={(e) => setInv(e.target.value)} placeholder="เช่น INV2611-0012" data-testid="cr-invoice" /></label>
        <label className="f">ยอดลดหนี้ (รวม VAT) *<input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="cr-amount" /></label>
        <label className="f">เหตุผล<select value={reason} onChange={(e) => setReason(e.target.value)} data-testid="cr-reason">{REASONS.map((x) => <option key={x}>{x}</option>)}<option value="__o">อื่น ๆ (ระบุเอง)</option></select></label>
        {reason === '__o' && <label className="f">ระบุเหตุผล *<input type="text" value={other} onChange={(e) => setOther(e.target.value)} data-testid="cr-reason-other" /></label>}
        <label className="f">ส่วนที่เกินยอดค้าง<select value={refund} onChange={(e) => setRefund(e.target.value as typeof refund)} data-testid="cr-refund">{(['credit', 'transfer', 'cash'] as const).map((k) => <option key={k} value={k}>{REFUND_TH[k]}</option>)}</select></label>
        <NoteField value={note} onChange={setNote} testId="cr-note" placeholder="เช่น คุยกับลูกค้าทางโทรศัพท์วันที่ 12" />
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy} onClick={() => void go()} data-testid="cr-save">ส่งคำขอให้อนุมัติ</button></div>
    </Modal>
  );
}
