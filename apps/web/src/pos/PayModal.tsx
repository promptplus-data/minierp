/** POS payment dialog: document kind, customer (searchable, quick-create), split payments, เงินเชื่อ, bill note. */
import { useState, type ReactNode } from 'react';
import type { PosSaleReq } from '@erp/contracts';
import { d, sum, termLabel } from '@erp/core';
import { CustomerPicker, useCustomer } from '../ui/CustomerPicker';
import { fmt, Modal, Pill } from '../ui';
import { useTouch } from '../touch';
import { METHOD_TH } from './Receipt';

export type Method = PosSaleReq['payments'][number]['method'];
interface PayLine { method: Method; amount: string }
export interface Payload { docKind: PosSaleReq['docKind']; customerId?: string; payments: { method: Method; amount: string }[]; note?: string }

const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());
const PAY_METHODS: Method[] = ['cash', 'transfer', 'promptpay', 'card'];

export function PayModal({ total, vat, err, onClose, onPay, defaultCustomer, abbAllowed = true, abbNote }: {
  total: string; vat: boolean; err: string; onClose: () => void; onPay: (p: Payload) => Promise<void>; defaultCustomer?: string | null; abbAllowed?: boolean; abbNote?: ReactNode;
}) {
  const [kind, setKind] = useState<PosSaleReq['docKind']>(vat ? (abbAllowed ? 'abb' : 'full') : 'receipt');
  const [cust, setCust] = useState<string | null>(defaultCustomer ?? null);
  const [lines, setLines] = useState<PayLine[]>([{ method: 'cash', amount: total }]);
  const [recv, setRecv] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const c = useCustomer(cust).data ?? null;
  const fullNeedsTax = kind === 'full' && !(c?.taxId);
  const creditTerm = !!c && c.term.t !== 'cash';
  const onCredit = lines.some((l) => l.method === 'credit');
  const paid = sum(lines.map((l) => (isNum(l.amount) ? l.amount : 0)));
  const exact = paid.eq(d(total));
  const cash = lines.find((l) => l.method === 'cash');
  const change = cash && isNum(recv) ? d(recv).minus(d(isNum(cash.amount) ? cash.amount : 0)) : null;
  const creditBad = onCredit && (!creditTerm || lines.length > 1);
  const ok = exact && lines.every((l) => isNum(l.amount) && d(l.amount).gt(0)) && !fullNeedsTax && !creditBad;
  const upd = (i: number, patch: Partial<PayLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const { touchMode } = useTouch();
  /** Touch quick-cash: exact amount, then the next 100 / 500 / 1,000 note. */
  const quick = (() => {
    if (!cash || !isNum(cash.amount)) return [];
    const a = d(cash.amount);
    const ups = [100, 500, 1000].map((n) => a.div(n).ceil().times(n));
    return [a, ...ups].filter((v, i, all) => all.findIndex((x) => x.eq(v)) === i).slice(0, 4);
  })();
  const setMethod = (i: number, m: Method) => {
    // เงินเชื่อ: the whole bill goes on credit, one line.
    if (m === 'credit') setLines([{ method: 'credit', amount: d(total).toFixed(2) }]);
    else upd(i, { method: m });
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await onPay({
        docKind: kind, ...(cust ? { customerId: cust } : {}), ...(note.trim() ? { note: note.trim() } : {}),
        payments: lines.map((l) => ({ method: l.method, amount: d(l.amount).toFixed(2) })),
      });
    } finally {
      setBusy(false);
    }
  };

  const picker = (label: string) => (
    // a div, not a label: a click on a list option inside a <label> would re-focus the input and reopen the list
    <div className="f pay-cust" style={{ marginTop: 8 }}><span>{label}</span>
      <CustomerPicker value={cust} onChange={(id) => setCust(id)} requireTaxId={kind === 'full'} emptyLabel={kind === 'full' ? undefined : 'ลูกค้าทั่วไป'}
        testId="pay-cust" ariaLabel="ลูกค้าของเอกสาร" invalid={fullNeedsTax && !!cust} />
    </div>
  );

  return (
    <Modal onClose={onClose} label="ชำระเงิน">
      <h3>ชำระเงิน ฿{fmt(total)}</h3>
      {vat ? (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>ประเภทเอกสาร</div>
          <div className="row">
            <label className="row"><input type="radio" name="inv" checked={kind === 'abb'} disabled={!abbAllowed} onChange={() => setKind('abb')} /> ใบกำกับภาษีอย่างย่อ</label>
            <label className="row"><input type="radio" name="inv" checked={kind === 'full'} onChange={() => setKind('full')} data-testid="kind-full" /> ใบกำกับภาษีเต็มรูป</label>
          </div>
          {!abbAllowed && <div className="note warn small" style={{ marginTop: 6 }} data-testid="abb-off">{abbNote}</div>}
          {picker(kind === 'full' ? 'ลูกค้า (ต้องมีเลขผู้เสียภาษี)' : 'ลูกค้า (ไม่บังคับ · ต้องระบุถ้าขายเชื่อ)')}
          {fullNeedsTax && <div className="small" style={{ color: 'var(--bad)' }} data-testid="need-tax">ใบกำกับภาษีเต็มรูปต้องเลือกลูกค้าที่มีเลขผู้เสียภาษี</div>}
        </div>
      ) : (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>ประเภทเอกสาร</div>
          <b>ใบเสร็จรับเงิน</b> <span className="small muted">ร้านไม่จด VAT จึงไม่ออกใบกำกับภาษี</span>
          {picker('ลูกค้า (ไม่บังคับ · ต้องระบุถ้าขายเชื่อ)')}
        </div>
      )}
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>วิธีชำระ (บันทึกในระบบเท่านั้น ไม่เชื่อมลิ้นชักเงินหรือเครื่องรูดบัตร)</div>
        {lines.map((l, i) => (
          <div className="row" style={{ marginBottom: 6 }} key={i}>
            <select value={l.method} onChange={(e) => setMethod(i, e.target.value as Method)} aria-label={`วิธีชำระ ${i + 1}`} data-testid={`pm-${i}`}>
              {PAY_METHODS.map((m) => <option key={m} value={m}>{METHOD_TH[m]}</option>)}
              <option value="credit" disabled={!creditTerm}>{METHOD_TH.credit}{creditTerm ? '' : ' (เลือกลูกค้าเครดิตก่อน)'}</option>
            </select>
            <input type="text" inputMode="decimal" data-field={`payments.${i}.amount`} value={l.amount} onChange={(e) => upd(i, { amount: e.target.value })} style={{ width: 140 }}
              aria-label={`จำนวนเงิน ${i + 1}`} data-testid={`pa-${i}`} readOnly={l.method === 'credit'} />
            {lines.length > 1 && <button className="btn sm bad" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>ลบ</button>}
          </div>
        ))}
        {!onCredit && (
          <button className="btn sm" data-testid="add-pay" onClick={() => {
            const rest = d(total).minus(paid);
            setLines((ls) => [...ls, { method: 'transfer', amount: rest.gt(0) ? rest.toFixed(2) : '0' }]);
          }}>+ แยกชำระอีกวิธี</button>
        )}
        {onCredit && c && (
          <div className="note small pay-credit" data-testid="credit-info">
            ขายเชื่อทั้งบิลให้ <b>{c.name}</b> · เครดิต {termLabel(c.term)} · วงเงิน {d(c.creditLimit).gt(0) ? `฿${fmt(c.creditLimit)}` : 'ตามค่าเริ่มต้นของร้าน'} ·
            ยอดนี้จะไปอยู่ที่ "ลูกหนี้" เพื่อวางบิล / รับชำระภายหลัง และไม่นับเป็นเงินสดในลิ้นชัก
          </div>
        )}
        {onCredit && !creditTerm && <div className="small" style={{ color: 'var(--bad)' }}>ขายเชื่อได้เฉพาะลูกค้าที่มีเครดิต (ตั้งเครดิตที่ทะเบียนลูกค้า)</div>}
        {cash && (
          <div className="row" style={{ marginTop: 8 }}>
            <label className="f">รับเงินสดมา<input type="text" inputMode="decimal" name="received" value={recv} placeholder={cash.amount} onChange={(e) => setRecv(e.target.value)} /></label>
            <div><div className="small muted">เงินทอน</div><b style={{ fontSize: 18 }} data-testid="pay-change">{fmt(change && change.gt(0) ? change : 0)}</b></div>
          </div>
        )}
        {touchMode && cash && quick.length > 0 && (
          <div className="row" style={{ marginTop: 8 }} role="group" aria-label="รับเงินสดด่วน">
            {quick.map((v, i) => (
              <button type="button" key={v.toString()} className="btn" data-busy="off" data-testid={`quick-cash-${i}`} onClick={() => setRecv(v.toFixed(2).replace(/\.00$/, ''))}>{i === 0 ? 'พอดี ' : ''}฿{fmt(v)}</button>
            ))}
          </div>
        )}
        {lines.some((l) => l.method === 'transfer' || l.method === 'promptpay') && <div className="note small" style={{ marginTop: 8 }}>ตรวจยอดเงินเข้าในแอปธนาคารของร้านก่อนกดยืนยัน</div>}
      </div>
      <label className="f">หมายเหตุบิล (พิมพ์บนใบเสร็จ)
        <textarea name="note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ส่งของบ่ายนี้ / ลูกค้ามารับเอง" data-testid="pay-note" />
      </label>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>รวมที่ชำระ <b>{fmt(paid)}</b></span>
        {exact ? <Pill k="ok">ยอดครบ</Pill> : <Pill k="bad">ยังขาด/เกิน {fmt(d(total).minus(paid))}</Pill>}
      </div>
      {err && <div className="note bad small" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>กลับไปแก้บิล</button>
        <button className="btn pri" onClick={() => void confirm()} disabled={!ok || busy} data-testid="pay-confirm">ยืนยันชำระและออกเอกสาร</button>
      </div>
    </Modal>
  );
}
