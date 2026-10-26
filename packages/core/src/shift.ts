import { d, money, type Money, type Num } from './money';

export interface ShiftCash { float: Num; cashSales: Num; cashRefunds: Num; cashIn: Num; cashOut: Num }

/** Cash expected in the drawer: float + cash sales − cash refunds + cash in − cash out. */
export const shiftExpected = (s: ShiftCash): Money =>
  money(d(s.float).plus(d(s.cashSales)).minus(d(s.cashRefunds)).plus(d(s.cashIn)).minus(d(s.cashOut)));

/** Counted − expected. Positive = over, negative = short. */
export const shiftDiff = (expected: Num, counted: Num): Money => money(d(counted).minus(d(expected)));
