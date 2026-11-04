/** Touch-mode setting: default from the primary pointer (coarse = finger), user choice persisted, mirrored on <html data-touch>. */
const KEY = 'erp-touch-mode';

function stored(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'on' ? true : v === 'off' ? false : null;
  } catch {
    return null;
  }
}

export function initialTouchMode(): boolean {
  const s = stored();
  if (s !== null) return s;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export function persistTouchMode(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* private mode: the choice lasts until reload */
  }
}

export function applyTouchAttr(on: boolean) {
  document.documentElement.dataset.touch = on ? 'on' : 'off';
}
