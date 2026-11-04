/** On-screen number pad: edits the focused numeric field through a string buffer, clamps to min/max/step on "ตกลง". */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fireChange, inputModeOf, labelOf, setValue, type Field } from './fields';
import { HoldKey } from './HoldKey';

interface Rules { min: number; max: number; stepDp: number | null; negative: boolean; decimal: boolean; maxLen: number; secret: boolean }

function rulesOf(el: Field): Rules {
  const min = parseFloat(el.getAttribute('min') ?? '');
  const max = parseFloat(el.getAttribute('max') ?? '');
  const step = el.getAttribute('step') ?? '';
  const im = inputModeOf(el);
  const integerStep = el.type === 'number' && /^\d+$/.test(step);
  const stepNum = Number(step);
  return {
    min, max,
    stepDp: step && step !== 'any' && Number.isFinite(stepNum) && stepNum > 0 ? (step.split('.')[1]?.length ?? 0) : null,
    negative: el.dataset.allowNegative !== undefined || min < 0,
    decimal: im !== 'numeric' && el.type !== 'tel' && !integerStep,
    maxLen: el instanceof HTMLInputElement && el.type !== 'number' && el.maxLength > 0 ? el.maxLength : Infinity,
    secret: el instanceof HTMLInputElement && el.type === 'password',
  };
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** What the input gets while typing: "5." and "-" are not valid numbers for type=number, so they wait for the next digit. */
function pushable(buf: string, el: Field): string {
  if (el.type !== 'number') return buf;
  if (NUMBER.test(buf)) return buf;
  if (/^-?\d+\.$/.test(buf)) return buf.slice(0, -1);
  return '';
}

function clampTo(buf: string, r: Rules): string {
  const t = buf.replace(/\.$/, '');
  if (!NUMBER.test(t)) return t === '-' ? '' : t;
  let n = Number(t);
  if (Number.isFinite(r.min) && n < r.min) n = r.min;
  if (Number.isFinite(r.max) && n > r.max) n = r.max;
  if (r.stepDp !== null) n = Number(n.toFixed(r.stepDp));
  return n === Number(t) ? t : String(n);
}

export function NumPad({ el, onClose, onNext }: { el: Field; onClose: () => void; onNext: () => void }) {
  const r = useMemo(() => rulesOf(el), [el]);
  const label = useMemo(() => labelOf(el), [el]);
  const [buf, setBuf] = useState(el.value);
  const fresh = useRef(true); // first key replaces the existing value
  const own = useRef(false);
  const cur = useRef(buf);
  cur.current = buf;

  useEffect(() => {
    const sync = () => { if (!own.current) { setBuf(el.value); fresh.current = false; } };
    el.addEventListener('input', sync);
    return () => el.removeEventListener('input', sync);
  }, [el]);

  const write = (next: string) => {
    if (next.replace('-', '').length > r.maxLen) return;
    fresh.current = false;
    setBuf(next);
    own.current = true;
    try { setValue(el, pushable(next, el)); } finally { own.current = false; }
    if (el.type !== 'number') requestAnimationFrame(() => { if (el.value !== next) setBuf(el.value); });
  };
  const base = () => (fresh.current ? '' : cur.current);

  const digit = (d: string) => { const b = base(); write(b === '0' || b === '-0' ? b.replace('0', '') + d : b + d); };
  const zeros = () => { const b = base(); if (b !== '' && b !== '-' && b !== '0' && b !== '-0') write(b + '00'); else if (b === '') write('0'); };
  const dot = () => { if (!r.decimal) return; const b = base(); if (!b.includes('.')) write(b === '' ? '0.' : b === '-' ? '-0.' : b + '.'); };
  const back = () => write(fresh.current ? '' : cur.current.slice(0, -1));
  const sign = () => { const b = cur.current; write(b.startsWith('-') ? b.slice(1) : '-' + b); fresh.current = false; };
  /** Clamp to min/max/step, write, and fire change. */
  const commit = () => {
    const v = clampTo(cur.current, r);
    if (v !== el.value) { own.current = true; try { setValue(el, v); } finally { own.current = false; } }
    fireChange(el);
  };
  const confirm = () => { commit(); onClose(); };

  const shown = r.secret ? '•'.repeat(buf.length) : buf;
  const range = Number.isFinite(r.min) || Number.isFinite(r.max) ? `${Number.isFinite(r.min) ? r.min : ''} – ${Number.isFinite(r.max) ? r.max : ''}` : '';
  const K = (txt: string, fn: () => void, extra = '', aria?: string, dis = false) => (
    <button type="button" className={`tk-key ${extra}`} onClick={fn} disabled={dis} aria-label={aria}>{txt}</button>
  );

  return (
    <div className="tk-sheet tk-num" data-tk-sheet="num" role="group" aria-label="แป้นตัวเลขบนหน้าจอ" data-testid="numpad">
      <div className="tk-head">
        <div className="tk-lbl"><span>{label || 'ตัวเลข'}</span>{range && <small>ช่วง {range}</small>}</div>
        <button type="button" className="tk-mini" onClick={() => { commit(); onNext(); }} aria-label="ช่องถัดไป">ถัดไป ›</button>
        <button type="button" className="tk-mini" onClick={onClose} aria-label="ซ่อนแป้นตัวเลข">ซ่อน ▾</button>
      </div>
      <div className="tk-disp">
        <output className={`tk-val${fresh.current && buf ? ' fresh' : ''}`} data-testid="numpad-value" aria-live="polite">{shown || <span className="tk-ph">{el.placeholder || '0'}</span>}</output>
        {r.negative && <button type="button" className="tk-mini sq" onClick={sign} aria-label="สลับบวกลบ">±</button>}
      </div>
      <div className="tk-grid">
        {['7', '8', '9'].map((k) => K(k, () => digit(k), '', undefined))}
        <HoldKey className="tk-key fn" onFire={back} aria-label="ลบหนึ่งตัว">⌫</HoldKey>
        {['4', '5', '6'].map((k) => K(k, () => digit(k)))}
        {K('ล้าง', () => write(''), 'fn sm', 'ล้างค่า')}
        {['1', '2', '3'].map((k) => K(k, () => digit(k)))}
        <button type="button" className="tk-key pri ok" onClick={confirm} data-testid="numpad-ok" aria-label="ตกลง">ตกลง</button>
        {K('0', () => digit('0'))}
        {K('.', dot, '', 'จุดทศนิยม', !r.decimal)}
        {K('00', zeros)}
      </div>
    </div>
  );
}
