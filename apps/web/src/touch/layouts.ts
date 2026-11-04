/** Key layers. Thai is Kedmanee (the standard Thai layout); each row is a string of keys, one key per code point. */
export type Lang = 'th' | 'en';
export interface Layer { rows: string[] }

export const TH: { base: Layer; shift: Layer } = {
  base: { rows: ['ๅ/-ภถุึคตจขช', 'ๆไำพะัีรนยบล', 'ฟหกดเ้่าสวง', 'ผปแอิืทมใฝ'] },
  shift: { rows: ['+๑๒๓๔ู฿๕๖๗๘๙', '๐"ฎฑธํ๊ณฯญฐ,', 'ฤฆฏโฌ็๋ษศซ.', '()ฉฮฺ์?ฒฬฦ'] },
};
export const EN: { base: Layer; shift: Layer } = {
  base: { rows: ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'] },
  shift: { rows: ['!@#$%^&*()', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'] },
};
export const SYM: Layer = { rows: ['1234567890', '-/:;()฿&@"', '.,?!\'_%+=*', '#<>[]{}~^|'] };

const KEY = 'erp-kbd-lang';
export function storedLang(): Lang | null {
  try { const v = localStorage.getItem(KEY); return v === 'th' || v === 'en' ? v : null; } catch { return null; }
}
export function storeLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
}
