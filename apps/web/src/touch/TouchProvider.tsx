/**
 * Touch mode for the whole app: context + <html data-touch>, the global focus listeners that open the on-screen number pad
 * (numeric fields) or keyboard (text fields), the automatic busy buttons and the top progress bar. Screens need no wiring.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getInflight, subscribeInflight } from '../api';
import { installBusyButtons } from './busy';
import { fieldAt, fieldKind, nextControl, restoreAllModes, restoreMode, suppressNativeKeyboard, type Field, type FieldKind } from './fields';
import { OnScreenKeyboard } from './Keyboard';
import { NumPad } from './NumPad';
import { applyTouchAttr, initialTouchMode, persistTouchMode } from './store';
import './touch.css';

interface TouchCtx { touchMode: boolean; setTouchMode: (on: boolean) => void }
const Ctx = createContext<TouchCtx>({ touchMode: false, setTouchMode: () => {} });
export const useTouch = () => useContext(Ctx);

applyTouchAttr(initialTouchMode()); // before first paint, so touch CSS never flashes in

export function TouchProvider({ children }: { children: ReactNode }) {
  const [touchMode, setMode] = useState(initialTouchMode);
  const setTouchMode = useCallback((on: boolean) => { setMode(on); persistTouchMode(on); }, []);
  useEffect(() => { applyTouchAttr(touchMode); }, [touchMode]);
  useEffect(() => installBusyButtons(), []);
  return (
    <Ctx.Provider value={{ touchMode, setTouchMode }}>
      {children}
      {touchMode && <TouchLayer />}
      <TopProgress />
    </Ctx.Provider>
  );
}

/** Header switch. */
export function TouchToggle() {
  const { touchMode, setTouchMode } = useTouch();
  return (
    <button type="button" className={`btn sm touch-toggle${touchMode ? ' on' : ''}`} aria-pressed={touchMode} onClick={() => setTouchMode(!touchMode)} data-testid="touch-toggle" data-busy="off">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 11V5a2 2 0 0 1 4 0v6" /><path d="M13 10a2 2 0 0 1 4 0v1a2 2 0 0 1 4 0v4a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-3l-3-5a2 2 0 0 1 3-2l2 2" /></svg>
      โหมดจอสัมผัส<span className="tt-state" aria-hidden="true">{touchMode ? 'เปิด' : 'ปิด'}</span>
    </button>
  );
}

// ---------- top progress bar ----------
function TopProgress() {
  const n = useSyncExternalStore(subscribeInflight, getInflight);
  const [show, setShow] = useState(false);
  const busy = n > 0;
  useEffect(() => {
    if (busy) {
      const t = setTimeout(() => setShow(true), 150); // quick requests never flash the bar
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setShow(false), 250);
    return () => clearTimeout(t);
  }, [busy]);
  if (!show) return null;
  return <div className="topbar" role="progressbar" aria-label="กำลังโหลดข้อมูล" data-testid="top-progress"><i /></div>;
}

// ---------- on-screen sheets ----------
interface Active { el: Field; kind: FieldKind; id: number }
let seq = 0;

function TouchLayer() {
  const [active, setActive] = useState<Active | null>(null);
  const ref = useRef<Active | null>(null);
  ref.current = active;

  const close = useCallback((blur = true) => {
    const a = ref.current;
    if (!a) return;
    ref.current = null;
    restoreMode(a.el);
    setActive(null);
    if (blur && document.activeElement === a.el) a.el.blur();
  }, []);
  const open = useCallback((el: Field, kind: FieldKind) => {
    if (ref.current?.el === el) return;
    if (ref.current) restoreMode(ref.current.el);
    suppressNativeKeyboard(el);
    const a = { el, kind, id: ++seq };
    ref.current = a;
    setActive(a);
  }, []);
  const next = useCallback(() => {
    const a = ref.current;
    if (!a) return;
    const n = nextControl(a.el);
    close(false);
    if (!n) return a.el.blur();
    n.focus();
    const k = fieldKind(n);
    if (k) open(n as Field, k);
  }, [close, open]);

  useEffect(() => {
    let down: { t: number; el: Field | null } = { t: 0, el: null };
    let key = 0;
    const inSheet = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-tk-sheet]');

    const onDown = (e: PointerEvent) => {
      if (inSheet(e.target)) return;
      const f = fieldAt(e.target);
      down = { t: Date.now(), el: f };
      if (f) { open(f, fieldKind(f)!); return; }
      restoreAllModes();
      close();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (inSheet(t)) return;
      const kind = fieldKind(t);
      if (!kind) { close(false); return; }
      const f = t as Field;
      const byPointer = down.el === f && Date.now() - down.t < 1500;
      const byKeys = Date.now() - key < 400; // Tab / Enter moving between fields
      const inDialog = !!f.closest('[role="dialog"]'); // a modal that autofocuses its field (PIN)
      if (byPointer || byKeys || inDialog) open(f, kind);
    };
    const onKey = (e: KeyboardEvent) => {
      key = Date.now();
      if (e.key === 'Escape' && ref.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    // The field can vanish while its sheet is up (modal closed after a successful save).
    const gone = setInterval(() => { const a = ref.current; if (a && !a.el.isConnected) close(false); }, 300);

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('keydown', onKey, true);
      clearInterval(gone);
      restoreAllModes();
    };
  }, [open, close]);

  return active ? createPortal(<Sheet key={active.id} active={active} onClose={() => close()} onNext={next} />, document.body) : null;
}

/** Wraps the pad / keyboard: keeps focus in the field, reserves room under the page, scrolls the field above the sheet. */
function Sheet({ active, onClose, onNext }: { active: Active; onClose: () => void; onNext: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const { el, kind } = active;

  useEffect(() => {
    const root = document.documentElement;
    const node = box.current?.firstElementChild as HTMLElement | null;
    if (!node) return;
    const fit = () => {
      root.style.setProperty('--sheet-h', `${node.offsetHeight}px`);
      root.dataset.sheet = 'open';
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // honours scroll-padding-bottom = sheet height
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(node);
    return () => {
      ro.disconnect();
      delete root.dataset.sheet;
      root.style.removeProperty('--sheet-h');
    };
  }, [el]);

  return (
    <div
      ref={box}
      style={{ display: 'contents' }}
      // Pressing a key must not move focus out of the field (keeps caret, selection and the OS keyboard hidden).
      onMouseDown={(e) => e.preventDefault()}
      onClickCapture={() => { if (document.activeElement !== el && el.isConnected) el.focus({ preventScroll: true }); }}
    >
      {kind === 'num' ? <NumPad el={el} onClose={onClose} onNext={onNext} /> : <OnScreenKeyboard el={el} onClose={onClose} onNext={onNext} />}
    </div>
  );
}
