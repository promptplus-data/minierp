/**
 * M07 POS: tiles by category + search/barcode, cart with unit / qty / price / line discount, bill discount, split
 * payments and เงินเชื่อ. A discount or price over the cashier's cap asks for the manager PIN right when it is entered
 * (manager override token); every manual discount carries a reason; the live preview flags below-cost lines for
 * everyone and shows margin / bill profit to data.cost users.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { DocSummary, SalesDoc, type PosPreviewReq, type PosSaleReq, type Product } from '@erp/contracts';
import { calcDoc, d, money, needsOverride, scopeCovers, sum, type DiscReason, type PriceChange } from '@erp/core';
import { ApiFail, api, errText } from '../api';
import { useAuth } from '../auth';
import { CloudCouponSlot, CloudCouponTotal, cloudReleaseCoupon, type AppliedCoupon } from '../cloud';
import { useCatalog, useMeta, useShift, useWarehouseStock, useWarehouses } from '../data';
import { ApprovalModal, fmt, fq, Modal, Pill, ShortageModal, th, useToast, type ApprovalInput, type Shortage } from '../ui';
import {
  BundleLine, BundleTiles, HeldBar, PosImg, PROMO_CAT, bundleCoreLines, holdCart, linePrice, tilePromo, useAbbAllowed, usePosPricing, type CartBundle, type HeldCartIn,
} from '../modules/retail/pos';
import { Slip } from './Receipt';
import { ShiftClosed, ShiftStrip } from './Shift';
import { ErrorBanner } from '../errors';
import { CustomerPicker } from '../ui/CustomerPicker';
import { LoadMore, useLoadMore } from '../ui/lists';
import { PayModal, type Payload } from './PayModal';
import { LineCost, OverrideModal, QuickDisc, ReasonChips, reasonOk, usePosPreview, type Override } from './override';

/** price: manual unit price ('' = the expected price: retail, promo or the customer's list price). */
interface CartLine { pid: string; u: number; qty: string; dval: string; dmode: 'amt' | 'pct'; price: string }
interface Approvals { belowCostApproval?: ApprovalInput; creditApproval?: ApprovalInput }
type BelowLine = { productId: string; name: string; sell?: string; cost?: string };
type CreditNeed = { limit?: string; balance?: string; after?: string; over?: boolean; overdue?: number };
type Stage = null | { k: 'pay' } | { k: 'override'; then: 'pay' | 'retry' | null } | { k: 'apvBelow'; lines: BelowLine[] } | { k: 'apvCredit'; info: CreditNeed }
  | { k: 'short'; list: Shortage[] } | { k: 'done'; doc: SalesDoc };

const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());
/** Unit list price exactly as the server computes it (unit price, else base price × factor). */
export const unitListPrice = (p: Product, u: number) => {
  const unit = p.units[u] ?? p.units[0]!;
  return unit.price != null ? d(unit.price).toString() : d(p.price).times(d(unit.factor)).toString();
};

export default function Pos() {
  const shift = useShift();
  if (shift.isLoading) return <div className="card"><div className="sk" /><div className="sk" /></div>;
  if (shift.isError) return <div className="card"><ErrorBanner error={shift.error} onRetry={() => void shift.refetch()} retrying={shift.isFetching} /></div>;
  if (!shift.data) return <ShiftClosed />;
  return (
    <>
      <ShiftStrip shift={shift.data} />
      <PosMain shiftId={shift.data.id} deviceId={shift.data.deviceId} />
      <TodayBills />
    </>
  );
}

function PosMain({ shiftId, deviceId }: { shiftId: string; deviceId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const cat = useCatalog();
  const whs = useWarehouses();
  const posWh = whs.data?.find((w) => w.isPos && w.active) ?? whs.data?.[0];
  const stock = useWarehouseStock(posWh?.id);
  const vat = meta.data?.shop.vatRegistered ?? true;
  const mode = vat ? 'inc' : 'none';
  const capRaw = can('pos.discCap');
  const myCap = typeof capRaw === 'number' ? capRaw : 0;
  const canPrice = can('pos.price') === 1;

  const [q, setQ] = useState('');
  const [catSel, setCatSel] = useState('ALL');
  const [cart, setCartRaw] = useState<CartLine[]>([]);
  const [billDisc, setBillDiscRaw] = useState('');
  // Module C: bundle sets in the bill and the customer whose price list applies (BR-05 / M15).
  const [bcart, setBcartRaw] = useState<CartBundle[]>([]);
  const [cust, setCustRaw] = useState<string | null>(null);
  const [reason, setReason] = useState<DiscReason | null>(null);
  const [reasonBad, setReasonBad] = useState(false);
  const [override, setOverride] = useState<Override | null>(null);
  const [coupon, setCouponRaw] = useState<AppliedCoupon | null>(null); // cloud only: member coupon, not a shop discount
  const pricing = usePosPricing(posWh?.id, cust).data;
  const abb = useAbbAllowed(deviceId);
  const [stage, setStage] = useState<Stage>(null);
  const [payErr, setPayErr] = useState('');
  const idem = useRef<string | null>(null);
  const payload = useRef<Payload | null>(null);
  const approvals = useRef<Approvals>({});
  /** Last cart state that needed no (further) approval: restored when the manager PIN is cancelled. */
  const lastOk = useRef<{ cart: CartLine[]; billDisc: string }>({ cart: [], billDisc: '' });
  const [checkTick, setCheckTick] = useState(0);
  const billDiscRef = useRef<HTMLInputElement>(null);
  const discRefs = useRef<(HTMLInputElement | null)[]>([]);

  /** Any change to the bill forgets the idempotency key and the PIN approvals; the override token stays while it covers the bill. */
  const touch = () => { idem.current = null; approvals.current = {}; };
  const setCart = (f: (c: CartLine[]) => CartLine[]) => { touch(); setCartRaw(f); };
  const setBillDisc = (v: string) => { touch(); setBillDiscRaw(v); };
  const setBcart = (f: (c: CartBundle[]) => CartBundle[]) => { touch(); setBcartRaw(f); };
  const setCust = (v: string | null) => { touch(); setCustRaw(v); };
  const setCoupon = (c: AppliedCoupon | null) => { touch(); setCouponRaw(c); };
  /** A discount / price was entered or confirmed: check it against the cap after this render. */
  const commit = () => setCheckTick((n) => n + 1);
  const addBundle = (id: string) => setBcart((c) => (c.some((b) => b.promoId === id) ? c.map((b) => (b.promoId === id ? { ...b, sets: String((Number(b.sets) || 0) + 1) } : b)) : [...c, { promoId: id, sets: '1' }]));

  const products = cat.data ?? [];
  const hasPromo = !!pricing && (pricing.promos.length > 0 || pricing.bundles.length > 0);
  const cats = useMemo(() => [...(hasPromo ? [PROMO_CAT] : []), ...new Set(products.map((p) => p.category))], [products, hasPromo]);
  const term = q.trim().toLowerCase();
  const tiles = products.filter((p) => (catSel === 'ALL' || p.category === catSel || (catSel === PROMO_CAT && !!tilePromo(pricing, p))) && (!term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term) || p.barcode === q.trim()));
  const have = (pid: string) => d(stock.data?.get(pid) ?? '0');

  const add = (p: Product) => {
    setCart((c) => {
      const ex = c.find((l) => l.pid === p.id && l.u === 0);
      if (ex) return c.map((l) => (l === ex ? { ...l, qty: d(isNum(l.qty) ? l.qty : '0').plus(1).toString() } : l));
      return [...c, { pid: p.id, u: 0, qty: '1', dval: '', dmode: 'amt', price: '' }];
    });
  };
  const onSearchKey = (key: string) => {
    if (key !== 'Enter') return;
    const v = q.trim();
    if (!v) return;
    const p = products.find((x) => x.barcode && x.barcode === v);
    if (p) {
      add(p);
      setQ('');
      toast(`สแกน: ${p.name}`);
    } else if (tiles.length === 1) {
      add(tiles[0]!);
      setQ('');
    } else toast('ไม่พบบาร์โค้ดนี้ในสินค้าของร้าน');
  };

  const lineOf = (l: CartLine) => {
    const p = cat.byId.get(l.pid)!;
    const lp = linePrice(pricing, p, l.u, l.qty.trim());
    const manual = isNum(l.price) && !d(l.price).eq(d(lp.price)) ? d(l.price).toFixed(2) : null;
    const price = manual ?? lp.price;
    // a typed price equal to the retail price is not a change (the server accepts both)
    const changed = manual != null && !d(manual).eq(d(lp.retail));
    const discount = isNum(l.dval) && d(l.dval).gt(0) ? { kind: l.dmode, value: l.dval.trim() } : null;
    return { p, price, lp, manual, changed, discount, core: { qty: isNum(l.qty) ? l.qty : '0', unitPrice: price, discount, vat: p.vat } };
  };
  const ready = cart.filter((l) => cat.byId.has(l.pid));
  const lines = ready.map(lineOf);
  const vatOf = (pid: string) => cat.byId.get(pid)?.vat ?? 'v7';
  const bundleCores = bcart.map((b) => bundleCoreLines(pricing, b, vatOf));
  const totals = calcDoc([...lines.map((x) => x.core), ...bundleCores.flat()], mode, isNum(billDisc) ? billDisc : 0, coupon?.amount ?? 0);
  const bundleNet = (i: number) => {
    const start = lines.length + bundleCores.slice(0, i).reduce((a, c) => a + c.length, 0);
    return sum(totals.lines.slice(start, start + bundleCores[i]!.length).map((x) => x.net)).toFixed(2);
  };
  const baseNeed = new Map<string, ReturnType<typeof d>>();
  ready.forEach((l) => {
    const p = cat.byId.get(l.pid)!;
    if (p.kind === 'stock') baseNeed.set(l.pid, (baseNeed.get(l.pid) ?? d(0)).plus(d(isNum(l.qty) ? l.qty : '0').times(d(p.units[l.u]?.factor ?? '1'))));
  });
  bcart.forEach((b) => {
    const x = pricing?.bundles.find((y) => y.id === b.promoId);
    x?.components.forEach((c) => {
      if (cat.byId.get(c.productId)?.kind === 'stock') baseNeed.set(c.productId, (baseNeed.get(c.productId) ?? d(0)).plus(d(c.qtyPerSet).times(d(/^\d+$/.test(b.sets) ? b.sets : '0'))));
    });
  });
  const validQty = (ready.length > 0 || bcart.length > 0) && ready.every((l) => isNum(l.qty) && d(l.qty).gt(0))
    && bcart.every((b) => /^\d+$/.test(b.sets) && Number(b.sets) > 0 && pricing?.bundles.some((y) => y.id === b.promoId));
  const empty = !cart.length && !bcart.length;

  // ---------- manager override (discount over the cap / changed price) ----------
  const priceChanges: PriceChange[] = lines.flatMap((x, i) => (x.changed ? [{ productId: x.p.id, unitIdx: ready[i]!.u, price: x.price }] : []));
  const discount = money(d(totals.lineDisc).plus(d(totals.billDisc)));
  const bill = { gross: totals.gross, discount, prices: priceChanges };
  const need = needsOverride(bill, myCap, canPrice);
  const needsApv = need.discount || need.price;
  const covered = !needsApv || (!!override && scopeCovers(override.scope, bill, { checkDiscount: need.discount, checkPrices: need.price }).ok);
  const manual = d(discount).gt(0) || priceChanges.length > 0;
  useEffect(() => { if (covered) lastOk.current = { cart, billDisc }; });
  useEffect(() => {
    if (checkTick && !covered && stage === null) setStage({ k: 'override', then: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkTick]);
  /** PIN cancelled at entry: discounts and prices go back to the last approved / within-cap values; quantities stay. */
  const revertOverCap = () => {
    const ok = lastOk.current;
    setCartRaw((c) => c.map((l) => {
      const o = ok.cart.find((x) => x.pid === l.pid && x.u === l.u);
      return { ...l, dval: o?.dval ?? '', dmode: o?.dmode ?? l.dmode, price: o?.price ?? '' };
    }));
    setBillDiscRaw(ok.billDisc);
  };
  useEffect(() => { if (!manual) setReasonBad(false); }, [manual]);

  // ---------- live preview: below-cost flags, margin for data.cost ----------
  const previewBody: PosPreviewReq | null = posWh && validQty ? {
    warehouseId: posWh.id, ...(cust ? { customerId: cust } : {}), billDiscount: totals.billDisc,
    lines: lines.map((x, i) => ({ productId: x.p.id, unitIdx: ready[i]!.u, qty: ready[i]!.qty.trim(), unitPrice: x.price, ...(x.discount ? { discount: x.discount } : {}), ...(x.lp.promo && !x.manual ? { promoId: x.lp.promo.id } : {}) })),
    ...(bcart.length ? { bundles: bcart.map((b) => ({ promoId: b.promoId, sets: b.sets })) } : {}),
  } : null;
  const preview = usePosPreview(previewBody);
  const pv = previewBody ? preview.data : undefined;

  const buildReq = (pl: Payload): PosSaleReq => {
    idem.current ??= crypto.randomUUID();
    return {
      idempotencyKey: idem.current, shiftId, warehouseId: posWh!.id, docKind: pl.docKind,
      ...(pl.customerId ?? cust ? { customerId: pl.customerId ?? cust! } : {}),
      lines: lines.map((x, i) => ({
        productId: x.p.id, unitIdx: ready[i]!.u, qty: ready[i]!.qty.trim(), unitPrice: x.price, ...(x.discount ? { discount: x.discount } : {}), ...(x.lp.promo && !x.manual ? { promoId: x.lp.promo.id } : {}),
      })),
      ...(bcart.length ? { bundles: bcart.map((b) => ({ promoId: b.promoId, sets: b.sets })) } : {}),
      billDiscount: totals.billDisc,
      payments: pl.payments,
      ...(pl.note ? { note: pl.note } : {}),
      ...(needsApv && override ? { discountToken: override.token } : {}),
      ...(manual && reason ? { discountReason: reason } : {}),
      ...approvals.current,
      ...(coupon ? { coupon: { memberId: coupon.memberId, code: coupon.code, reservationId: coupon.reservationId, amount: coupon.amount } } : {}),
    };
  };

  const resetBill = () => {
    setCartRaw([]); setBillDiscRaw(''); setBcartRaw([]); setCustRaw(null); setReason(null); setOverride(null); setCouponRaw(null);
    touch();
  };

  /** POST with the same idempotency key on every retry of this bill. Returns a failure for the caller to route. */
  const attempt = async (): Promise<ApiFail | null> => {
    const pl = payload.current!;
    try {
      const doc = await api('POST', '/api/sales/pos', { body: buildReq(pl), schema: SalesDoc });
      resetBill();
      setStage({ k: 'done', doc });
      void Promise.all(['stock', 'shift', 'docs', 'today', 'pos-pricing', 'ar'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      return null;
    } catch (e) {
      if (e instanceof ApiFail) return e;
      throw e;
    }
  };

  /** Routes a failed attempt to the right modal (mockup: needPerm / guardSale / blockShort). */
  const route = (f: ApiFail) => {
    const need = f.detail('need');
    // these have their own screen below; everything else (incl. SHIFT_REQUIRED) falls through to the error dialog
    if ((f.code === 'FORBIDDEN' && (need === 'discountApproval' || need === 'creditApproval')) || f.code === 'BELOW_COST' || f.code === 'INSUFFICIENT_STOCK'
      || (f.code === 'CONFLICT' && f.detail('reason') === 'PROMO_ENDED') || (f.code === 'VALIDATION' && f.detail('field') === 'discountReason')) f.claim();
    if (f.code === 'FORBIDDEN' && need === 'discountApproval') {
      setOverride(null);
      return setStage({ k: 'override', then: 'retry' });
    }
    if (f.code === 'FORBIDDEN' && need === 'creditApproval') return setStage({ k: 'apvCredit', info: f.details as CreditNeed });
    if (f.code === 'VALIDATION' && f.detail('field') === 'discountReason') {
      setReasonBad(true);
      setStage(null);
      return toast('เลือกเหตุผลของส่วนลดก่อนชำระเงิน');
    }
    if (f.code === 'BELOW_COST') return setStage({ k: 'apvBelow', lines: f.detail<BelowLine[]>('lines') ?? [] });
    if (f.code === 'INSUFFICIENT_STOCK') return setStage({ k: 'short', list: (f.details as Shortage[]) ?? [] });
    if (f.code === 'CONFLICT' && f.detail('reason') === 'PROMO_ENDED') {
      void qc.invalidateQueries({ queryKey: ['pos-pricing'] });
      setStage(null);
      return toast('โปรโมชั่นที่ใช้ในบิลหมดเวลาแล้ว ระบบโหลดราคาใหม่ ตรวจยอดแล้วกดชำระอีกครั้ง');
    }
    const cr = f.code === 'CONFLICT' ? String(f.detail('reason') ?? '') : '';
    if (cr.startsWith('COUPON_')) {
      f.claim();
      setStage(null);
      const amt = f.detail<string>('newAmount');
      if (cr === 'COUPON_AMOUNT_CHANGED' && amt) { setCoupon(coupon && { ...coupon, amount: amt }); return toast(`ยอดคูปองเปลี่ยนเป็น ฿${fmt(amt)} ตรวจยอดแล้วกดชำระอีกครั้ง`); }
      cloudReleaseCoupon(coupon, 'redeem_aborted');
      setCoupon(null);
      return toast('คูปองใช้กับบิลนี้ไม่ได้แล้ว นำออกจากบิล ชำระต่อได้โดยไม่ใช้คูปอง');
    }
    if (f.code === 'SHIFT_REQUIRED') {
      void qc.invalidateQueries({ queryKey: ['shift'] });
      setStage(null);
      return; // the error dialog says "ต้องเปิดกะก่อน"
    }
    setPayErr(f.message);
    setStage({ k: 'pay' });
  };

  const pay = async (pl: Payload) => {
    payload.current = pl;
    setPayErr('');
    const f = await attempt();
    if (f) route(f);
  };

  /** PIN modal submit (below cost / credit limit): retry with the PIN; approval errors stay in the modal, anything else is routed. */
  const approveWith = (key: keyof Approvals) => async (a: ApprovalInput) => {
    approvals.current = { ...approvals.current, [key]: a };
    const f = await attempt();
    if (!f) return null;
    if (f.detail('approvalError')) {
      approvals.current = { ...approvals.current, [key]: undefined };
      return errText(f);
    }
    route(f);
    return null;
  };

  const openPay = () => {
    if (!validQty) return toast('ใส่จำนวนสินค้าให้ถูกต้องก่อน');
    if (manual && !reasonOk(reason)) {
      setReasonBad(true);
      return toast('เลือกเหตุผลของส่วนลด / การแก้ราคาก่อนชำระเงิน');
    }
    if (!covered) return setStage({ k: 'override', then: 'pay' });
    setPayErr('');
    setStage({ k: 'pay' });
  };
  const clear = () => {
    if (empty) return;
    if (window.confirm('ยกเลิกบิลนี้ทั้งใบ?')) { cloudReleaseCoupon(coupon, 'cart_cleared'); resetBill(); }
  };
  /** REQ-M07-08: park the bill (no stock cut) and start a new one. Manual prices are not kept on a held bill. */
  const hold = async () => {
    const held: HeldCartIn = { lines: ready.map((l) => ({ productId: l.pid, unitIdx: l.u, qty: l.qty, dval: l.dval, dmode: l.dmode })), bundles: bcart, billDiscount: billDisc, customerId: cust };
    try {
      const h = await holdCart(shiftId, held, totals.total);
      cloudReleaseCoupon(coupon, 'held'); // a held bill keeps no coupon
      resetBill();
      void qc.invalidateQueries({ queryKey: ['held'] });
      toast(`พักบิลแล้ว · ${h.label}`);
    } catch (e) {
      toast(errText(e));
    }
  };
  const resume = (c: HeldCartIn) => {
    if (!empty && !window.confirm('บิลที่กำลังขายอยู่จะถูกแทนที่ ต้องการเรียกบิลพักกลับมา?')) return;
    resetBill();
    setCartRaw(c.lines.filter((l) => cat.byId.has(l.productId)).map((l) => ({ pid: l.productId, u: l.unitIdx, qty: l.qty, dval: l.dval, dmode: l.dmode, price: '' })));
    setBcartRaw(c.bundles);
    setBillDiscRaw(c.billDiscount);
    setCustRaw(c.customerId);
    commit();
    toast('เรียกบิลพักกลับมาแล้ว');
  };
  /** Bill discount quick buttons: % of the subtotal after line discounts, as an amount. */
  const billPct = (pct: number) => { setBillDisc(d(totals.sub).times(pct).div(100).toDecimalPlaces(2).toFixed(2)); commit(); };
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') commit(); };

  return (
    <div className="pos">
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => onSearchKey(e.key)} placeholder="ค้นหาชื่อสินค้า หรือสแกน/พิมพ์บาร์โค้ดแล้วกด Enter" style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหาสินค้า" data-testid="pos-search" autoFocus />
        </div>
        <div className="chips" role="tablist" aria-label="หมวดหมู่">
          {['ALL', ...cats].map((c) => <button key={c} className={catSel === c ? 'on' : ''} onClick={() => setCatSel(c)}>{c === 'ALL' ? 'ทั้งหมด' : c}</button>)}
        </div>
        <div className="tiles" data-testid="tiles">
          {cat.isLoading && Array.from({ length: 8 }, (_, i) => <div key={i} className="tile"><div className="sk" style={{ height: 70 }} /><div className="sk" /></div>)}
          {(catSel === 'ALL' || catSel === PROMO_CAT) && <BundleTiles pricing={pricing} q={q} onAdd={addBundle} />}
          {tiles.map((p) => { const tp = tilePromo(pricing, p); return (
            <button key={p.id} className="tile" onClick={() => add(p)} data-testid={`tile-${p.sku}`}>
              <span className="im"><PosImg p={p} version={pricing?.images[p.id]} /></span>
              <span className="small muted mono">{p.sku} · {p.category}</span>
              <span className="nm">{p.name}</span>
              <span className="row" style={{ gap: 4 }}>
                {p.isScg && <Pill k="acc">SCG</Pill>}
                {tp && <Pill k="ok">โปร</Pill>}
                <span className="small muted">{p.kind === 'stock' ? `คงเหลือ ${fq(have(p.id))} ${p.units[0]?.name}` : 'บริการ (ไม่นับสต็อก)'}</span>
              </span>
              {tp ? <span className="pr">{fmt(tp.price)} <s className="small muted">{fmt(p.price)}</s> / {p.units[0]?.name}</span> : <span className="pr">{fmt(p.price)} / {p.units[0]?.name}</span>}
            </button>
          ); })}
          {!cat.isLoading && !tiles.length && <div className="empty">ไม่พบสินค้า "{q}" ลองค้นด้วยชื่ออื่น</div>}
        </div>
      </div>

      <div className="card cart" data-testid="cart">
        <h2>บิลขาย <span className="small muted mono">{vat ? `${deviceId} · ${abb.posId ?? (abb.allowed ? 'ใบกำกับภาษีอย่างย่อ / เต็มรูป' : 'รออนุมัติ ภ.พ.06')}` : 'ใบเสร็จรับเงิน (ไม่จด VAT)'}</span></h2>
        <div className="row" style={{ marginBottom: 8, justifyContent: 'space-between' }}>
          <div className="row small" style={{ gap: 6, flex: 1, minWidth: 220 }}><span>ลูกค้า</span>
            <CustomerPicker value={cust} onChange={(id) => setCust(id)} emptyLabel="ลูกค้าทั่วไป (ราคาปลีก)" testId="pos-cust" ariaLabel="ลูกค้าของบิล" style={{ flex: 1, maxWidth: 280 }} />
          </div>
          <HeldBar shiftId={shiftId} canHold={!empty} onHold={hold} onResume={resume} />
        </div>
        {empty && <div className="empty">ยังไม่มีสินค้าในบิล<br /><span className="small">แตะสินค้าทางซ้าย หรือสแกนบาร์โค้ด</span></div>}
        {ready.map((l, i) => {
          const x = lines[i]!;
          const p = x.p;
          const net = totals.lines[i]?.net ?? '0';
          const listGross = d(x.core.qty).times(d(x.lp.retail)).toDecimalPlaces(2);
          const disc = d(x.core.qty).times(d(x.price)).toDecimalPlaces(2).minus(d(net));
          const struck = listGross.gt(d(net));
          const over = p.kind === 'stock' && (baseNeed.get(p.id) ?? d(0)).gt(have(p.id));
          const upd = (patch: Partial<CartLine>) => setCart((c) => c.map((y, j) => (j === i ? { ...y, ...patch } : y)));
          return (
            <div className="cline" key={i} data-testid={`cline-${i}`}>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}><span className="thumb"><PosImg p={p} version={pricing?.images[p.id]} /></span><span className="nm">{p.name}</span></div>
                <div className="ctl">
                  <select value={l.u} aria-label="หน่วย" onChange={(e) => upd({ u: Number(e.target.value), price: '' })}>{p.units.map((u, k) => <option key={k} value={k}>{u.name}</option>)}</select>
                  <button className="qbtn" aria-label="ลด" onClick={() => upd({ qty: d(isNum(l.qty) ? l.qty : '1').minus(1).lte(0) ? '1' : d(l.qty).minus(1).toString() })}>−</button>
                  <input className={`qty${over || !isNum(l.qty) ? ' bad' : ''}`} type="text" inputMode="decimal" data-field={`lines.${i}.qty`} value={l.qty} aria-label="จำนวน" onChange={(e) => upd({ qty: e.target.value })} onBlur={commit} data-testid={`qty-${i}`} />
                  <button className="qbtn" aria-label="เพิ่ม" onClick={() => { upd({ qty: d(isNum(l.qty) ? l.qty : '0').plus(1).toString() }); commit(); }}>+</button>
                  <span className="row small" style={{ gap: 4, flexWrap: 'nowrap' }}>@
                    <input className={`qty pos-price${x.changed ? ' changed' : ''}`} type="text" inputMode="decimal" data-field={`lines.${i}.unitPrice`} value={l.price} placeholder={fmt(x.lp.price)}
                      aria-label={`ราคาต่อหน่วย ${p.name}`} title={canPrice ? 'แก้ราคาขาย' : 'แก้ราคาขาย (ต้องให้ผู้จัดการอนุมัติ)'}
                      onChange={(e) => upd({ price: e.target.value })} onBlur={commit} onKeyDown={onEnter} data-testid={`price-${i}`} />
                  </span>
                  {x.lp.source !== 'retail' && !x.manual && <span className="row small" style={{ gap: 4 }} title={x.lp.promo?.name}><Pill k="ok">{x.lp.promo ? 'โปร' : 'ราคาลูกค้า'}</Pill></span>}
                  <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                    <span className="small muted">ส่วนลด</span>
                    <input ref={(el) => { discRefs.current[i] = el; }} className="qty" type="text" inputMode="decimal" data-field={`lines.${i}.discount`} value={l.dval} placeholder="0" style={{ width: 70 }}
                      aria-label={`ส่วนลดรายการ ${p.name}`} onChange={(e) => upd({ dval: e.target.value })} onBlur={commit} onKeyDown={onEnter} data-testid={`ldisc-${i}`} />
                    <select value={l.dmode} aria-label="หน่วยส่วนลด" onChange={(e) => { upd({ dmode: e.target.value as 'amt' | 'pct' }); commit(); }} data-testid={`ldmode-${i}`}><option value="amt">บาท</option><option value="pct">%</option></select>
                  </span>
                  <QuickDisc testId={`lqd-${i}`} active={!!x.discount}
                    onPct={(n) => { upd({ dval: String(n), dmode: 'pct' }); commit(); }}
                    onAmount={() => { upd({ dmode: 'amt' }); discRefs.current[i]?.focus(); }}
                    onClear={() => { upd({ dval: '' }); commit(); }} />
                </div>
                <LineCost row={pv?.lines[i]} testId={`lcost-${i}`} />
                {over && <div className="small" style={{ color: 'var(--bad)' }}>เกินคงเหลือ {fq(have(p.id))} {p.units[0]?.name} (ห้ามขายติดลบ)</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                {struck && <span className="was" data-testid={`was-${i}`}>{fmt(listGross)}</span>}<b data-testid={`lnet-${i}`}>{fmt(net)}</b>
                {disc.gt(0) && <div className="small" style={{ color: 'var(--ok)' }}>ลด {fmt(disc)}</div>}
                {x.changed && <div className="small" style={{ color: 'var(--warn, #b70)' }}>แก้ราคา</div>}
                <br />
                <button className="btn sm bad" onClick={() => { setCart((c) => c.filter((_, j) => j !== i)); commit(); }}>ลบ</button>
              </div>
            </div>
          );
        })}
        {bcart.map((b, i) => (
          <div key={b.promoId}>
            <BundleLine pricing={pricing} b={b} net={bundleNet(i)} testId={`bline-${i}`}
              onSets={(v) => setBcart((c) => c.map((y, j) => (j === i ? { ...y, sets: v } : y)))} onRemove={() => setBcart((c) => c.filter((_, j) => j !== i))} />
            <LineCost row={pv?.bundles[i]} testId={`bcost-${i}`} />
          </div>
        ))}
        <div className="pos-billdisc">
          <label className="f">ส่วนลดท้ายบิล (บาท)<input ref={billDiscRef} type="text" inputMode="decimal" name="billDiscount" data-field="billDiscount" value={billDisc} placeholder="0"
            onChange={(e) => setBillDisc(e.target.value)} onBlur={commit} onKeyDown={onEnter} data-testid="bill-disc" /></label>
          <QuickDisc testId="bqd" active={isNum(billDisc) && d(billDisc).gt(0)} onPct={billPct} onAmount={() => billDiscRef.current?.focus()} onClear={() => { setBillDisc(''); commit(); }} />
        </div>
        {CloudCouponSlot && (
          <Suspense fallback={null}>
            <CloudCouponSlot customerId={cust} value={coupon} onChange={setCoupon}
              cart={validQty ? { vatMode: mode, billDiscount: '0', lines: lines.map((x, i) => ({ productId: x.p.id, qty: ready[i]!.qty.trim(), unitPrice: x.price, ...(x.discount ? { discount: x.discount } : {}) })) } : null} />
          </Suspense>
        )}
        {manual && <ReasonChips value={reason} onChange={(r) => { setReason(r); setReasonBad(false); }} invalid={reasonBad && !reasonOk(reason)} />}
        {needsApv && (
          <div className="pos-override small" data-testid="override-state">
            {covered
              ? <><Pill k="ok">อนุมัติแล้ว</Pill> โดย {override?.by} · ส่วนลดไม่เกิน ฿{fmt(override?.scope.maxAmount ?? '0')}</>
              : <><Pill k="warn">รออนุมัติ</Pill> ส่วนลด {d(need.pct).toDecimalPlaces(2).toString()}% เกินสิทธิ์ {myCap}%{need.price ? ' / มีการแก้ราคา' : ''} <button className="btn sm" onClick={() => setStage({ k: 'override', then: null })} data-testid="ask-override">ขอ PIN ผู้จัดการ</button></>}
          </div>
        )}
        <div className="tot" data-testid="totals">
          <span className="muted">รวมเป็นเงิน (ก่อนส่วนลด)</span><span data-testid="t-gross">{fmt(totals.gross)}</span>
          <span className="muted">ส่วนลดรายการ</span><span className={d(totals.lineDisc).gt(0) ? 'disc' : ''} data-testid="t-linedisc">−{fmt(totals.lineDisc)}</span>
          <span className="muted">ส่วนลดท้ายบิล</span><span className={d(totals.billDisc).gt(0) ? 'disc' : ''} data-testid="t-billdisc">−{fmt(totals.billDisc)}</span>
          {coupon && CloudCouponTotal && <Suspense fallback={null}><CloudCouponTotal coupon={coupon} /></Suspense>}
          <span style={{ fontWeight: 600 }}>ยอดสุทธิ</span><span className="big" data-testid="total">฿{fmt(totals.total)}</span>
          {mode === 'none' ? <><span className="small muted">ร้านไม่จด VAT</span><span className="small muted">ไม่มีภาษี</span></> : <><span className="small muted">ภาษีมูลค่าเพิ่ม 7% (รวมในราคา)</span><span className="small muted" data-testid="t-vat">{fmt(totals.vat)}</span></>}
          {pv?.showCost && pv.profit != null && (
            <><span className="profit">กำไรขั้นต้นโดยประมาณ (FIFO ก่อน VAT)</span><span className={`profit${d(pv.profit).lt(0) ? ' neg' : ''}`} data-testid="t-profit">{fmt(pv.profit)}{pv.profitPct != null ? ` (${pv.profitPct}%)` : ''}</span></>
          )}
        </div>
        {pv?.belowCost && <div className="note bad small" style={{ marginTop: 8 }} data-testid="below-flag">มีรายการขายต่ำกว่าทุน ต้องให้เจ้าของร้านอนุมัติตอนชำระเงิน</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn bad" onClick={clear} disabled={empty}>ยกเลิกบิล</button>
          <button className="btn pri" style={{ flex: 1, justifyContent: 'center' }} onClick={openPay} disabled={empty || !d(totals.total).gt(0) || !posWh} data-testid="pay">ชำระเงิน ฿{fmt(totals.total)}</button>
        </div>
        {myCap < 100 && <p className="small muted" style={{ margin: '8px 0 0' }}>ส่วนลดเกิน {myCap}% {canPrice ? '' : 'หรือแก้ราคาขาย '}ระบบจะขอ PIN ผู้จัดการทันทีที่ใส่</p>}
      </div>

      {stage?.k === 'pay' && <PayModal total={totals.total} vat={vat} err={payErr} onClose={() => setStage(null)} onPay={pay} defaultCustomer={cust} abbAllowed={abb.allowed} abbNote={abb.reason} />}
      {stage?.k === 'override' && (
        <OverrideModal shiftId={shiftId} cap={myCap} reason={reason}
          want={{ amount: discount, pct: need.pct, prices: need.price ? priceChanges : [] }}
          priceNames={lines.filter((x) => x.changed).map((x) => `${x.p.name} ${fmt(x.lp.price)} → ${fmt(x.price)}`)}
          onCancel={() => {
            const then = stage.then;
            setStage(then === 'retry' ? { k: 'pay' } : null);
            if (then === null) {
              revertOverCap();
              toast('ยกเลิกส่วนลด / ราคาที่เกินสิทธิ์แล้ว');
            }
          }}
          onDone={(o) => {
            setOverride(o);
            toast(`อนุมัติโดย ${o.by}`);
            const then = stage.then;
            if (then === 'pay') { setPayErr(''); setStage({ k: 'pay' }); }
            else if (then === 'retry') { setStage(null); setTimeout(() => void (async () => { const f = await attempt(); if (f) route(f); })(), 0); }
            else setStage(null);
          }} />
      )}
      {stage?.k === 'apvBelow' && (
        <ApprovalModal ownerOnly title="ขายต่ำกว่าต้นทุน · ต้องให้เจ้าของร้านอนุมัติ" onClose={() => setStage(null)} onSubmit={approveWith('belowCostApproval')}
          label={<div className="note warn small" data-testid="below-cost">ขายต่ำกว่าต้นทุน {stage.lines.length} รายการ: {stage.lines.map((b) => (b.sell ? `${b.name} (ขาย ${fmt(b.sell)} < ทุน ${fmt(b.cost)} ต่อหน่วย ก่อน VAT)` : b.name)).join(', ')}</div>} />
      )}
      {stage?.k === 'apvCredit' && (
        <ApprovalModal title="ขายเชื่อเกินวงเงิน · ขออนุมัติ" onClose={() => setStage({ k: 'pay' })} onSubmit={approveWith('creditApproval')}
          label={<div className="note warn small" data-testid="credit-over">
            {stage.info.over && <>เกินวงเงิน ฿{fmt(stage.info.limit ?? '0')} (ค้างชำระ ฿{fmt(stage.info.balance ?? '0')} + บิลนี้ = ฿{fmt(stage.info.after ?? '0')}) </>}
            {!!stage.info.overdue && <>มีบิลเกินกำหนดชำระ {stage.info.overdue} ใบ</>}
          </div>} />
      )}
      {stage?.k === 'short' && <ShortageModal shortages={stage.list} what="ปิดบิลไม่ได้" onClose={() => setStage(null)} />}
      {stage?.k === 'done' && (
        <Modal onClose={() => setStage(null)} label="ชำระสำเร็จ">
          <h3>ชำระสำเร็จ · <span className="mono" data-testid="sale-no">{stage.doc.no}</span></h3>
          <Slip doc={stage.doc} />
          <div className="act">
            <button className="btn" onClick={() => window.print()}>พิมพ์</button>
            <button className="btn pri" onClick={() => setStage(null)} data-testid="next-bill">ขายบิลถัดไป</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TodayBills() {
  const list = useLoadMore(['today'], '/api/sales/docs', DocSummary, {}, 10);
  return (
    <div className="card">
      <h2>บิลล่าสุด <span className="small muted">พิมพ์ซ้ำ หรือยกเลิกบิลที่ออกผิด ที่หน้าเอกสารขาย</span></h2>
      <div className="tw">
        <table>
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>สินค้า</th><th className="n">ยอด</th><th>สถานะ</th></tr></thead>
          <tbody>
            {list.isLoading && <tr><td colSpan={6}><div className="sk" /><div className="sk" /></td></tr>}
            {list.rows.map((x) => (
              <tr key={x.id} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
                <td className="mono"><Link to={`/sales/${encodeURIComponent(x.no)}`}>{x.no}</Link></td>
                <td>{th(x.date)}</td><td>{x.customer.name}</td><td className="small">{x.itemsPreview}</td>
                <td className="n">{x.status === 'void' ? <s>{fmt(x.total)}</s> : fmt(x.total)}</td>
                <td>{x.status === 'void' ? <Pill k="bad">ยกเลิก</Pill> : <Pill k="ok">ปกติ</Pill>}</td>
              </tr>
            ))}
            {list.data && !list.rows.length && <tr><td colSpan={6} className="empty">ยังไม่มีบิล</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} testId="today-more" />
    </div>
  );
}
