/** On-screen keyboard: Thai Kedmanee and English QWERTY with shift, a symbols layer, space, backspace, enter. */
import { useMemo, useState } from 'react';
import { backspace, insertText, labelOf, pressEnter, type Field } from './fields';
import { EN, SYM, TH, storeLang, storedLang, type Lang } from './layouts';
import { HoldKey } from './HoldKey';

const MARK = /\p{Mn}/u; // Thai vowel/tone marks sit on a dotted circle so they are visible as keys

export function OnScreenKeyboard({ el, onClose, onNext }: { el: Field; onClose: () => void; onNext: () => void }) {
  const label = useMemo(() => labelOf(el), [el]);
  const latin = el instanceof HTMLInputElement && (el.type === 'email' || el.type === 'password' || el.type === 'url');
  const [lang, setLang] = useState<Lang>(latin ? 'en' : storedLang() ?? 'th');
  const [shift, setShift] = useState(false);
  const [sym, setSym] = useState(false);
  const multi = el instanceof HTMLTextAreaElement;

  const type = (ch: string) => { insertText(el, ch); setShift(false); };
  const toggleLang = () => { const n: Lang = lang === 'th' ? 'en' : 'th'; setLang(n); storeLang(n); setShift(false); };
  const enter = () => { if (pressEnter(el)) onClose(); };

  const layer = sym ? SYM : (lang === 'th' ? TH : EN)[shift ? 'shift' : 'base'];
  const rows = layer.rows.map((r) => Array.from(r));
  const last = rows.length - 1;
  const key = (ch: string) => (
    <button type="button" key={ch} className="tk-key kb" data-k={ch} aria-label={ch} onClick={() => type(ch)}>{MARK.test(ch) ? `◌${ch}` : ch}</button>
  );

  return (
    <div className="tk-sheet tk-kb" data-tk-sheet="text" role="group" aria-label="แป้นพิมพ์บนหน้าจอ" data-testid="osk">
      <div className="tk-head">
        <div className="tk-lbl"><span>{label || 'พิมพ์ข้อความ'}</span></div>
        <button type="button" className="tk-mini" onClick={onNext} aria-label="ช่องถัดไป">ถัดไป ›</button>
        <button type="button" className="tk-mini" onClick={onClose} aria-label="ซ่อนแป้นพิมพ์" data-testid="osk-hide">ซ่อน ▾</button>
      </div>
      {rows.map((r, i) => (
        <div className="tk-row" key={`${sym}${lang}${shift}${i}`}>
          {i === last && !sym && (
            <button type="button" className={`tk-key kb fn wide${shift ? ' on' : ''}`} aria-pressed={shift} aria-label="ตัวอักษรอีกชุด (Shift)" onClick={() => setShift((s) => !s)}>⇧</button>
          )}
          {r.map(key)}
          {i === last && (
            <HoldKey className="tk-key kb fn wide" aria-label="ลบหนึ่งตัว" onFire={() => backspace(el)}>⌫</HoldKey>
          )}
        </div>
      ))}
      <div className="tk-row">
        <button type="button" className="tk-key kb fn wide" aria-label={sym ? 'กลับไปตัวอักษร' : 'ตัวเลขและสัญลักษณ์'} onClick={() => { setSym((s) => !s); setShift(false); }}>{sym ? (lang === 'th' ? 'กขค' : 'ABC') : '123'}</button>
        <button type="button" className="tk-key kb fn wide" aria-label={`สลับภาษา ตอนนี้${lang === 'th' ? 'ไทย' : 'อังกฤษ'}`} onClick={toggleLang} data-testid="osk-lang">
          <span className={lang === 'th' ? 'cur' : ''}>ไทย</span>/<span className={lang === 'en' ? 'cur' : ''}>ENG</span>
        </button>
        <button type="button" className="tk-key kb space" aria-label="เว้นวรรค" data-k=" " onClick={() => type(' ')}>เว้นวรรค</button>
        <button type="button" className="tk-key kb" aria-label="จุด" data-k="." onClick={() => type('.')}>.</button>
        <button type="button" className="tk-key kb pri wide" aria-label={multi ? 'ขึ้นบรรทัดใหม่' : 'ตกลง'} data-testid="osk-enter" onClick={enter}>{multi ? '↵' : 'ตกลง'}</button>
      </div>
    </div>
  );
}
