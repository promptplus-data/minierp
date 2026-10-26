import { d, round2, type Num } from './money';

const NUM = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
const POS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

function readSix(s: string): string {
  s = s.replace(/^0+/, '');
  let o = '';
  const L = s.length;
  for (let i = 0; i < L; i++) {
    const dg = +s[i]!;
    const p = L - i - 1;
    if (!dg) continue;
    if (p === 0 && dg === 1 && L > 1) o += 'เอ็ด';
    else if (p === 1 && dg === 2) o += 'ยี่';
    else if (!(p === 1 && dg === 1)) o += NUM[dg];
    o += POS[p];
  }
  return o;
}

const big = (s: string): string => (s.length > 6 ? big(s.slice(0, -6)) + 'ล้าน' + readSix(s.slice(-6)) : readSix(s));

/** Thai baht text for printed documents (mockup `bahtText`). Sign is ignored; rounds to the satang. */
export function bahtText(amount: Num): string {
  const n = round2(d(amount).abs());
  const i = n.trunc();
  const st = n.minus(i).times(100).toNumber();
  const intPart = i.isZero() ? (st ? '' : 'ศูนย์บาท') : big(i.toFixed(0)) + 'บาท';
  return intPart + (st ? big(String(st)) + 'สตางค์' : 'ถ้วน');
}
