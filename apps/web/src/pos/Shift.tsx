/** Cash & carry shift (M07-06): open, strip with X report, cash in / out, close with counted cash and Z report. */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Shift } from '@erp/contracts';
import { d, sum } from '@erp/core';
import { api, errText } from '../api';
import { useAuth } from '../auth';
import { fmt, hm, Modal, Pill, useToast } from '../ui';
import { METHOD_TH, ShiftSlip } from './Receipt';

const DEVICE_KEY = 'erp-device-id';
let memoDevice: string | null = null;
/** This machine's POS id, kept in localStorage (falls back to memory when storage is blocked). */
export function deviceId(): string {
  const fresh = () => `POS-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;
  try {
    let v = localStorage.getItem(DEVICE_KEY);
    if (!v) {
      v = fresh();
      localStorage.setItem(DEVICE_KEY, v);
    }
    return v;
  } catch {
    return (memoDevice ??= fresh());
  }
}

export function ShiftClosed() {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [float, setFloat] = useState('2000');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = can('fin.shift') === 1 || can('pos.sell') === 1;
  const dev = deviceId();
  const open = async () => {
    if (!/^\d+(\.\d+)?$/.test(float.trim())) return setErr('ใส่เงินทอนตั้งต้นเป็นตัวเลข');
    setBusy(true);
    setErr('');
    try {
      const s = await api('POST', '/api/shifts/open', { body: { float: float.trim(), deviceId: dev }, schema: Shift });
      qc.setQueryData(['shift'], s);
      toast(`เปิดกะ ${s.no} แล้ว`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ maxWidth: 600, margin: '0 auto', width: '100%' }}>
      <h2>ยังไม่ได้เปิดกะ <Pill k="warn">ขายหน้าร้านถูกล็อก</Pill></h2>
      <p className="small muted" style={{ marginTop: 0 }}>ขายหน้าร้าน (cash &amp; carry) ต้องเปิดกะก่อน ระบบผูกทุกบิล เงินทอนตั้งต้น และเงินเข้า/ออกลิ้นชักไว้กับกะ แล้วเทียบกับเงินที่นับได้ตอนปิดกะ</p>
      <div className="fgrid">
        <label className="f">ผู้เปิดกะ<input type="text" value={user?.name ?? ''} readOnly /></label>
        <label className="f">เครื่อง POS<input type="text" value={dev} readOnly /></label>
        <label className="f">เงินทอนตั้งต้นในลิ้นชัก (บาท)<input type="text" inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} data-testid="shift-float" /></label>
      </div>
      {err && <div className="err" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      <div className="act" style={{ marginTop: 12 }}><button className="btn pri" onClick={() => void open()} disabled={!ok || busy} data-testid="shift-open">เปิดกะ</button></div>
      {!ok && <p className="small" style={{ color: 'var(--bad)' }}>บทบาทนี้เปิดกะไม่ได้</p>}
    </div>
  );
}

export function ShiftStrip({ shift }: { shift: Shift }) {
  const { user } = useAuth();
  const [m, setM] = useState<'move' | 'x' | 'close' | null>(null);
  const sales = sum(Object.values(shift.byMethod));
  return (
    <div className="card" style={{ padding: '12px 16px', borderLeft: '4px solid var(--ok)' }} data-testid="shift-strip">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <Pill k="ok">กะเปิดอยู่</Pill><b className="mono">{shift.no}</b>
          <span className="small muted">{user?.name} · เปิด {hm(shift.openedAt)} · {shift.deviceId} · เงินทอนตั้งต้น {fmt(shift.float)}</span>
        </div>
        <div className="row">
          <span className="small">฿{fmt(sales)} · เงินสดในลิ้นชักควรมี <b>฿{fmt(shift.expected)}</b></span>
          <button className="btn sm" onClick={() => setM('move')}>นำเงินเข้า/ออก</button>
          <button className="btn sm" onClick={() => setM('x')}>รายงานระหว่างกะ (X)</button>
          <button className="btn sm pri" onClick={() => setM('close')} data-testid="shift-close">ปิดกะ</button>
        </div>
      </div>
      {m === 'move' && <CashMoveModal shift={shift} onClose={() => setM(null)} />}
      {m === 'x' && (
        <Modal onClose={() => setM(null)} label="รายงาน X">
          <h3>รายงานระหว่างกะ (X)</h3>
          <ShiftSlip shift={shift} userName={user?.name ?? ''} />
          <div className="act"><button className="btn" onClick={() => window.print()}>พิมพ์</button><button className="btn pri" onClick={() => setM(null)}>ปิด</button></div>
        </Modal>
      )}
      {m === 'close' && <CloseShiftModal shift={shift} onClose={() => setM(null)} />}
    </div>
  );
}

function CashMoveModal({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const save = async () => {
    if (!/^\d+(\.\d+)?$/.test(amount.trim()) || d(amount).lte(0)) return setErr('ใส่จำนวนเงินมากกว่า 0');
    if (!note.trim()) return setErr('ใส่หมายเหตุ เช่น แลกเหรียญ / ส่งเงินเข้าเซฟ');
    try {
      await api('POST', `/api/shifts/${shift.id}/cash-moves`, { body: { type, amount: amount.trim(), note: note.trim() } });
      await qc.invalidateQueries({ queryKey: ['shift'] });
      toast(type === 'in' ? `นำเงินเข้าลิ้นชัก ${fmt(amount)} แล้ว` : `นำเงินออกจากลิ้นชัก ${fmt(amount)} แล้ว`);
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <Modal onClose={onClose} label="นำเงินเข้า/ออก">
      <h3>นำเงินเข้า / ออกลิ้นชัก · {shift.no}</h3>
      <div className="row">
        <label className="row"><input type="radio" checked={type === 'in'} onChange={() => setType('in')} /> นำเงินเข้า</label>
        <label className="row"><input type="radio" checked={type === 'out'} onChange={() => setType('out')} /> นำเงินออก</label>
      </div>
      <div className="fgrid">
        <label className="f">จำนวนเงิน (บาท)<input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="f">หมายเหตุ<input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น แลกเหรียญ / ส่งเงินเข้าเซฟ" /></label>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void save()}>บันทึก</button></div>
    </Modal>
  );
}

const DENOM = [1000, 500, 100, 50, 20, 10, 5, 2, 1];

function CloseShiftModal({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [cnt, setCnt] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [z, setZ] = useState<Shift | null>(null);
  const n = (v: number) => (/^\d+$/.test(cnt[v] ?? '') ? Number(cnt[v]) : 0);
  const counted = DENOM.reduce((a, v) => a + n(v) * v, 0);
  const diff = d(counted).minus(d(shift.expected));
  const others = Object.entries(shift.byMethod).filter(([k]) => k !== 'cash');

  const close = async () => {
    if (!diff.isZero() && !note.trim()) return setErr('เงินขาดหรือเกิน ต้องใส่หมายเหตุ');
    setBusy(true);
    setErr('');
    try {
      const s = await api('POST', `/api/shifts/${shift.id}/close`, { body: { counted: d(counted).toFixed(2), ...(note.trim() ? { note: note.trim() } : {}) }, schema: Shift });
      setZ(s);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const done = () => {
    qc.setQueryData(['shift'], null);
    void qc.invalidateQueries({ queryKey: ['shift'] });
    onClose();
  };

  if (z) {
    return (
      <Modal onClose={done} label="รายงาน Z">
        <h3>ปิดกะ {z.no} แล้ว</h3>
        <ShiftSlip shift={z} userName={user?.name ?? ''} note={note.trim() || undefined} />
        <div className="act"><button className="btn" onClick={() => window.print()}>พิมพ์รายงาน Z</button><button className="btn pri" onClick={done} data-testid="z-done">ตกลง</button></div>
      </Modal>
    );
  }
  return (
    <Modal onClose={onClose} wide label="ปิดกะ">
      <h3>ปิดกะ {shift.no}</h3>
      <p className="small muted" style={{ margin: 0 }}>นับเงินสดในลิ้นชักแยกตามชนิด ระบบเทียบกับยอดที่ควรมี</p>
      <div className="grid g2">
        <div className="tw">
          <table>
            <thead><tr><th>ชนิด</th><th className="n">จำนวน</th><th className="n">รวม</th></tr></thead>
            <tbody>
              {DENOM.map((v) => (
                <tr key={v}>
                  <td>{v >= 20 ? 'ธนบัตร' : 'เหรียญ'} {v}</td>
                  <td className="n"><input className="qty" type="text" inputMode="numeric" placeholder="0" value={cnt[v] ?? ''} aria-label={`จำนวน ${v} บาท`} onChange={(e) => setCnt((c) => ({ ...c, [v]: e.target.value }))} data-testid={`den-${v}`} /></td>
                  <td className="n">{fmt(n(v) * v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="tot">
            <span className="muted">เงินทอนตั้งต้น</span><span>{fmt(shift.float)}</span>
            <span className="muted">ขายเงินสด</span><span>{fmt(shift.cashSales)}</span>
            <span className="muted">คืนเงินสด</span><span>−{fmt(shift.cashRefunds)}</span>
            <span className="muted">นำเข้า / ออก</span><span>{fmt(d(shift.cashIn).minus(d(shift.cashOut)))}</span>
            <span style={{ fontWeight: 600 }}>ควรมี</span><span className="big">฿{fmt(shift.expected)}</span>
            <span style={{ fontWeight: 600 }}>นับได้</span><span className="big" data-testid="counted">฿{fmt(counted)}</span>
            <span className="muted">ขาด / เกิน</span>
            <span style={{ color: diff.lt(0) ? 'var(--bad)' : diff.gt(0) ? 'var(--warn)' : 'var(--ok)' }} data-testid="diff">{diff.gt(0) ? '+' : ''}{fmt(diff)}</span>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>ยอดโอน / QR / บัตรในกะ: {others.map(([k, v]) => `${METHOD_TH[k] ?? k} ${fmt(v)}`).join(' · ') || '-'}</div>
          <label className="f" style={{ marginTop: 8 }}>หมายเหตุ (จำเป็นถ้าเงินขาดหรือเกิน)<input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ทอนเงินผิด" data-testid="close-note" /></label>
        </div>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยังไม่ปิด</button><button className="btn pri" onClick={() => void close()} disabled={busy} data-testid="close-ok">ปิดกะและพิมพ์รายงาน Z</button></div>
    </Modal>
  );
}
