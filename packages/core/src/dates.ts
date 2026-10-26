/** Calendar-date helpers on 'YYYY-MM-DD' strings, computed in UTC so the host time zone never matters. */
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseISODate(s: string): { y: number; m: number; d: number } {
  const r = ISO.exec(s);
  if (!r) throw new RangeError(`Bad date '${s}', expected YYYY-MM-DD`);
  return { y: +r[1]!, m: +r[2]!, d: +r[3]! };
}

const fromUTC = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** y, m (1-based, may overflow), day (0 = last day of previous month), like `new Date(y, m-1, d)`. */
export const ymd = (y: number, m: number, day: number): string => fromUTC(Date.UTC(y, m - 1, day));

export function addDays(date: string, n: number): string {
  const { y, m, d } = parseISODate(date);
  return ymd(y, m, d + n);
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(date: string): number {
  const { y, m, d } = parseISODate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
