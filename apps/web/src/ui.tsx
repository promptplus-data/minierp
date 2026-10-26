/** Shared UI pieces ported from the mockup: pills, modal, toast, skeleton, pager, approval PIN, shortage table, reasons. */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { d, fmtTHB, type Num } from '@erp/core';
import { useApprovers, useCatalog, useWarehouses } from './data';

// ---------- formatting ----------
export const fmt = (x: Num | null | undefined) => fmtTHB(x ?? 0);
/** Quantity: up to 2 dp, thousands separators, no trailing zeros. */
export const fq = (x: Num | null | undefined) => {
  const v = d(x ?? 0).toDecimalPlaces(2).toNumber();
  return v.toLocaleString('th-TH', { maximumFractionDigits: 2 });
};
/** 'YYYY-MM-DD' (or ISO timestamp) → dd/mm/yyyy Buddhist era. */
export const th = (iso: string) => {
  const [y, m, dd] = iso.slice(0, 10).split('-');
  return `${dd}/${m}/${Number(y) + 543}`;
};
/** ISO timestamp → dd/mm/yyyy hh:mm in the shop's time zone. */
export const thTime = (iso: string) => {
  const dt = new Date(iso);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(dt);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${g('day')}/${g('month')}/${Number(g('year')) + 543} ${g('hour')}:${g('minute')}`;
};
export const hm = (iso: string) => thTime(iso).slice(-5);

export type PillKind = 'ok' | 'warn' | 'bad' | 'acc' | 'mut';
export const Pill = ({ k, children }: { k: PillKind; children: ReactNode }) => <span className={`pill p-${k}`}>{children}</span>;

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ---------- toast ----------
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}

// ---------- modal ----------
export function Modal({ children, onClose, wide, label }: { children: ReactNode; onClose: () => void; wide?: boolean; label?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="ov" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`md${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>,
    document.body,
  );
}

// ---------- loading / paging ----------
export function SkeletonRows({ cols, rows = 6 }: { cols: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} className="skrow" aria-hidden="true">
          {Array.from({ length: cols }, (_, j) => <td key={j}><div className="sk" style={{ width: `${50 + ((i * 7 + j * 13) % 45)}%` }} /></td>)}
        </tr>
      ))}
    </>
  );
}

/** Keyset paging state: a stack of cursors (undefined = first page). */
export function useCursorPager(resetKey: string) {
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) {
    setKey(resetKey);
    setStack([undefined]);
  }
  const cursor = stack[stack.length - 1];
  return {
    cursor,
    page: stack.length,
    next: (c: string | null) => { if (c) setStack((s) => [...s, c]); },
    prev: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    reset: () => setStack([undefined]),
  };
}

export function Pager({ page, hasNext, onPrev, onNext, count, loading }: { page: number; hasNext: boolean; onPrev: () => void; onNext: () => void; count?: number; loading?: boolean }) {
  return (
    <div className="pager">
      <span className="small muted">หน้า {page}{count != null ? ` · ${count} รายการในหน้านี้` : ''}{loading ? ' · กำลังโหลด…' : ''}</span>
      <div className="row">
        <button className="btn sm" onClick={onPrev} disabled={page <= 1}>‹ ก่อนหน้า</button>
        <button className="btn sm" onClick={onNext} disabled={!hasNext}>ถัดไป ›</button>
      </div>
    </div>
  );
}

// ---------- approval PIN (needPerm in the mockup) ----------
export interface ApprovalInput { approverUserId: string; pin: string }

export function ApprovalModal({ ownerOnly, title, label, onSubmit, onClose }: {
  ownerOnly?: boolean; title?: string; label: ReactNode;
  /** Returns an error text to show in the modal, or null when the caller is done (and closes it). */
  onSubmit: (a: ApprovalInput) => Promise<string | null>;
  onClose: () => void;
}) {
  const approvers = useApprovers();
  const list = (approvers.data ?? []).filter((u) => (ownerOnly ? u.role === 'owner' : true));
  const [by, setBy] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const who = by || list[0]?.id || '';
  const go = async () => {
    if (!who) return setErr('ไม่มีผู้อนุมัติ');
    if (!pin) return setErr('ใส่ PIN ก่อน');
    setBusy(true);
    setErr('');
    try {
      const e = await onSubmit({ approverUserId: who, pin });
      if (e) setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="ขออนุมัติ">
      <h3>{title ?? (ownerOnly ? 'ต้องให้เจ้าของร้านอนุมัติ' : 'ต้องให้ผู้จัดการอนุมัติ')}</h3>
      <div>{label}</div>
      <p className="small muted" style={{ margin: 0 }}>{ownerOnly ? 'รายการนี้ต้องให้เจ้าของร้านใส่ PIN เท่านั้น ผู้จัดการอนุมัติแทนไม่ได้' : 'ต้องให้ผู้จัดการร้านหรือเจ้าของร้านใส่ PIN อนุมัติ'}</p>
      <label className="f">ผู้อนุมัติ
        <select value={who} onChange={(e) => setBy(e.target.value)} data-testid="apv-by">
          {list.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.role === 'owner' ? 'เจ้าของร้าน' : 'ผู้จัดการ'}</option>)}
        </select>
      </label>
      <label className="f">PIN
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} placeholder="••••" value={pin} autoFocus
          onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} data-testid="apv-pin" />
      </label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" onClick={() => void go()} disabled={busy} data-testid="apv-ok">อนุมัติ</button>
      </div>
    </Modal>
  );
}

// ---------- INSUFFICIENT_STOCK (mockup blockShort) ----------
export interface Shortage { productId: string; warehouseId: string; need: string; have: string }

export function ShortageModal({ shortages, what, onClose }: { shortages: Shortage[]; what?: string; onClose: () => void }) {
  const cat = useCatalog();
  const whs = useWarehouses();
  const pName = (id: string) => cat.byId.get(id)?.name ?? id;
  const pUnit = (id: string) => cat.byId.get(id)?.units[0]?.name ?? '';
  const wName = (id: string) => whs.data?.find((w) => w.id === id)?.name ?? id;
  return (
    <Modal onClose={onClose} label="สต็อกไม่พอ">
      <h3>สต็อกไม่พอ{what ? ` · ${what}` : ''}</h3>
      <p className="small" style={{ margin: 0 }}>ระบบไม่ให้สต็อกติดลบ (BR-07) ถ้าของมาถึงร้านแล้วให้บันทึกรับของเข้าก่อน หรือขอปรับยอดให้เจ้าของอนุมัติ</p>
      <div className="tw">
        <table data-testid="shortage-table">
          <thead><tr><th>สินค้า</th><th>คลัง</th><th className="n">ต้องใช้</th><th className="n">คงเหลือ</th></tr></thead>
          <tbody>
            {shortages.map((s) => (
              <tr key={s.productId + s.warehouseId}>
                <td>{pName(s.productId)}</td><td>{wName(s.warehouseId)}</td>
                <td className="n">{fq(s.need)} {pUnit(s.productId)}</td><td className="n" style={{ color: 'var(--bad)' }}>{fq(s.have)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="act"><button className="btn pri" onClick={onClose}>ตกลง</button></div>
    </Modal>
  );
}

// ---------- reason select + "อื่น ๆ" ----------
export const REASONS = {
  void: ['ออกบิลผิด (ราคา / จำนวน / สินค้า)', 'ลูกค้าเปลี่ยนใจก่อนรับของ', 'ออกผิดลูกค้า / ข้อมูลภาษีผิด', 'บิลซ้ำ'],
  ret: ['สินค้าชำรุด / แตก', 'ส่งผิดรุ่น / ผิดสี', 'ลูกค้าซื้อเกิน ใช้ไม่หมด', 'ราคาผิด (ลดหนี้อย่างเดียว ไม่คืนของ)'],
  iss: ['ใช้ในร้าน', 'ตัวอย่างให้ลูกค้า', 'ชำรุด / เสียหาย'],
  adj: ['สินค้าแตกเสียหาย', 'นับแล้วไม่ตรง', 'บันทึกผิด'],
  tr: ['เติมของหน้าร้าน', 'ย้ายไปคลังสาขา', 'ย้ายของเสียไปคลังรอคืน'],
} as const;
export const OTHER = '__o';

export interface ReasonState { pick: string; other: string }
export const reasonInit = (kind: keyof typeof REASONS): ReasonState => ({ pick: REASONS[kind][0], other: '' });
/** The final reason text, or null when "อื่น ๆ" is picked without text. */
export const reasonText = (r: ReasonState): string | null => (r.pick === OTHER ? (r.other.trim() || null) : r.pick);

export function ReasonField({ kind, value, onChange, label = 'เหตุผล', testId }: { kind: keyof typeof REASONS; value: ReasonState; onChange: (r: ReasonState) => void; label?: string; testId?: string }) {
  return (
    <>
      <label className="f">{label}
        <select value={value.pick} onChange={(e) => onChange({ ...value, pick: e.target.value })} data-testid={testId}>
          {REASONS[kind].map((x) => <option key={x} value={x}>{x}</option>)}
          <option value={OTHER}>อื่น ๆ (ระบุเอง)</option>
        </select>
      </label>
      {value.pick === OTHER && (
        <label className="f">ระบุเหตุผล *
          <input type="text" value={value.other} placeholder="พิมพ์เหตุผล" onChange={(e) => onChange({ ...value, other: e.target.value })} data-testid={testId ? `${testId}-other` : undefined} />
        </label>
      )}
    </>
  );
}
