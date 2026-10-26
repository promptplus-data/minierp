/** Product illustrations from the mockup (IMG), picked by category / SKU since products carry no photo yet. */
import type { Product } from '@erp/contracts';

const IMG: Record<string, string> = {
 bag:'<rect x="38" y="12" width="44" height="58" rx="6" fill="#c9a46a"/><rect x="38" y="12" width="44" height="9" rx="3" fill="#a9844c"/><rect x="46" y="32" width="28" height="18" rx="2" fill="#f3e7cf"/><rect x="50" y="37" width="20" height="3" fill="#a9844c"/><rect x="50" y="43" width="14" height="3" fill="#a9844c"/>',
 bag2:'<rect x="38" y="12" width="44" height="58" rx="6" fill="#e4dfd2"/><rect x="38" y="40" width="44" height="12" fill="#3f7cc4"/><rect x="38" y="12" width="44" height="8" rx="3" fill="#c9c2b1"/><rect x="48" y="26" width="24" height="6" rx="2" fill="#9a927f"/>',
 roof:'<polygon points="18,62 92,62 104,22 30,22" fill="#8f99a3"/>'+[0,1,2,3,4,5,6].map(i=>`<line x1="${28+i*10}" y1="62" x2="${40+i*10}" y2="22" stroke="#6f7983" stroke-width="3"/>`).join(''),
 block:'<rect x="22" y="44" width="38" height="20" fill="#dcd8cf" stroke="#b5b0a4"/><rect x="62" y="44" width="38" height="20" fill="#e6e2da" stroke="#b5b0a4"/><rect x="42" y="22" width="38" height="20" fill="#e9e5dd" stroke="#b5b0a4"/>',
 rebar:[0,1,2,3,4].map(i=>`<line x1="18" y1="${58-i*7}" x2="102" y2="${30-i*3}" stroke="#7a5638" stroke-width="4" stroke-linecap="round"/>`).join(''),
 pipe:[0,1,2].map(i=>`<rect x="14" y="${18+i*16}" width="88" height="12" rx="6" fill="#3a76c2"/><ellipse cx="102" cy="${24+i*16}" rx="4" ry="6" fill="#255a9c"/>`).join(''),
 paint:'<path d="M40 24 h40 l-4 44 h-32 z" fill="#f4f4f2" stroke="#b9bcc0" stroke-width="2"/><rect x="42" y="36" width="36" height="14" fill="#d5664a"/><path d="M42 24 q18 -14 36 0" fill="none" stroke="#8b9096" stroke-width="2"/>',
 sand:'<path d="M14 66 q46 -60 92 0 z" fill="#d8b780"/><circle cx="48" cy="52" r="1.6" fill="#b8955c"/><circle cx="62" cy="44" r="1.6" fill="#b8955c"/><circle cx="72" cy="56" r="1.6" fill="#b8955c"/>',
 truck:'<rect x="14" y="26" width="54" height="30" rx="3" fill="#e4a33a"/><path d="M68 34 h18 l12 12 v10 h-30 z" fill="#c9852a"/><rect x="74" y="37" width="12" height="8" fill="#f6e3bf"/><circle cx="32" cy="60" r="7" fill="#444"/><circle cx="84" cy="60" r="7" fill="#444"/>',
 post:'<rect x="14" y="30" width="92" height="18" rx="2" fill="#b9b6ae" stroke="#8f8b82"/><rect x="18" y="50" width="88" height="16" rx="2" fill="#c9c6be" stroke="#8f8b82"/><circle cx="24" cy="39" r="2" fill="#7a5638"/><circle cx="24" cy="58" r="2" fill="#7a5638"/>',
 ring:'<ellipse cx="60" cy="28" rx="40" ry="12" fill="#c9c6be" stroke="#8f8b82"/><path d="M20 28v26c0 7 18 12 40 12s40-5 40-12V28" fill="#b9b6ae" stroke="#8f8b82"/><ellipse cx="60" cy="28" rx="30" ry="8" fill="#8f8b82"/>',
 box:'<path d="M30 30 l30 -12 l30 12 v30 l-30 12 l-30 -12 z" fill="#d9c8a6" stroke="#b49f78"/><path d="M30 30 l30 12 l30 -12 M60 42 v30" fill="none" stroke="#b49f78"/>'
};

function pick(p: Product): string {
  const c = p.category;
  if (p.kind === 'service') return 'truck';
  if (/ปูน/.test(c)) return 'bag';
  if (/กาว|ยาแนว/.test(c)) return 'bag2';
  if (/หลังคา/.test(c)) return 'roof';
  if (/ผนัง|อิฐ/.test(c)) return 'block';
  if (/เหล็ก/.test(c)) return 'rebar';
  if (/ประปา|ท่อ/.test(c)) return 'pipe';
  if (/สี/.test(c)) return 'paint';
  if (/มวลรวม|ทราย|หิน/.test(c)) return 'sand';
  if (/หล่อ/.test(c)) return /RING|วง/.test(p.sku + p.name) ? 'ring' : 'post';
  return 'box';
}

export const ProductImg = ({ p }: { p: Product }) => (
  <svg viewBox="0 0 120 80" role="img" aria-label={p.name} dangerouslySetInnerHTML={{ __html: IMG[pick(p)] ?? IMG.box! }} />
);
