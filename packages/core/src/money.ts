import DecimalBase from 'decimal.js';

/** Decimal constructor used by all rules: 40 significant digits, round half up (away from zero on .5). */
export const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;

/** Anything the rules accept as a number. Prefer strings at API boundaries. */
export type Num = string | number | Decimal | DecimalBase;

/** Money string with exactly 2 decimals, e.g. "1234.50". */
export type Money = string;

export const d = (x: Num | null | undefined): Decimal => new Decimal(x == null || x === '' ? 0 : (x as DecimalBase.Value));

export const round2 = (x: Num): Decimal => d(x).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const round4 = (x: Num): Decimal => d(x).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

export const sum = (xs: readonly Num[]): Decimal => xs.reduce<Decimal>((a, x) => a.plus(d(x)), new Decimal(0));

/** Money string: always 2 dp ("125.00"). */
export const money = (x: Num): Money => round2(x).toFixed(2);

/** Quantity / unit-cost string: up to 4 dp, no trailing zeros ("125", "118.3412"). */
export const qty4 = (x: Num): string => round4(x).toFixed();

/** Thai-style money display with thousands separators: "1,234.50", "-12.00". */
export function fmtTHB(x: Num): string {
  const s = round2(x).toFixed(2);
  const neg = s.startsWith('-');
  const [int = '0', frac = '00'] = (neg ? s.slice(1) : s).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg && s !== '-0.00' ? '-' : '') + grouped + '.' + frac;
}
