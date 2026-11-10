/**
 * App-wide error UX.
 *  - ErrorHost: listens to api.ts failures. A failed mutation nobody claimed opens ErrorDialog (red header, role=alertdialog);
 *    VALIDATION issues / field-tied codes first mark the matching inputs (red border + tint + text, focus on the first).
 *  - Field marking is DOM based and keyed by the inputs' `name` / `data-field` attribute, so screens only add the attribute.
 *    It never touches React-managed props: aria-invalid / aria-describedby attributes and one appended `.ferr` element.
 *  - checkFields(): client-side checks with the same red style. ErrorBanner / QueryFailBar: failed GETs, with retry.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsFetching, useQueryClient, type Query } from '@tanstack/react-query';
import { ApiFail, baseMessage, setFailListener, type FailReport } from './api';
import { useCatalog, useWarehouses, useAllWarehouses } from './data';
import { fq } from './ui';
import './errors.css';

// ---------- field marking ----------
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
const isControl = (el: Element | null): el is Control => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
let uid = 0;

/** The part of the page a failure belongs to: the topmost open modal, else the main content. */
export function topScope(): ParentNode {
  const m = document.querySelectorAll('.md');
  return m.length ? m[m.length - 1]! : (document.querySelector('main') ?? document);
}

const attr = (k: string) => k.replace(/["\\]/g, '\\$&');
const byKey = (scope: ParentNode, k: string): HTMLElement[] =>
  [...scope.querySelectorAll<HTMLElement>(`[name="${attr(k)}"],[data-field="${attr(k)}"]`)].filter((e) => !(e instanceof HTMLInputElement && e.type === 'hidden') && !e.closest('[hidden]'));
const controlOf = (el: HTMLElement): HTMLElement => (isControl(el) ? el : (el.querySelector<HTMLElement>('input,select,textarea') ?? el));

/** Input for a zod path such as ['lines', 2, 'qty']: tries lines.2.qty, lines[2].qty, then the nth lines.qty, then qty. */
export function findField(scope: ParentNode, path: (string | number)[] | string): HTMLElement | null {
  if (typeof path === 'string') return byKey(scope, path)[0] ? controlOf(byKey(scope, path)[0]!) : null; // exact key only
  const segs = path;
  const idx = segs.find((s): s is number => typeof s === 'number');
  const names = segs.filter((s): s is string => typeof s === 'string');
  const dotted = segs.join('.');
  const bracket = segs.reduce<string>((a, s) => (typeof s === 'number' ? `${a}[${s}]` : a ? `${a}.${s}` : s), '');
  for (const k of [dotted, bracket]) {
    const m = byKey(scope, k);
    if (m[0]) return controlOf(m[0]);
  }
  for (const k of [names.join('.'), names[names.length - 1]!]) {
    const m = k ? byKey(scope, k) : [];
    if (!m.length) continue;
    const pick = idx !== undefined ? m[idx] : m[0];
    if (pick) return controlOf(pick);
  }
  return null;
}

/** Drop `.ferr` boxes whose input is gone or no longer invalid (React removed the input, or the user fixed it). */
function sweep() {
  document.querySelectorAll('.ferr').forEach((b) => {
    const prev = b.previousElementSibling;
    if (!prev || prev.getAttribute('aria-invalid') !== 'true') b.remove();
  });
}

export function markInvalid(el: HTMLElement, msg: string): void {
  sweep();
  el.setAttribute('aria-invalid', 'true');
  if (!msg) return;
  let box = el.nextElementSibling?.classList.contains('ferr') ? (el.nextElementSibling as HTMLElement) : null;
  if (!box) {
    box = document.createElement('div');
    box.className = 'ferr';
    box.id = `ferr-${++uid}`;
    el.after(box);
  }
  box.textContent = msg;
  if (!el.hasAttribute('data-prev-describedby')) el.setAttribute('data-prev-describedby', el.getAttribute('aria-describedby') ?? '');
  el.setAttribute('aria-describedby', box.id);
}

export function clearInvalid(el: Element): void {
  if (el.getAttribute('aria-invalid') !== 'true') return;
  el.removeAttribute('aria-invalid');
  const prev = el.getAttribute('data-prev-describedby');
  if (prev) el.setAttribute('aria-describedby', prev);
  else el.removeAttribute('aria-describedby');
  el.removeAttribute('data-prev-describedby');
  sweep();
}

export function clearAllInvalid(scope: ParentNode = document): void {
  scope.querySelectorAll('[aria-invalid="true"]').forEach(clearInvalid);
}

export function focusField(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', behavior: 'auto' });
  try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
}

/** Human name of an input: its label text, aria-label, placeholder, else the key. */
function fieldLabel(el: HTMLElement, fallback: string): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const lab = (el as Control).labels?.[0] ?? el.closest('label');
  if (lab) {
    const c = lab.cloneNode(true) as HTMLElement;
    c.querySelectorAll('input,select,textarea,option,button,.ferr').forEach((n) => n.remove());
    const t = c.textContent?.replace(/\s+/g, ' ').replace(/\*/g, '').trim();
    if (t) return t;
  }
  return (el as HTMLInputElement).placeholder || fallback;
}

/**
 * Client-side checks, same red style as server errors. `checks` maps a field key (name / data-field) to an error text,
 * or a falsy value when the field is fine. Marks every failing field, focuses the first. Returns true when nothing failed.
 * A failing check whose field is not on screen opens the error dialog with its text instead of failing silently.
 */
export function checkFields(checks: Record<string, string | false | null | undefined>, scope: ParentNode = topScope()): boolean {
  clearAllInvalid(scope);
  let first: HTMLElement | null = null;
  const lost: string[] = [];
  let failed = false;
  for (const [key, msg] of Object.entries(checks)) {
    if (!msg) continue;
    failed = true;
    const el = findField(scope, key);
    if (el) {
      markInvalid(el, msg);
      first ??= el;
    } else lost.push(msg);
  }
  if (first) focusField(first);
  else if (lost.length) showError({ title: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง', message: lost[0]!, rows: lost.slice(1).map((text) => ({ text })) });
  return !failed;
}

export const requiredMsg = (v: string | null | undefined, what: string) => (!v || !v.trim() ? `กรุณากรอก${what}` : false);
export const taxIdMsg = (v: string | null | undefined) => (v && v.trim() && !/^\d{13}$/.test(v.trim()) ? 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' : false);
export const qtyMsg = (v: string | null | undefined, what = 'จำนวน') => {
  const n = Number((v ?? '').trim());
  return !v || !v.trim() || !Number.isFinite(n) || n <= 0 ? `${what}ต้องมากกว่า 0` : false;
};

/** Red message box for a form (login, setup): icon + text, role=alert. Renders nothing when there is no message. */
export function ErrorBox({ children, testId }: { children?: ReactNode; testId?: string }) {
  if (!children) return null;
  return <div className="errbox" role="alert" data-testid={testId}><ErrIcon size={18} /><span>{children}</span></div>;
}

/** Sign-in failures: wrong credentials mark both fields red, locked / resigned / disabled mark the username. */
export function markLoginFailure(e: unknown, scope: ParentNode = topScope()): void {
  const reason = e instanceof ApiFail && e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>).reason : undefined;
  const user = findField(scope, 'username');
  const pass = findField(scope, 'password');
  if (reason === 'BAD_CREDENTIALS') { if (user) markInvalid(user, ''); if (pass) markInvalid(pass, ''); }
  else if (reason === 'LOCKED' || reason === 'RESIGNED' || reason === 'DISABLED' || reason === 'TENANT_REQUIRED') { if (user) markInvalid(user, ''); }
  const first = user?.getAttribute('aria-invalid') === 'true' ? user : pass;
  if (first) focusField(first);
}

// ---------- mapping an API failure onto the page ----------
interface Issue { path: (string | number)[]; message?: string; code?: string; minimum?: number; maximum?: number; type?: string; inclusive?: boolean; received?: string; validation?: string; options?: unknown[] }

const issuesOf = (f: ApiFail): Issue[] =>
  f.code === 'VALIDATION' && Array.isArray(f.details) ? (f.details as Issue[]).filter((i) => i && Array.isArray(i.path)) : [];

function issueText(i: Issue): string {
  switch (i.code) {
    case 'invalid_type': return i.received === 'undefined' || i.received === 'null' ? 'ต้องกรอก' : 'ชนิดข้อมูลไม่ถูกต้อง';
    case 'too_small':
      if (i.type === 'string') return i.minimum === 1 ? 'ต้องกรอก' : `ต้องมีอย่างน้อย ${i.minimum} ตัวอักษร`;
      if (i.type === 'array') return `ต้องมีอย่างน้อย ${i.minimum} รายการ`;
      return i.inclusive === false ? `ต้องมากกว่า ${i.minimum}` : `ต้องไม่น้อยกว่า ${i.minimum}`;
    case 'too_big':
      if (i.type === 'string') return `ยาวเกิน ${i.maximum} ตัวอักษร`;
      return i.inclusive === false ? `ต้องน้อยกว่า ${i.maximum}` : `ต้องไม่เกิน ${i.maximum}`;
    case 'invalid_string': return i.validation === 'email' ? 'อีเมลไม่ถูกต้อง' : 'รูปแบบไม่ถูกต้อง';
    case 'invalid_enum_value': case 'invalid_literal': case 'invalid_union': return 'ค่าที่เลือกไม่ถูกต้อง';
    default: return i.message && /[\u0E00-\u0E7F]/.test(i.message) ? i.message : 'ข้อมูลไม่ถูกต้อง';
  }
}

/** Server reasons / details that point at one input, as [field key, Thai text]. */
const REASON_FIELD: Record<string, [string, string]> = {
  USERNAME_TAKEN: ['username', 'ชื่อผู้ใช้นี้มีแล้ว ใช้ชื่ออื่น'],
  CODE_TAKEN: ['code', 'รหัสนี้มีแล้ว ใช้รหัสอื่น'],
  BAD_PIN: ['pin', 'PIN ไม่ถูกต้อง'],
};
const FIELD_TEXT: Record<string, string> = {
  nationalId: 'เลขบัตรประชาชนต้องมี 13 หลักและเลขตรวจสอบถูกต้อง',
  taxId: 'เลขผู้เสียภาษีไม่ถูกต้อง (ต้องมี 13 หลัก)',
};
/** Unique-constraint names → the input that holds the value (apps/server tables). */
const CONSTRAINT_FIELD: [RegExp, string][] = [[/sku/, 'sku'], [/barcode/, 'barcode'], [/username/, 'username'], [/tax_?id/, 'taxId'], [/_code/, 'code'], [/(^|_)no(_|$)/, 'no']];

interface Row { label?: string; text: string }
interface Mapped { matched: number; rows: Row[] }

/** Marks inputs for the failure. `rows` are the problems that found no input (they go into the dialog). */
export function applyFieldErrors(f: ApiFail, scope: ParentNode = topScope()): Mapped {
  const rows: Row[] = [];
  let first: HTMLElement | null = null;
  let matched = 0;
  const put = (el: HTMLElement | null, text: string, fallbackLabel: string): void => {
    if (el) {
      markInvalid(el, text);
      first ??= el;
      matched++;
    } else rows.push({ label: fallbackLabel, text });
  };
  clearAllInvalid(scope);
  for (const i of issuesOf(f)) {
    const el = findField(scope, i.path);
    const key = String(i.path[i.path.length - 1] ?? '');
    put(el, issueText(i), el ? fieldLabel(el, key) : i.path.filter((p) => typeof p === 'string').join(' › ') || 'ข้อมูล');
  }
  const d = f.details && typeof f.details === 'object' && !Array.isArray(f.details) ? (f.details as Record<string, unknown>) : null;
  if (d && !issuesOf(f).length) {
    if (typeof d.field === 'string') put(findField(scope, d.field), FIELD_TEXT[d.field] ?? f.message, d.field);
    else if (typeof d.reason === 'string' && REASON_FIELD[d.reason]) {
      const [key, text] = REASON_FIELD[d.reason]!;
      const el = findField(scope, key);
      if (el) put(el, text, key);
    } else if (typeof d.approvalError === 'string' && d.approvalError === 'BAD_PIN') {
      const el = findField(scope, 'pin');
      if (el) put(el, 'PIN ไม่ถูกต้อง', 'PIN');
    } else if (typeof d.lineId === 'string') {
      const cap = d.max ?? d.remaining;
      const el = scope.querySelector<HTMLElement>(`[data-line="${attr(d.lineId)}"]`);
      if (el) put(controlOf(el), cap != null ? `จำนวนเกินที่ทำได้ (สูงสุด ${fq(String(cap))})` : f.message, 'จำนวน');
    } else if (typeof d.invoiceNo === 'string') {
      const el = scope.querySelector<HTMLElement>(`[data-invoice="${attr(d.invoiceNo)}"]`);
      if (el) put(controlOf(el), d.arBalance != null ? `เกินยอดค้างชำระ (ค้าง ${fq(String(d.arBalance))})` : f.message, 'ยอดรับ');
    } else if (typeof d.constraint === 'string') {
      const hit = CONSTRAINT_FIELD.find(([re]) => re.test(d.constraint as string));
      const el = hit ? findField(scope, hit[1]) : null;
      if (el) put(el, 'ค่านี้มีอยู่แล้ว ใช้ค่าอื่น', hit![1]);
    }
  }
  if (first) focusField(first);
  return { matched, rows };
}

// ---------- describing a failure ----------
interface Shortage { productId: string; warehouseId: string; need: string; have: string }
export interface ErrDesc { title: string; message: string; rows: Row[]; shortages?: Shortage[]; code?: string; status?: number; requestId?: string; where?: string }

const TITLE: Partial<Record<ApiFail['code'], string>> = {
  INSUFFICIENT_STOCK: 'สต็อกไม่พอ',
  BELOW_COST: 'ขายต่ำกว่าทุน ต้องให้เจ้าของอนุมัติ',
  SHIFT_REQUIRED: 'ต้องเปิดกะก่อน',
  FORBIDDEN: 'ไม่มีสิทธิ์',
  UNAUTHORIZED: 'ต้องเข้าสู่ระบบใหม่',
  VALIDATION: 'ข้อมูลไม่ครบหรือไม่ถูกต้อง',
  INTERNAL: 'ระบบขัดข้อง',
  NETWORK: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้',
  DOWNSTREAM_FIRST: 'ต้องจัดการเอกสารที่อ้างอิงก่อน',
  NOT_AVAILABLE_IN_EDITION: 'ฟีเจอร์นี้ใช้ไม่ได้',
};

export function describeError(f: ApiFail, unmatched?: Row[]): ErrDesc {
  const rows: Row[] = [];
  let shortages: Shortage[] | undefined;
  let message = f.message;
  const d = f.details && typeof f.details === 'object' && !Array.isArray(f.details) ? (f.details as Record<string, unknown>) : {};
  if (f.code === 'INSUFFICIENT_STOCK' && Array.isArray(f.details) && (f.details as Shortage[])[0]?.productId) shortages = f.details as Shortage[];
  if (f.code === 'VALIDATION' || f.code === 'CONFLICT') {
    const issues = issuesOf(f);
    if (f.code === 'VALIDATION' && issues.length) {
      message = 'ตรวจสอบช่องต่อไปนี้แล้วลองอีกครั้ง';
      rows.push(...(unmatched ?? issues.map((i) => ({ label: i.path.filter((p) => typeof p === 'string').join(' › ') || 'ข้อมูล', text: issueText(i) }))));
    } else {
      const plain = f.message === `${baseMessage(f.code)} (${f.serverMessage})`; // no module-specific Thai reason
      message = plain ? baseMessage(f.code) : f.message;
      if (plain && f.serverMessage) rows.push({ label: 'รายละเอียดจากระบบ', text: f.serverMessage });
    }
  } else if (unmatched?.length) rows.push(...unmatched);
  const cap = d.max ?? d.remaining;
  if (cap != null && typeof d.lineId === 'string') rows.push({ label: 'จำนวนสูงสุดที่ทำได้', text: fq(String(cap)) });
  if (Array.isArray(d.docs) && d.docs.length) rows.push({ label: 'เอกสารที่อ้างอิง', text: d.docs.join(', ') });
  if (f.code === 'BELOW_COST' && Array.isArray(d.lines)) rows.push({ label: 'รายการที่ต่ำกว่าทุน', text: String(d.lines.length) });
  return { title: TITLE[f.code] ?? 'ทำรายการไม่สำเร็จ', message, rows, shortages, code: f.code, status: f.status || undefined, requestId: f.requestId, where: f.path ? `${f.method} ${f.path}` : undefined };
}

// ---------- the dialog ----------
let openDialog: ((d: ErrDesc) => void) | null = null;
/** Opens the error dialog from code (client-side problems that have no field on screen). */
export function showError(d: Partial<ErrDesc> & { message: string }): void {
  openDialog?.({ title: d.title ?? 'ทำรายการไม่สำเร็จ', rows: [], ...d });
}

function ShortageTable({ list }: { list: Shortage[] }) {
  const cat = useCatalog();
  const whs = useAllWarehouses();
  const pName = (id: string) => cat.byId.get(id)?.name ?? id;
  const pUnit = (id: string) => cat.byId.get(id)?.units[0]?.name ?? '';
  const wName = (id: string) => whs.data?.find((w) => w.id === id)?.name ?? id;
  return (
    <div className="tw">
      <table data-testid="err-shortage">
        <thead><tr><th>สินค้า</th><th>คลัง</th><th className="n">ต้องใช้</th><th className="n">คงเหลือ</th></tr></thead>
        <tbody>
          {list.map((s) => (
            <tr key={s.productId + s.warehouseId}>
              <td>{pName(s.productId)}</td><td>{wName(s.warehouseId)}</td>
              <td className="n">{fq(s.need)} {pUnit(s.productId)}</td><td className="n" style={{ color: 'var(--bad)' }}>{fq(s.have)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const ErrIcon = ({ size = 22 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9.5" /><path d="M15 9l-6 6M9 9l6 6" />
  </svg>
);

const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

export function ErrorDialog({ err, onClose }: { err: ErrDesc; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ok.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation(); // the modal underneath must stay open
        onClose();
      } else if (e.key === 'Tab' && root.current) {
        const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => !x.hasAttribute('disabled'));
        if (!items.length) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const at = document.activeElement;
        if (!root.current.contains(at)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [onClose]);
  const generic = err.title !== 'ทำรายการไม่สำเร็จ';
  return createPortal(
    <div className="ex-ov" onMouseDown={(e) => { if (e.target === e.currentTarget) ok.current?.focus(); }}>
      <div ref={root} className="ex-dlg" role="alertdialog" aria-modal="true" aria-labelledby="ex-title" aria-describedby="ex-msg" data-testid="error-dialog">
        <div className="ex-head" data-testid="error-dialog-head">
          <ErrIcon />
          <h2 id="ex-title">ทำรายการไม่สำเร็จ</h2>
        </div>
        <div className="ex-body">
          {generic && <h3 className="ex-sub" data-testid="error-dialog-title">{err.title}</h3>}
          <p id="ex-msg" className="ex-msg" data-testid="error-dialog-message">{err.message}</p>
          {err.shortages && <ShortageTable list={err.shortages} />}
          {err.rows.length > 0 && (
            <ul className="ex-rows" data-testid="error-dialog-rows">
              {err.rows.map((r, i) => <li key={i}>{r.label && <b>{r.label}: </b>}{r.text}</li>)}
            </ul>
          )}
          <div className="ex-meta small muted" data-testid="error-dialog-code">
            รหัส: {err.code}{err.status ? ` · HTTP ${err.status}` : ''}{err.requestId ? ` · อ้างอิง ${err.requestId}` : ''}{err.where ? ` · ${err.where}` : ''}
          </div>
        </div>
        <div className="ex-act"><button ref={ok} className="btn pri" onClick={onClose} data-testid="error-dialog-ok" data-busy="off">ตกลง</button></div>
      </div>
    </div>,
    document.body,
  );
}

/** Mount once, inside the QueryClientProvider. */
export function ErrorHost({ children }: { children: ReactNode }) {
  const [err, setErr] = useState<ErrDesc | null>(null);
  useEffect(() => {
    openDialog = setErr;
    setFailListener(({ fail }: FailReport) => {
      // a beat later: the screen may swap a modal for the form in response to the failure, and the fields must be there
      setTimeout(() => {
        const m = applyFieldErrors(fail);
        if (m.matched > 0 && m.rows.length === 0) return; // every problem is marked on its field
        setErr(describeError(fail, m.matched > 0 ? m.rows : undefined));
      }, 60);
    });
    // editing a red field clears its mark
    const clear = (e: Event) => { if (e.target instanceof Element) clearInvalid(e.target); };
    document.addEventListener('input', clear, true);
    document.addEventListener('change', clear, true);
    return () => {
      openDialog = null;
      setFailListener(null);
      document.removeEventListener('input', clear, true);
      document.removeEventListener('change', clear, true);
    };
  }, []);
  return <>{children}{err && <ErrorDialog err={err} onClose={() => setErr(null)} />}</>;
}

// ---------- failed loads (GET) ----------
const claimedErrors = new WeakSet<object>();

/** Red inline banner for a failed list / detail load, with a retry button. */
export function ErrorBanner({ error, onRetry, retrying, title = 'โหลดข้อมูลไม่สำเร็จ', failbar }: { error: unknown; onRetry?: () => void; retrying?: boolean; title?: string; failbar?: boolean }) {
  if (!error) return null;
  if (typeof error === 'object') claimedErrors.add(error);
  const text = error instanceof Error ? error.message : String(error);
  const code = error instanceof ApiFail ? error.code : undefined;
  return (
    <div className="errbar" role="alert" data-testid="error-banner" data-failbar={failbar ? '' : undefined}>
      <ErrIcon size={20} />
      <div className="errbar-t"><b>{title}</b><span>{text}</span>{code && <small className="muted">รหัส: {code}{error instanceof ApiFail && error.requestId ? ` · อ้างอิง ${error.requestId}` : ''}</small>}</div>
      {onRetry && <button className="btn sm" onClick={onRetry} disabled={retrying} data-testid="error-retry" data-busy="off">{retrying ? 'กำลังโหลด…' : 'ลองใหม่'}</button>}
    </div>
  );
}

/**
 * Safety net at the top of the content area: any active query that failed and is not shown by an ErrorBanner on its
 * own screen still gets a red banner with retry, so a failed load is never a silently empty table.
 */
export function QueryFailBar() {
  const qc = useQueryClient();
  const fetching = useIsFetching();
  const [failed, setFailed] = useState<Query[]>([]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const scan = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        // a screen that shows its own banner already tells the user; this one is only for failures nobody shows
        const shown = !!document.querySelector('[data-testid="error-banner"]:not([data-failbar])');
        const list = shown ? [] : qc.getQueryCache().getAll().filter((q) => q.state.status === 'error' && q.getObserversCount() > 0 && q.state.fetchStatus !== 'fetching'
          && !(q.state.error && typeof q.state.error === 'object' && claimedErrors.has(q.state.error)));
        setFailed((prev) => (prev.length === list.length && prev.every((q, i) => q === list[i]) ? prev : list));
      }, 400);
    };
    scan();
    const un = qc.getQueryCache().subscribe(scan);
    return () => { clearTimeout(t); un(); };
  }, [qc]);
  if (!failed.length) return null;
  const first = failed[0]!.state.error;
  return (
    <div className="card" style={{ padding: 0, border: 0, background: 'none' }}>
      <ErrorBanner failbar error={first} retrying={fetching > 0} onRetry={() => { void qc.refetchQueries({ predicate: (q) => failed.includes(q) }); }} />
    </div>
  );
}
