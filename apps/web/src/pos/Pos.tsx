/** M07 POS: tiles by category + search/barcode, cart with unit / qty / line discount, bill discount, split payments. */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DocSummary, SalesDoc, page, type PosSaleReq, type Product } from '@erp/contracts';
import { calcDoc, d, sum } from '@erp/core';
import { ApiFail, api, errText } from '../api';
import { useAuth } from '../auth';
import { useCatalog, useCustomers, useMeta, useShift, useWarehouseStock, useWarehouses } from '../data';
import { ApprovalModal, fmt, fq, Modal, Pill, ShortageModal, th, useToast, type ApprovalInput, type Shortage } from '../ui';
import {
  BundleLine, BundleTiles, HeldBar, PosImg, PROMO_CAT, bundleCoreLines, holdCart, linePrice, tilePromo, useAbbAllowed, usePosPricing, type CartBundle, type HeldCartIn,
} from '../modules/retail/pos';
import { METHOD_TH, Slip } from './Receipt';
import { ShiftClosed, ShiftStrip } from './Shift';

interface CartLine { pid: string; u: number; qty: string; dval: string; dmode: 'amt' | 'pct' }
type Method = PosSaleReq['payments'][number]['method'];
interface PayLine { method: Method; amount: string }
interface Payload { docKind: PosSaleReq['docKind']; customerId?: string; payments: { method: Method; amount: string }[] }
interface Approvals { discountApproval?: ApprovalInput; belowCostApproval?: ApprovalInput }
type BelowLine = { productId: string; name: string; sell?: string; cost?: string };
type Stage = null | { k: 'pay' } | { k: 'apvDisc'; pct?: string; cap?: unknown } | { k: 'apvBelow'; lines: BelowLine[] } | { k: 'short'; list: Shortage[] } | { k: 'done'; doc: SalesDoc };

const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());
/** Unit list price exactly as the server computes it (unit price, else base price × factor). */
export const unitListPrice = (p: Product, u: number) => {
  const unit = p.units[u] ?? p.units[0]!;
  return unit.price != null ? d(unit.price).toString() : d(p.price).times(d(unit.factor)).toString();
};

export default function Pos() {
  const shift = useShift();
  if (shift.isLoading) return <div className="card"><div className="sk" /><div className="sk" /></div>;
  if (shift.isError) return <div className="card"><div className="note bad">{errText(shift.error)}</div></div>;
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

  const [q, setQ] = useState('');
  const [catSel, setCatSel] = useState('ALL');
  const [cart, setCartRaw] = useState<CartLine[]>([]);
  const [billDisc, setBillDiscRaw] = useState('');
  // Module C: bundle sets in the bill and the customer whose price list applies (BR-05 / M15).
  const [bcart, setBcartRaw] = useState<CartBundle[]>([]);
  const [cust, setCustRaw] = useState<string | null>(null);
  const customers = useCustomers();
  const pricing = usePosPricing(posWh?.id, cust).data;
  const abb = useAbbAllowed(deviceId);
  const [stage, setStage] = useState<Stage>(null);
  const [payErr, setPayErr] = useState('');
  const idem = useRef<string | null>(null);
  const payload = useRef<Payload | null>(null);
  const approvals = useRef<Approvals>({});

  /** Any change to the bill forgets the idempotency key and approvals: the next attempt is a new sale. */
  const touch = () => { idem.current = null; approvals.current = {}; };
  const setCart = (f: (c: CartLine[]) => CartLine[]) => { touch(); setCartRaw(f); };
  const setBillDisc = (v: string) => { touch(); setBillDiscRaw(v); };
  const setBcart = (f: (c: CartBundle[]) => CartBundle[]) => { touch(); setBcartRaw(f); };
  const setCust = (v: string | null) => { touch(); setCustRaw(v); };
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
      return [...c, { pid: p.id, u: 0, qty: '1', dval: '', dmode: 'amt' }];
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
    const price = lp.price;
    const discount = isNum(l.dval) && d(l.dval).gt(0) ? { kind: l.dmode, value: l.dval.trim() } : null;
    return { p, price, lp, discount, core: { qty: isNum(l.qty) ? l.qty : '0', unitPrice: price, discount, vat: p.vat } };
  };
  const ready = cart.filter((l) => cat.byId.has(l.pid));
  const lines = ready.map(lineOf);
  const vatOf = (pid: string) => cat.byId.get(pid)?.vat ?? 'v7';
  const bundleCores = bcart.map((b) => bundleCoreLines(pricing, b, vatOf));
  const totals = calcDoc([...lines.map((x) => x.core), ...bundleCores.flat()], mode, isNum(billDisc) ? billDisc : 0);
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

  const buildReq = (pl: Payload): PosSaleReq => {
    idem.current ??= crypto.randomUUID();
    return {
      idempotencyKey: idem.current, shiftId, warehouseId: posWh!.id, docKind: pl.docKind,
      ...(pl.customerId ?? cust ? { customerId: pl.customerId ?? cust! } : {}),
      lines: lines.map((x, i) => ({
        productId: x.p.id, unitIdx: ready[i]!.u, qty: ready[i]!.qty.trim(), unitPrice: x.price, ...(x.discount ? { discount: x.discount } : {}), ...(x.lp.promo ? { promoId: x.lp.promo.id } : {}),
      })),
      ...(bcart.length ? { bundles: bcart.map((b) => ({ promoId: b.promoId, sets: b.sets })) } : {}),
      billDiscount: totals.billDisc,
      payments: pl.payments,
      ...approvals.current,
    };
  };

  /** POST with the same idempotency key on every retry of this bill. Returns a failure for the caller to route. */
  const attempt = async (): Promise<ApiFail | null> => {
    const pl = payload.current!;
    try {
      const doc = await api('POST', '/api/sales/pos', { body: buildReq(pl), schema: SalesDoc });
      setCartRaw([]);
      setBillDiscRaw('');
      setBcartRaw([]);
      setCustRaw(null);
      touch();
      setStage({ k: 'done', doc });
      void Promise.all(['stock', 'shift', 'docs', 'today', 'pos-pricing'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      return null;
    } catch (e) {
      if (e instanceof ApiFail) return e;
      throw e;
    }
  };

  /** Routes a failed attempt to the right modal (mockup: needPerm / guardSale / blockShort). */
  const route = (f: ApiFail) => {
    if (f.code === 'FORBIDDEN' && f.detail('need') === 'discountApproval') return setStage({ k: 'apvDisc', pct: f.detail<string>('pct'), cap: f.detail('cap') });
    if (f.code === 'BELOW_COST') return setStage({ k: 'apvBelow', lines: f.detail<BelowLine[]>('lines') ?? [] });
    if (f.code === 'INSUFFICIENT_STOCK') return setStage({ k: 'short', list: (f.details as Shortage[]) ?? [] });
    if (f.code === 'CONFLICT' && f.detail('reason') === 'PROMO_ENDED') {
      void qc.invalidateQueries({ queryKey: ['pos-pricing'] });
      setStage(null);
      return toast('โปรโมชั่นที่ใช้ในบิลหมดเวลาแล้ว ระบบโหลดราคาใหม่ ตรวจยอดแล้วกดชำระอีกครั้ง');
    }
    if (f.code === 'SHIFT_REQUIRED') {
      void qc.invalidateQueries({ queryKey: ['shift'] });
      setStage(null);
      return toast(f.message);
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

  /** Approval modal submit: retry with the PIN; approval errors stay in the modal, anything else is routed. */
  const approveWith = (key: keyof Approvals) => async (a: ApprovalInput) => {
    approvals.current = { ...approvals.current, [key]: a };
    const f = await attempt();
    if (!f) return null;
    if (f.detail('approvalError')) {
      approvals.current = { ...approvals.current, [key]: undefined };
      return f.message;
    }
    route(f);
    return null;
  };

  const openPay = () => {
    if (!validQty) return toast('ใส่จำนวนสินค้าให้ถูกต้องก่อน');
    setPayErr('');
    setStage({ k: 'pay' });
  };
  const clear = () => {
    if (empty) return;
    if (window.confirm('ยกเลิกบิลนี้ทั้งใบ?')) { setCart(() => []); setBcart(() => []); setCust(null); }
  };
  /** REQ-M07-08: park the bill (no stock cut) and start a new one. */
  const hold = async () => {
    const held: HeldCartIn = { lines: ready.map((l) => ({ productId: l.pid, unitIdx: l.u, qty: l.qty, dval: l.dval, dmode: l.dmode })), bundles: bcart, billDiscount: billDisc, customerId: cust };
    try {
      const h = await holdCart(shiftId, held, totals.total);
      setCartRaw([]); setBcartRaw([]); setBillDiscRaw(''); setCustRaw(null); touch();
      void qc.invalidateQueries({ queryKey: ['held'] });
      toast(`พักบิลแล้ว · ${h.label}`);
    } catch (e) {
      toast(errText(e));
    }
  };
  const resume = (c: HeldCartIn) => {
    if (!empty && !window.confirm('บิลที่กำลังขายอยู่จะถูกแทนที่ ต้องการเรียกบิลพักกลับมา?')) return;
    touch();
    setCartRaw(c.lines.filter((l) => cat.byId.has(l.productId)).map((l) => ({ pid: l.productId, u: l.unitIdx, qty: l.qty, dval: l.dval, dmode: l.dmode })));
    setBcartRaw(c.bundles);
    setBillDiscRaw(c.billDiscount);
    setCustRaw(c.customerId);
    toast('เรียกบิลพักกลับมาแล้ว');
  };

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
          <label className="row small" style={{ gap: 6 }}>ลูกค้า
            <select value={cust ?? ''} onChange={(e) => setCust(e.target.value || null)} aria-label="ลูกค้าของบิล" data-testid="pos-cust" style={{ maxWidth: 200 }}>
              <option value="">ลูกค้าทั่วไป (ราคาปลีก)</option>
              {(customers.data ?? []).filter((c) => c.code !== 'C00000').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <HeldBar shiftId={shiftId} canHold={!empty} onHold={hold} onResume={resume} />
        </div>
        {empty && <div className="empty">ยังไม่มีสินค้าในบิล<br /><span className="small">แตะสินค้าทางซ้าย หรือสแกนบาร์โค้ด</span></div>}
        {ready.map((l, i) => {
          const x = lines[i]!;
          const p = x.p;
          const net = totals.lines[i]?.net ?? '0';
          const disc = d(x.core.qty).times(d(x.price)).toDecimalPlaces(2).minus(d(net));
          const over = p.kind === 'stock' && (baseNeed.get(p.id) ?? d(0)).gt(have(p.id));
          const upd = (patch: Partial<CartLine>) => setCart((c) => c.map((y, j) => (j === i ? { ...y, ...patch } : y)));
          return (
            <div className="cline" key={i} data-testid={`cline-${i}`}>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}><span className="thumb"><PosImg p={p} version={pricing?.images[p.id]} /></span><span className="nm">{p.name}</span></div>
                <div className="ctl">
                  <select value={l.u} aria-label="หน่วย" onChange={(e) => upd({ u: Number(e.target.value) })}>{p.units.map((u, k) => <option key={k} value={k}>{u.name}</option>)}</select>
                  <button className="qbtn" aria-label="ลด" onClick={() => upd({ qty: d(isNum(l.qty) ? l.qty : '1').minus(1).lte(0) ? '1' : d(l.qty).minus(1).toString() })}>−</button>
                  <input className={`qty${over || !isNum(l.qty) ? ' bad' : ''}`} type="text" inputMode="decimal" value={l.qty} aria-label="จำนวน" onChange={(e) => upd({ qty: e.target.value })} data-testid={`qty-${i}`} />
                  <button className="qbtn" aria-label="เพิ่ม" onClick={() => upd({ qty: d(isNum(l.qty) ? l.qty : '0').plus(1).toString() })}>+</button>
                  <span className="small muted">@{fmt(x.price)}</span>
                  {x.lp.source !== 'retail' && <span className="row small" style={{ gap: 4 }} title={x.lp.promo?.name}><Pill k="ok">{x.lp.promo ? 'โปร' : 'ราคาลูกค้า'}</Pill><s className="muted">{fmt(x.lp.retail)}</s></span>}
                  <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                    <span className="small muted">ส่วนลด</span>
                    <input className="qty" type="text" inputMode="decimal" value={l.dval} placeholder="0" style={{ width: 70 }} aria-label={`ส่วนลดรายการ ${p.name}`} onChange={(e) => upd({ dval: e.target.value })} data-testid={`ldisc-${i}`} />
                    <select value={l.dmode} aria-label="หน่วยส่วนลด" onChange={(e) => upd({ dmode: e.target.value as 'amt' | 'pct' })} data-testid={`ldmode-${i}`}><option value="amt">บาท</option><option value="pct">%</option></select>
                  </span>
                </div>
                {over && <div className="small" style={{ color: 'var(--bad)' }}>เกินคงเหลือ {fq(have(p.id))} {p.units[0]?.name} (ห้ามขายติดลบ)</div>}
              </div>
              <div style={{ textAlign: 'right' }}>
                <b>{fmt(net)}</b>
                {disc.gt(0) && <div className="small" style={{ color: 'var(--ok)' }}>ลด {fmt(disc)}</div>}
                <br />
                <button className="btn sm bad" onClick={() => setCart((c) => c.filter((_, j) => j !== i))}>ลบ</button>
              </div>
            </div>
          );
        })}
        {bcart.map((b, i) => (
          <BundleLine key={b.promoId} pricing={pricing} b={b} net={bundleNet(i)} testId={`bline-${i}`}
            onSets={(v) => setBcart((c) => c.map((y, j) => (j === i ? { ...y, sets: v } : y)))} onRemove={() => setBcart((c) => c.filter((_, j) => j !== i))} />
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <label className="f" style={{ flex: 1 }}>ส่วนลดท้ายบิล (บาท)<input type="text" inputMode="decimal" value={billDisc} placeholder="0" onChange={(e) => setBillDisc(e.target.value)} data-testid="bill-disc" /></label>
        </div>
        <div className="tot">
          <span className="muted">รวมเป็นเงิน</span><span>{fmt(totals.sub)}</span>
          <span className="muted">ส่วนลดท้ายบิล</span><span>−{fmt(totals.billDisc)}</span>
          <span style={{ fontWeight: 600 }}>ยอดสุทธิ</span><span className="big" data-testid="total">฿{fmt(totals.total)}</span>
          {mode === 'none' ? <><span className="small muted">ร้านไม่จด VAT</span><span className="small muted">ไม่มีภาษี</span></> : <><span className="small muted">ภาษีมูลค่าเพิ่ม 7% (รวมในราคา)</span><span className="small muted">{fmt(totals.vat)}</span></>}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn bad" onClick={clear} disabled={empty}>ยกเลิกบิล</button>
          <button className="btn pri" style={{ flex: 1, justifyContent: 'center' }} onClick={openPay} disabled={empty || !d(totals.total).gt(0) || !posWh} data-testid="pay">ชำระเงิน ฿{fmt(totals.total)}</button>
        </div>
        {(can('pos.discCap') === 0) && <p className="small muted" style={{ margin: '8px 0 0' }}>ส่วนลดเกินสิทธิ์ของบทบาทนี้ ระบบจะขอ PIN ผู้จัดการตอนชำระเงิน</p>}
      </div>

      {stage?.k === 'pay' && <PayModal total={totals.total} vat={vat} err={payErr} onClose={() => setStage(null)} onPay={pay} defaultCustomer={cust} abbAllowed={abb.allowed} abbNote={abb.reason} />}
      {stage?.k === 'apvDisc' && (
        <ApprovalModal title="ส่วนลดเกินสิทธิ์" onClose={() => setStage(null)} onSubmit={approveWith('discountApproval')}
          label={<p style={{ margin: 0 }}>ให้ส่วนลดได้ไม่เกิน {String(stage.cap ?? 0)}% ของยอดบิล ครั้งนี้ {stage.pct ?? '-'}% · หรือมีการแก้ราคาขาย</p>} />
      )}
      {stage?.k === 'apvBelow' && (
        <ApprovalModal ownerOnly title="ขายต่ำกว่าต้นทุน · ต้องให้เจ้าของร้านอนุมัติ" onClose={() => setStage(null)} onSubmit={approveWith('belowCostApproval')}
          label={<div className="note warn small" data-testid="below-cost">ขายต่ำกว่าต้นทุน {stage.lines.length} รายการ: {stage.lines.map((b) => (b.sell ? `${b.name} (ขาย ${fmt(b.sell)} < ทุน ${fmt(b.cost)} ต่อหน่วย ก่อน VAT)` : b.name)).join(', ')}</div>} />
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

function PayModal({ total, vat, err, onClose, onPay, defaultCustomer, abbAllowed = true, abbNote }: {
  total: string; vat: boolean; err: string; onClose: () => void; onPay: (p: Payload) => Promise<void>; defaultCustomer?: string | null; abbAllowed?: boolean; abbNote?: ReactNode;
}) {
  const customers = useCustomers();
  const [kind, setKind] = useState<PosSaleReq['docKind']>(vat ? (abbAllowed ? 'abb' : 'full') : 'receipt');
  const [cust, setCust] = useState(defaultCustomer ?? '');
  const [lines, setLines] = useState<PayLine[]>([{ method: 'cash', amount: total }]);
  const [recv, setRecv] = useState('');
  const [busy, setBusy] = useState(false);
  const withTax = (customers.data ?? []).filter((c) => c.taxId);
  const custList = kind === 'full' ? withTax : customers.data ?? [];
  const custId = kind === 'full' ? (withTax.some((c) => c.id === cust) ? cust : withTax[0]?.id ?? '') : cust;
  const paid = sum(lines.map((l) => (isNum(l.amount) ? l.amount : 0)));
  const exact = paid.eq(d(total));
  const cash = lines.find((l) => l.method === 'cash');
  const change = cash && isNum(recv) ? d(recv).minus(d(isNum(cash.amount) ? cash.amount : 0)) : null;
  const ok = exact && lines.every((l) => isNum(l.amount) && d(l.amount).gt(0)) && (kind !== 'full' || !!custId);
  const upd = (i: number, patch: Partial<PayLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const confirm = async () => {
    setBusy(true);
    try {
      await onPay({ docKind: kind, ...(custId ? { customerId: custId } : {}), payments: lines.map((l) => ({ method: l.method, amount: d(l.amount).toFixed(2) })) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="ชำระเงิน">
      <h3>ชำระเงิน ฿{fmt(total)}</h3>
      {vat ? (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>ประเภทเอกสาร</div>
          <div className="row">
            <label className="row"><input type="radio" name="inv" checked={kind === 'abb'} disabled={!abbAllowed} onChange={() => setKind('abb')} /> ใบกำกับภาษีอย่างย่อ</label>
            <label className="row"><input type="radio" name="inv" checked={kind === 'full'} onChange={() => setKind('full')} data-testid="kind-full" /> ใบกำกับภาษีเต็มรูป</label>
          </div>
          {!abbAllowed && <div className="note warn small" style={{ marginTop: 6 }} data-testid="abb-off">{abbNote}</div>}
          {kind === 'full' && (
            <label className="f" style={{ marginTop: 8 }}>ลูกค้า (ต้องมีเลขผู้เสียภาษี)
              <select value={custId} onChange={(e) => setCust(e.target.value)}>{custList.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.taxId}</option>)}</select>
            </label>
          )}
        </div>
      ) : (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>ประเภทเอกสาร</div>
          <b>ใบเสร็จรับเงิน</b> <span className="small muted">ร้านไม่จด VAT จึงไม่ออกใบกำกับภาษี</span>
          <label className="f" style={{ marginTop: 8 }}>ลูกค้า (ไม่บังคับ)
            <select value={custId} onChange={(e) => setCust(e.target.value)}><option value="">ลูกค้าทั่วไป</option>{custList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
        </div>
      )}
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>วิธีชำระ (บันทึกในระบบเท่านั้น ไม่เชื่อมลิ้นชักเงินหรือเครื่องรูดบัตร)</div>
        {lines.map((l, i) => (
          <div className="row" style={{ marginBottom: 6 }} key={i}>
            <select value={l.method} onChange={(e) => upd(i, { method: e.target.value as Method })} aria-label={`วิธีชำระ ${i + 1}`} data-testid={`pm-${i}`}>
              {(['cash', 'transfer', 'promptpay', 'card'] as Method[]).map((m) => <option key={m} value={m}>{METHOD_TH[m]}</option>)}
            </select>
            <input type="text" inputMode="decimal" value={l.amount} onChange={(e) => upd(i, { amount: e.target.value })} style={{ width: 140 }} aria-label={`จำนวนเงิน ${i + 1}`} data-testid={`pa-${i}`} />
            {lines.length > 1 && <button className="btn sm bad" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>ลบ</button>}
          </div>
        ))}
        <button className="btn sm" data-testid="add-pay" onClick={() => {
          const rest = d(total).minus(paid);
          setLines((ls) => [...ls, { method: 'transfer', amount: rest.gt(0) ? rest.toFixed(2) : '0' }]);
        }}>+ แยกชำระอีกวิธี</button>
        {cash && (
          <div className="row" style={{ marginTop: 8 }}>
            <label className="f">รับเงินสดมา<input type="text" inputMode="decimal" value={recv} placeholder={cash.amount} onChange={(e) => setRecv(e.target.value)} /></label>
            <div><div className="small muted">เงินทอน</div><b style={{ fontSize: 18 }}>{fmt(change && change.gt(0) ? change : 0)}</b></div>
          </div>
        )}
        {lines.some((l) => l.method === 'transfer' || l.method === 'promptpay') && <div className="note small" style={{ marginTop: 8 }}>ตรวจยอดเงินเข้าในแอปธนาคารของร้านก่อนกดยืนยัน</div>}
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span>รวมที่ชำระ <b>{fmt(paid)}</b></span>
        {exact ? <Pill k="ok">ยอดครบ</Pill> : <Pill k="bad">ยังขาด/เกิน {fmt(d(total).minus(paid))}</Pill>}
      </div>
      {err && <div className="note bad small" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>กลับไปแก้บิล</button>
        <button className="btn pri" onClick={() => void confirm()} disabled={!ok || busy} data-testid="pay-confirm">ยืนยันชำระและออกเอกสาร</button>
      </div>
    </Modal>
  );
}

function TodayBills() {
  const list = useQuery({ queryKey: ['today'], queryFn: () => api('GET', '/api/sales/docs', { query: { limit: 10 }, schema: page(DocSummary) }) });
  return (
    <div className="card">
      <h2>บิลล่าสุด <span className="small muted">พิมพ์ซ้ำ หรือยกเลิกบิลที่ออกผิด ที่หน้าเอกสารขาย</span></h2>
      <div className="tw">
        <table>
          <thead><tr><th>เลขที่</th><th>วันที่</th><th>ลูกค้า</th><th>สินค้า</th><th className="n">ยอด</th><th>สถานะ</th></tr></thead>
          <tbody>
            {(list.data?.items ?? []).map((x) => (
              <tr key={x.id} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
                <td className="mono"><Link to={`/sales/${encodeURIComponent(x.no)}`}>{x.no}</Link></td>
                <td>{th(x.date)}</td><td>{x.customer.name}</td><td className="small">{x.itemsPreview}</td>
                <td className="n">{x.status === 'void' ? <s>{fmt(x.total)}</s> : fmt(x.total)}</td>
                <td>{x.status === 'void' ? <Pill k="bad">ยกเลิก</Pill> : <Pill k="ok">ปกติ</Pill>}</td>
              </tr>
            ))}
            {list.data && !list.data.items.length && <tr><td colSpan={6} className="empty">ยังไม่มีบิล</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
