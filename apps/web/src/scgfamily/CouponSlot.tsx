/**
 * CLOUD ONLY. "คูปอง SCG Family" slot on the POS cart and the sales-order form: opens the picker, shows the applied
 * coupon with เปลี่ยน / นำออก, and keeps it honest while the bill changes (re-evaluates; drops it when the customer
 * changes or the cart no longer qualifies). Mounted through ../cloud.ts only.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ScgfCart } from '@erp/contracts/src/scgfamily';
import type { AppliedCoupon } from '../cloud';
import { fmt, useToast } from '../ui';
import { evaluate, releaseCoupon } from './api';
import { CouponPicker } from './CouponPicker';
import './scgfamily.css';

export default function CouponSlot({ customerId, cart, value, onChange }: {
  customerId: string | null; cart: ScgfCart | null; value: AppliedCoupon | null; onChange: (c: AppliedCoupon | null) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const hasLines = !!cart && cart.lines.length > 0;
  const drop = (reason: string, text: string) => {
    if (!value) return;
    void releaseCoupon(value.reservationId, reason);
    onChange(null);
    toast(text);
  };

  // customer changed / cart emptied: give the reservation back
  useEffect(() => {
    if (value && value.customerId !== customerId) drop('member_changed', 'เปลี่ยนลูกค้าแล้ว นำคูปอง SCG Family ออกจากบิล');
    else if (value && !hasLines) drop('cart_cleared', 'นำคูปอง SCG Family ออกจากบิลแล้ว');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, hasLines]);

  // cart changed: the provider decides the value again (the server re-checks on save too)
  const recheck = useQuery({
    queryKey: ['scgf-recheck', value?.memberId, value?.code, JSON.stringify(cart)],
    enabled: !!value && hasLines && !open, retry: false, staleTime: 0,
    queryFn: () => evaluate(value!.memberId, cart!),
  });
  useEffect(() => {
    if (!value || !recheck.data) return;
    const c = recheck.data.coupons.find((x) => x.code === value.code);
    if (!c?.eligible) drop('removed', `คูปอง ${value.code} ใช้กับยอดนี้ไม่ได้แล้ว นำออกจากบิล`);
    else if (c.discountAmount !== value.amount) {
      onChange({ ...value, amount: c.discountAmount });
      toast(`ยอดคูปอง ${value.code} ปรับเป็น ฿${fmt(c.discountAmount)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheck.data]);

  return (
    <div className="scgf-slot" data-testid="scgf-slot">
      {value ? (
        <div className="scgf-applied" data-testid="scgf-applied">
          <span className="scgf-tag">คูปอง SCG Family</span>
          <span className="scgf-applied-t"><b>{value.title}</b> <span className="mono small">{value.code}</span></span>
          <b className="scgf-val">−฿{fmt(value.amount)}</b>
          <span className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => setOpen(true)} disabled={!hasLines}>เปลี่ยน</button>
            <button className="btn sm bad" onClick={() => drop('removed', 'นำคูปองออกแล้ว')} data-testid="scgf-remove">นำออก</button>
          </span>
        </div>
      ) : (
        <button className="scgf-open" onClick={() => setOpen(true)} disabled={!hasLines} data-testid="scgf-open">
          <span className="scgf-tag">คูปอง SCG Family</span>
          <span className="small muted">{hasLines ? 'แตะเพื่อเลือกคูปองของลูกค้า' : 'เพิ่มสินค้าก่อนเลือกคูปอง'}</span>
          <span aria-hidden className="scgf-chev">›</span>
        </button>
      )}
      {open && cart && (
        <CouponPicker customerId={customerId} cart={cart} value={value} onClose={() => setOpen(false)}
          onApply={(c) => { onChange(c); setOpen(false); if (c) toast(`ใช้คูปอง ${c.code} −฿${fmt(c.amount)}`); }} />
      )}
    </div>
  );
}
