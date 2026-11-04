/** DOM helpers shared by the on-screen number pad and keyboard: which fields qualify, writing values React notices, caret edits. */

export type Field = HTMLInputElement | HTMLTextAreaElement;
export type FieldKind = 'num' | 'text';

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'color', 'range', 'date', 'datetime-local', 'month', 'week', 'time', 'hidden']);

/** inputmode as the screen wrote it: while a sheet is open the live attribute is "none". */
const origMode = new Map<HTMLElement, string | null>();
export const inputModeOf = (el: HTMLElement) => (origMode.has(el) ? origMode.get(el) : el.getAttribute('inputmode')) ?? '';

/** Which on-screen sheet (if any) a focused element wants. data-kbd="off" opts out, "num" / "text" force a sheet. */
export function fieldKind(t: EventTarget | null): FieldKind | null {
  if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return null;
  if (t.readOnly || t.disabled) return null;
  const k = t.dataset.kbd;
  if (k === 'off') return null;
  if (k === 'num' || k === 'text') return k;
  if (t instanceof HTMLTextAreaElement) return 'text';
  if (NOT_TEXT.has(t.type)) return null;
  if (t.type === 'number' || t.type === 'tel') return 'num';
  const im = inputModeOf(t);
  return im === 'numeric' || im === 'decimal' ? 'num' : 'text';
}

/** The field a pointer-down means: the input itself, or the control of the label that was tapped. */
export function fieldAt(t: EventTarget | null): Field | null {
  if (!(t instanceof Element)) return null;
  const el = t.closest('input,textarea,label');
  const f = el instanceof HTMLLabelElement ? el.control : el;
  return f && fieldKind(f) ? (f as Field) : null;
}

/** Hide the OS keyboard while our sheet is up (restored by restoreMode / restoreAllModes). */
export function suppressNativeKeyboard(el: HTMLElement) {
  if (!origMode.has(el)) origMode.set(el, el.getAttribute('inputmode'));
  el.setAttribute('inputmode', 'none');
}
export function restoreMode(el: HTMLElement) {
  if (!origMode.has(el)) return;
  const v = origMode.get(el);
  origMode.delete(el);
  if (v == null) el.removeAttribute('inputmode');
  else el.setAttribute('inputmode', v);
}
export function restoreAllModes(except?: HTMLElement | null) {
  for (const el of [...origMode.keys()]) if (el !== except) restoreMode(el);
}

/**
 * Writes through the prototype setter (React tracks the instance value, so a plain `el.value =` would be swallowed)
 * and fires a bubbling input event so controlled onChange handlers run.
 */
export function setValue(el: Field, v: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
export const fireChange = (el: Field) => el.dispatchEvent(new Event('change', { bubbles: true }));

/** Readable name of a field for the sheet header. */
export function labelOf(el: Field): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const lab = el.labels?.[0];
  if (lab) {
    const c = lab.cloneNode(true) as HTMLElement;
    c.querySelectorAll('input,select,textarea,option,button').forEach((n) => n.remove());
    const t = c.textContent?.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return el.placeholder || el.name || '';
}

function selection(el: Field): [number, number] {
  const n = el.value.length;
  try {
    if (el.selectionStart != null) return [el.selectionStart, el.selectionEnd ?? el.selectionStart];
  } catch {
    /* number / email inputs have no caret: edit at the end */
  }
  return [n, n];
}

/** Inserts text at the caret (replacing a selection), honouring maxLength. */
export function insertText(el: Field, text: string) {
  const [s, e] = selection(el);
  const v = el.value;
  const room = el.maxLength > 0 ? el.maxLength - (v.length - (e - s)) : Infinity;
  const t = text.slice(0, Math.max(0, room));
  if (!t && text) return;
  setValue(el, v.slice(0, s) + t + v.slice(e));
  caretTo(el, s + t.length);
}

export function backspace(el: Field) {
  const [s, e] = selection(el);
  const v = el.value;
  if (s !== e) {
    setValue(el, v.slice(0, s) + v.slice(e));
    caretTo(el, s);
  } else if (s > 0) {
    const from = s >= 2 && /[\uDC00-\uDFFF]/.test(v[s - 1]!) ? s - 2 : s - 1;
    setValue(el, v.slice(0, from) + v.slice(s));
    caretTo(el, from);
  }
}

function caretTo(el: Field, at: number) {
  try {
    el.setSelectionRange(at, at);
  } catch {
    /* no caret on this input type */
  }
}

/** Enter as a key press: handlers see keydown/keyup like a hardware key; textareas get a newline, forms submit. Returns true when the sheet should close. */
export function pressEnter(el: Field): boolean {
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true } as KeyboardEventInit;
  const down = new KeyboardEvent('keydown', init);
  el.dispatchEvent(down);
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  if (down.defaultPrevented) return false;
  if (el instanceof HTMLTextAreaElement) {
    insertText(el, '\n');
    return false;
  }
  el.form?.requestSubmit();
  return true;
}

/** Next visible, enabled form control after `el` in document order. */
export function nextControl(el: Field): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>('input,textarea,select')].filter((n) => {
    const x = n as HTMLInputElement;
    return !x.disabled && x.type !== 'hidden' && n.tabIndex >= 0 && n.getClientRects().length > 0;
  });
  return all[all.indexOf(el) + 1] ?? null;
}
