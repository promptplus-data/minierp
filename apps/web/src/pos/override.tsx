/**
 * POS manager override (M07): reason chips, quick discount buttons, the approval modal that asks for the manager PIN
 * as soon as a discount / price over the cashier's cap is entered, and the debounced live cost preview.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PosApproval, PosPreview, type PosPreviewReq } from '@erp/contracts';
import { d, DISC_REASONS, discReasonText, type DiscReason, type DiscReasonCode, type DiscScope, type PriceChange } from '@erp/core';
import { ApiFail, api, errText } from '../api';
import { ApprovalModal, fmt, useDebounced, type ApprovalInput } from '../ui';
import './pos.css';

export interface Override { token: string; by: string; scope: DiscScope; expiresAt: string }

const APV_TH: Record<string, string> = {
  BAD_PIN: 'PIN ไม่ถูกต้อง',
  LOCKED: 'PIN ของผู้อนุมัติถูกล็อก 15 นาที เพราะใส่ผิด 5 ครั้ง ให้เจ้าของร้านปลดล็อก',
  SELF_APPROVAL: 'อนุมัติรายการของตัวเองไม่ได้ ให้ผู้อื่นใส่ PIN',
  ROLE_NOT_ALLOWED: 'ผู้อนุมัติคนนี้ไม่มีสิทธิ์อนุมัติรายการนี้',
  NOT_FOUND: 'ไม่พบผู้อนุมัติ หรือผู้อนุมัติไม่ได้ใช้งานแล้ว',
};

/** Required reason chips whenever the bill has a manual discount or a changed price. */
export function ReasonChips({ value, onChange, invalid }: { value: DiscReason | null; onChange: (r: DiscReason | null) => void; invalid?: boolean }) {
  return (
    <div className={`pos-reason${invalid ? ' bad' : ''}`} data-field="discountReason" data-testid="disc-reason">
      <div className="small"><b>เหตุผลที่ให้ส่วนลด / แก้ราคา</b> <span className="muted">(ต้องเลือก)</span></div>
      <div className="chips" role="radiogroup" aria-label="เหตุผลส่วนลด">
        {(Object.keys(DISC_REASONS) as DiscReasonCode[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={value?.code === k} className={value?.code === k ? 'on' : ''} data-busy="off"
            onClick={() => onChange({ code: k, text: value?.text })} data-testid={`reason-${k}`}>{DISC_REASONS[k]}</button>
        ))}
      </div>
      {value?.code === 'other' && (
        <input type="text" value={value.text ?? ''} placeholder="พิมพ์เหตุผล" maxLength={200} aria-label="เหตุผลอื่นๆ"
          onChange={(e) => onChange({ code: 'other', text: e.target.value })} data-testid="reason-text" />
      )}
      {invalid && <span className="ferr">{value?.code === 'other' ? 'พิมพ์เหตุผลก่อน' : 'เลือกเหตุผลก่อนชำระเงิน'}</span>}
    </div>
  );
}
export const reasonOk = (r: DiscReason | null) => discReasonText(r) !== null;

/** 5 % / 10 % / amount / clear, touch sized. `onAmount` focuses the amount field (the number pad opens on it in touch mode). */
export function QuickDisc({ onPct, onAmount, onClear, testId, active }: { onPct: (pct: 5 | 10) => void; onAmount: () => void; onClear: () => void; testId: string; active: boolean }) {
  return (
    <span className="pos-qd" role="group" aria-label="ส่วนลดด่วน">
      <button type="button" className="btn sm" data-busy="off" onClick={() => onPct(5)} data-testid={`${testId}-5`}>5%</button>
      <button type="button" className="btn sm" data-busy="off" onClick={() => onPct(10)} data-testid={`${testId}-10`}>10%</button>
      <button type="button" className="btn sm" data-busy="off" onClick={onAmount} data-testid={`${testId}-amt`}>฿</button>
      {active && <button type="button" className="btn sm" data-busy="off" onClick={onClear} aria-label="ล้างส่วนลด" data-testid={`${testId}-clear`}>✕</button>}
    </span>
  );
}

/**
 * Manager PIN for a discount / price over the role cap. Calls POST /api/sales/pos/approvals with what the bill carries
 * now; the token returned covers this discount or less and these prices or higher.
 */
export function OverrideModal({ shiftId, want, reason, cap, priceNames, onDone, onCancel }: {
  shiftId: string; want: { amount: string; pct: string; prices: PriceChange[] }; reason: DiscReason | null; cap: number;
  priceNames: string[]; onDone: (o: Override) => void; onCancel: () => void;
}) {
  const submit = async (a: ApprovalInput): Promise<string | null> => {
    try {
      const r = await api('POST', '/api/sales/pos/approvals', {
        schema: PosApproval, silent: true,
        body: { shiftId, approval: a, maxAmount: d(want.amount).toFixed(2), maxPct: d(want.pct).toFixed(4), prices: want.prices.map((p) => ({ ...p, price: d(p.price).toFixed(2) })), ...(reasonOk(reason) ? { reason } : {}) },
      });
      onDone({ token: r.token, by: r.approver.name, scope: { maxAmount: r.maxAmount, maxPct: r.maxPct, prices: r.prices }, expiresAt: r.expiresAt });
      return null;
    } catch (e) {
      if (e instanceof ApiFail) {
        const k = e.detail<string>('approvalError');
        if (k === 'APPROVER_CAP') return `เกินสิทธิ์ส่วนลดของผู้อนุมัติ (สูงสุด ${String(e.detail('cap'))}%) ให้เจ้าของร้านอนุมัติ`;
        if (k) return APV_TH[k] ?? errText(e);
        return errText(e);
      }
      throw e;
    }
  };
  return (
    <ApprovalModal title="ส่วนลดเกินสิทธิ์ / แก้ราคา · ขออนุมัติ" onClose={onCancel} onSubmit={submit}
      label={
        <div className="small" data-testid="override-what">
          {d(want.amount).gt(0) && <div>ส่วนลดรวม <b>฿{fmt(want.amount)}</b> ({d(want.pct).toDecimalPlaces(2).toString()}% ของยอดก่อนลด) · สิทธิ์ของคุณ {cap}%</div>}
          {want.prices.length > 0 && <div>แก้ราคาขาย: {priceNames.join(', ')}</div>}
          <div className="muted">อนุมัติครั้งเดียวใช้กับบิลนี้ ถ้าเพิ่มส่วนลดหรือลดราคาเกินที่อนุมัติ ระบบจะขอ PIN ใหม่</div>
        </div>
      } />
  );
}

/** Debounced POST /api/sales/pos/preview: below-cost flags for everyone, margin / profit for data.cost. */
export function usePosPreview(body: PosPreviewReq | null) {
  const key = useDebounced(body ? JSON.stringify(body) : null, 400);
  return useQuery({
    queryKey: ['pos-preview', key],
    enabled: !!key,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    queryFn: () => api('POST', '/api/sales/pos/preview', { body: JSON.parse(key!), schema: PosPreview, silent: true }),
  });
}

/** Per-line flag / margin chip. */
export function LineCost({ row, testId }: { row: PosPreview['lines'][number] | undefined; testId: string }) {
  if (!row) return null;
  return (
    <span className="pos-cost" data-testid={testId}>
      {row.belowCost && <span className="pill p-bad" data-testid={`${testId}-below`}>ต่ำกว่าทุน</span>}
      {row.cost !== undefined && (
        <span className={`small ${row.margin && d(row.margin).lt(0) ? 'neg' : 'muted'}`} data-testid={`${testId}-margin`}>
          {row.cost == null ? 'ทุน ไม่มีล็อตคงเหลือ' : `ทุน ${fmt(row.cost)} · กำไร ${fmt(row.margin ?? '0')}${row.marginPct != null ? ` (${row.marginPct}%)` : ''}`}
        </span>
      )}
    </span>
  );
}

export function useReason() {
  return useState<DiscReason | null>(null);
}
