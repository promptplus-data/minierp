/**
 * Automatic busy state for buttons. A click is remembered for a short window; a non-GET request that starts inside
 * the window (api.ts reports it through setMutationTracker) marks that button aria-busy + disabled until every request
 * it caused has settled. Opt out per button with data-busy="off". Styling is pure CSS (spinner is a pseudo-element), so
 * React-managed children are never touched.
 */
import { setMutationTracker } from '../api';

const CLICK_WINDOW_MS = 350;
const GRACE_MS = 120;
const SEL = 'button,[role="button"],input[type="submit"],input[type="button"]';

interface Rec { btn: HTMLElement; pending: number; wasDisabled: boolean; reactOwned: boolean; mo: MutationObserver }
const recs = new Map<HTMLElement, Rec>();
let last: { btn: HTMLElement; t: number } | null = null;

const isNative = (b: HTMLElement): b is HTMLButtonElement | HTMLInputElement => b instanceof HTMLButtonElement || b instanceof HTMLInputElement;

function begin(btn: HTMLElement): Rec {
  const wasDisabled = isNative(btn) ? btn.disabled : false;
  const rec: Rec = { btn, pending: 0, wasDisabled, reactOwned: false, mo: new MutationObserver(() => { rec.reactOwned = true; }) };
  btn.setAttribute('aria-busy', 'true');
  if (isNative(btn)) btn.disabled = true;
  // From here on, any change of `disabled` is React's (our own writes happen before observe() and after disconnect()).
  rec.mo.observe(btn, { attributes: true, attributeFilter: ['disabled'] });
  recs.set(btn, rec);
  return rec;
}

function finish(rec: Rec) {
  if (rec.pending > 0) return;
  rec.mo.disconnect();
  rec.btn.removeAttribute('aria-busy');
  if (isNative(rec.btn) && !rec.reactOwned && !rec.wasDisabled) rec.btn.disabled = false;
  recs.delete(rec.btn);
}

function track(settled: Promise<void>) {
  const now = performance.now();
  let rec: Rec | undefined;
  if (last && now - last.t < CLICK_WINDOW_MS && last.btn.isConnected) rec = recs.get(last.btn) ?? begin(last.btn);
  else rec = [...recs.values()].find((r) => r.btn.isConnected); // a chained request of a button that is still busy
  if (!rec) return;
  const r = rec;
  r.pending++;
  void settled.then(() => {
    r.pending--;
    setTimeout(() => finish(r), GRACE_MS);
  });
}

export function installBusyButtons(): () => void {
  const onClick = (e: MouseEvent) => {
    const btn = e.target instanceof Element ? (e.target.closest(SEL) as HTMLElement | null) : null;
    if (!btn || btn.dataset.busy === 'off' || (isNative(btn) && btn.disabled)) {
      last = null;
      return;
    }
    if (btn.getAttribute('aria-busy') === 'true') {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    last = { btn, t: performance.now() };
  };
  document.addEventListener('click', onClick, true);
  setMutationTracker(track);
  return () => {
    document.removeEventListener('click', onClick, true);
    setMutationTracker(null);
  };
}
