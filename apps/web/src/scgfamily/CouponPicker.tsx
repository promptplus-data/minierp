/**
 * CLOUD ONLY. "เพิ่มส่วนลด" modal (owner's reference screenshot, round 4 ข้อ 7): close at top left, tabs
 * โปรโมชั่น / Cash Card / แลกคะแนน, coupon code entry, a 2-column grid of coupon cards with a radio each, and
 * ยกเลิก / ยืนยัน. Coupons the cart does not qualify for stay visible, greyed, with the provider's reason.
 * A customer without a linked member id gets a member search first (id or phone), optionally linked to the customer.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ScgfCart, ScgfCoupon, ScgfMember } from '@erp/contracts/src/scgfamily';
import { ApiFail } from '../api';
import type { AppliedCoupon } from '../cloud';
import { fmt, Modal, th } from '../ui';
import { evaluate, lookupMember, memberOf, releaseCoupon, reserve, setCustomerMember } from './api';
import './scgfamily.css';

const TABS = [['promotion', 'โปรโมชั่น'], ['cash_card', 'Cash Card'], ['points', 'แลกคะแนน']] as const;
type Tab = (typeof TABS)[number][0];
const EMPTY = 'ยังไม่มีคูปองที่ใช้ได้';

const failText = (e: unknown, fallback: string) => {
  if (!(e instanceof ApiFail)) return fallback;
  e.claim();
  const reason = e.detail<string>('reason') ?? e.detail<string>('providerCode');
  if (e.status === 404 || reason === 'MEMBER_NOT_FOUND') return 'ไม่พบรหัสสมาชิกนี้ ตรวจสอบตัวเลขอีกครั้ง หรือให้ลูกค้าเปิดบัตรในแอป SCG Family';
  if (reason === 'COUPON_NOT_ELIGIBLE') return 'คูปองนี้ใช้กับบิลนี้ไม่ได้';
  if (reason === 'COUPON_ALREADY_RESERVED') return 'คูปองนี้ถูกจองที่เครื่องอื่น';
  if (e.status >= 500 || e.status === 0) return 'ระบบ SCG Family ไม่ตอบ ขายต่อได้โดยไม่ใช้คูปอง';
  return fallback;
};

export function CouponPicker({ customerId, cart, value, onClose, onApply }: {
  customerId: string | null; cart: ScgfCart; value: AppliedCoupon | null; onClose: () => void; onApply: (c: AppliedCoupon | null) => void;
}) {
  const linked = useQuery({ queryKey: ['scgf-member', customerId], enabled: !!customerId, queryFn: () => memberOf(customerId!), staleTime: 30_000 });
  const [memberId, setMemberId] = useState<string | null>(value?.memberId ?? null);
  useEffect(() => { if (!memberId && linked.data?.memberId) setMemberId(linked.data.memberId); }, [linked.data, memberId]);
  const needMember = !memberId && (!customerId || linked.isSuccess);

  return (
    <Modal wide onClose={onClose} label="เพิ่มส่วนลด">
      <div className="scgf" data-testid="scgf-modal">
        <div className="scgf-head">
          <button className="btn sm" onClick={onClose} data-testid="scgf-close">ปิด</button>
          <h3>เพิ่มส่วนลด</h3>
          {memberId && (
            <span className="scgf-member small">สมาชิก SCG Family <b className="mono" data-testid="scgf-member-id">{memberId}</b>
              {!linked.data?.memberId && <button className="linkbtn" onClick={() => setMemberId(null)}>เปลี่ยน</button>}
            </span>
          )}
        </div>
        {customerId && linked.isLoading && <div className="sk" />}
        {needMember && <MemberStep customerId={customerId} onUse={setMemberId} onCancel={onClose} />}
        {memberId && <Wallet memberId={memberId} customerId={customerId} cart={cart} value={value} onClose={onClose} onApply={onApply} />}
      </div>
    </Modal>
  );
}

function MemberStep({ customerId, onUse, onCancel }: { customerId: string | null; onUse: (id: string) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<ScgfMember | null>(null);
  const [link, setLink] = useState(!!customerId);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const find = async () => {
    if (!q.trim()) return;
    setBusy(true); setErr(''); setFound(null);
    try { setFound(await lookupMember(q)); } catch (e) { setErr(failText(e, 'ค้นหาสมาชิกไม่สำเร็จ')); } finally { setBusy(false); }
  };
  const use = async () => {
    if (!found) return;
    setBusy(true); setErr('');
    try {
      if (customerId && link) {
        await setCustomerMember(customerId, found.memberId);
        await qc.invalidateQueries({ queryKey: ['scgf-member', customerId] });
      }
      onUse(found.memberId);
    } catch (e) { setErr(failText(e, 'ผูกรหัสสมาชิกไม่สำเร็จ')); } finally { setBusy(false); }
  };
  return (
    <div className="scgf-memberstep" data-testid="scgf-member-step">
      <div className="note small">{customerId ? 'ลูกค้ารายนี้ยังไม่ได้ผูกสมาชิก SCG Family' : 'ลูกค้าทั่วไป'} · กรอกรหัสสมาชิก (SF…) หรือเบอร์โทรเพื่อดูคูปอง</div>
      <div className="row scgf-codebar">
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void find(); }} placeholder="รหัสสมาชิก SCG Family หรือเบอร์โทร"
          aria-label="รหัสสมาชิก SCG Family หรือเบอร์โทร" data-testid="scgf-member-input" autoFocus />
        <button className="btn" onClick={() => void find()} disabled={busy || !q.trim()} data-testid="scgf-member-find">ค้นหา</button>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      {found && (
        <div className="scgf-found" data-testid="scgf-member-found">
          <span className="ok">✓</span> <b>{found.displayName}</b> · {found.memberTypeLabel} · {found.tier} · <span className="mono">{found.memberId}</span>
          {customerId && <label className="row small"><input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} /> ผูกรหัสนี้กับลูกค้า (ครั้งหน้าไม่ต้องกรอก)</label>}
        </div>
      )}
      <div className="act">
        <button className="btn" onClick={onCancel}>ยกเลิก</button>
        <button className="btn pri" onClick={() => void use()} disabled={!found || busy} data-testid="scgf-member-use">ใช้สมาชิกนี้</button>
      </div>
    </div>
  );
}

function Wallet({ memberId, customerId, cart, value, onClose, onApply }: {
  memberId: string; customerId: string | null; cart: ScgfCart; value: AppliedCoupon | null; onClose: () => void; onApply: (c: AppliedCoupon | null) => void;
}) {
  const ev = useQuery({ queryKey: ['scgf-coupons', memberId, JSON.stringify(cart)], queryFn: () => evaluate(memberId, cart), retry: false });
  const coupons = ev.data?.coupons ?? [];
  const [tab, setTab] = useState<Tab>(() => (value && coupons.find((c) => c.code === value.code)?.kind) || 'promotion');
  const [sel, setSel] = useState<string | null>(value?.code ?? null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = coupons.filter((c) => c.kind === tab);

  const addCode = () => {
    const c = coupons.find((x) => x.code.toUpperCase() === code.trim().toUpperCase());
    if (!c) return setMsg('ไม่พบคูปองรหัสนี้ในบัญชีสมาชิก หรือใช้ที่ร้านนี้ไม่ได้');
    setTab(c.kind);
    if (!c.eligible) return setMsg(c.ineligibleReason ?? 'คูปองนี้ใช้กับบิลนี้ไม่ได้');
    setSel(c.code); setMsg(''); setCode('');
  };
  const confirm = async () => {
    if (sel === (value?.code ?? null)) return onClose();
    setBusy(true); setMsg('');
    try {
      if (!sel) {
        if (value) void releaseCoupon(value.reservationId, 'removed');
        onApply(null);
        return;
      }
      const r = await reserve(memberId, sel, cart);
      if (value) void releaseCoupon(value.reservationId, 'removed');
      onApply({ memberId, code: r.code, reservationId: r.reservationId, amount: r.discountAmount, title: r.title, customerId });
    } catch (e) {
      setMsg(failText(e, 'จองคูปองไม่สำเร็จ ลองใหม่อีกครั้ง'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label="ประเภทส่วนลด">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} data-testid={`scgf-tab-${k}`}>
            {label}{ev.data ? ` (${coupons.filter((c) => c.kind === k).length})` : ''}
          </button>
        ))}
      </div>
      <div className="row scgf-codebar">
        <input type="text" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCode(); }} placeholder="กรอกรหัสคูปอง"
          aria-label="กรอกรหัสคูปอง" data-testid="scgf-code" />
        <button className="btn" onClick={addCode} disabled={!code.trim() || !ev.data} data-testid="scgf-code-add">เพิ่ม</button>
      </div>
      {msg && <div className="err small" role="alert" data-testid="scgf-msg">{msg}</div>}
      {ev.isLoading && <div className="scgf-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="scgf-card"><div className="sk" style={{ height: 72 }} /><div className="sk" /></div>)}</div>}
      {ev.isError && <div className="note warn small">{failText(ev.error, 'ใช้คูปองไม่ได้ตอนนี้ ปิดบิลต่อได้โดยไม่ใช้คูปอง')}</div>}
      {ev.data && !shown.length && <div className="empty scgf-empty" data-testid="scgf-empty">{EMPTY}</div>}
      {shown.length > 0 && (
        <div className="scgf-grid" role="radiogroup" aria-label="คูปอง">
          {shown.map((c) => <CouponCard key={c.code} c={c} checked={sel === c.code} onPick={() => setSel(sel === c.code ? null : c.code)} />)}
        </div>
      )}
      <div className="act scgf-foot">
        <button className="btn" onClick={onClose} data-testid="scgf-cancel">ยกเลิก</button>
        <button className="btn pri" onClick={() => void confirm()} disabled={busy || ev.isLoading} data-testid="scgf-confirm">ยืนยัน</button>
      </div>
    </>
  );
}

function CouponCard({ c, checked, onPick }: { c: ScgfCoupon; checked: boolean; onPick: () => void }) {
  const [more, setMore] = useState(false);
  return (
    <label className={`scgf-card${checked ? ' on' : ''}${c.eligible ? '' : ' off'}`} data-testid={`scgf-card-${c.code}`}>
      <div className={`scgf-im k-${c.kind}`} aria-hidden>
        {c.imageUrl ? <img src={c.imageUrl} alt="" /> : <span>{c.kind === 'cash_card' ? 'Cash Card' : c.kind === 'points' ? 'แลกคะแนน' : 'ส่วนลด'}</span>}
      </div>
      <div className="scgf-body">
        <div className="scgf-top">
          <span className="scgf-chip mono">{c.code}</span>
          <input type="radio" name="scgf-coupon" checked={checked} disabled={!c.eligible} onChange={onPick} onClick={(e) => { if (checked) { e.preventDefault(); onPick(); } }}
            aria-label={`เลือก ${c.title}`} data-testid={`scgf-radio-${c.code}`} />
        </div>
        <b className="scgf-title">{c.title}</b>
        <span className="small muted">{c.description}</span>
        <span className="small">ใช้ได้ {th(c.validFrom)} – {th(c.validTo)}</span>
        <span className="small">{c.usage ? `ใช้ไปแล้ว ${c.usage.used}/${c.usage.limit}` : 'ไม่จำกัดสิทธิ'}</span>
        <span className="small">{c.conditionText}</span>
        {c.eligible ? <span className="small scgf-val">ลด ฿{fmt(c.discountAmount)}</span> : <span className="small scgf-why">{c.ineligibleReason}</span>}
        <button type="button" className="linkbtn small" onClick={(e) => { e.preventDefault(); setMore((m) => !m); }} aria-expanded={more}>เงื่อนไข</button>
        {more && <ul className="small scgf-cond">{c.conditions.map((x) => <li key={x}>{x}</li>)}</ul>}
      </div>
    </label>
  );
}
