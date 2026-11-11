/**
 * POS side of module C, used by pos/Pos.tsx: live promo and customer prices (BR-05 + M15), bundle sets (BR-17),
 * held bills (REQ-M07-08), uploaded product images (REQ-M07-11) and the machine's POS ID (REQ-M01-07).
 * Prices are computed with the same @erp/core rules the server uses, so the expected price never differs.
 */
import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HeldBill, PosDevice, PosPricing, ProductImage, page, type Product } from '@erp/contracts';
import { bundleAlloc, d, money, pickRetailListPrice, promoUnitPrice, resolvePrice, type DocLine as CoreLine } from '@erp/core';
import { api, errText } from '../../api';
import { fmt, fq, hm, Modal, Pill, SkeletonRows, useToast } from '../../ui';
import { ProductImg } from '../../pos/img';

export type Pricing = PosPricing;
export interface CartBundle { promoId: string; sets: string }
export interface HeldCartIn {
  lines: { productId: string; unitIdx: number; qty: string; dval: string; dmode: 'amt' | 'pct'; free?: boolean }[];
  bundles: CartBundle[]; billDiscount: string; customerId: string | null;
}

/** GET /api/pos/pricing for the POS warehouse and the bill's customer. */
export function usePosPricing(warehouseId: string | undefined, customerId: string | null) {
  return useQuery({
    queryKey: ['pos-pricing', warehouseId ?? null, customerId],
    enabled: !!warehouseId,
    queryFn: () => api('GET', '/api/pos/pricing', { query: { warehouseId, customerId: customerId ?? undefined }, schema: PosPricing }),
    staleTime: 30_000,
  });
}

const unitRetail = (p: Product, u: number): string => {
  const unit = p.units[u] ?? p.units[0]!;
  return money(unit.price != null ? d(unit.price) : d(p.price).times(d(unit.factor)));
};

export interface LinePrice { price: string; retail: string; promo: { id: string; name: string } | null; source: 'retail' | 'customer' | 'group' | 'promo' }

/** Expected unit price of a cart line, exactly as services/sales.ts → retailPosPricing derives it. */
export function linePrice(pr: Pricing | undefined, p: Product, unitIdx: number, qty: string): LinePrice {
  const retail = unitRetail(p, unitIdx);
  if (!pr) return { price: retail, retail, promo: null, source: 'retail' };
  const factor = (p.units[unitIdx] ?? p.units[0]!).factor;
  let best: { id: string; name: string; price: string } | null = null;
  for (const x of pr.promos) {
    if (!x.productIds.includes(p.id)) continue;
    const price = promoUnitPrice(x.mode, x.value, retail, factor);
    if (!best || d(price).lt(d(best.price))) best = { id: x.id, name: x.name, price };
  }
  const list = pickRetailListPrice(pr.prices.filter((e) => e.productId === p.id), unitIdx, /^\d+(\.\d+)?$/.test(qty) ? qty : '0');
  const r = resolvePrice({ retail, list, promo: best ? { id: best.id, price: best.price } : null });
  return { price: r.unitPrice, retail, promo: r.promoId && best ? { id: best.id, name: best.name } : null, source: r.source === 'quotation' ? 'retail' : r.source };
}

/** Live discount promo shown on a tile (retail customer, base unit). */
export const tilePromo = (pr: Pricing | undefined, p: Product) => {
  const lp = linePrice(pr ? { ...pr, prices: [] } : undefined, p, 0, '1');
  return lp.promo ? lp : null;
};

/** Core lines of a bundle in the cart: one per component at its pro-rata share (same as the server). */
export function bundleCoreLines(pr: Pricing | undefined, b: CartBundle, vatOf: (pid: string) => 'v7' | 'exempt'): CoreLine[] {
  const x = pr?.bundles.find((y) => y.id === b.promoId);
  if (!x || !/^\d+$/.test(b.sets) || !d(b.sets).gt(0)) return [];
  return bundleAlloc(x.components.map((c) => ({ productId: c.productId, qtyPerSet: c.qtyPerSet, normalPrice: c.normalPrice })), b.sets, x.setPrice)
    .map((a) => ({ qty: 1, unitPrice: a.amount, discount: null, vat: vatOf(a.productId) }));
}

// ---------- tiles ----------

export const PROMO_CAT = 'โปรโมชั่น';

const BUNDLE_SVG = '<rect x="18" y="30" width="40" height="34" rx="4" fill="#c9a46a"/><rect x="62" y="22" width="40" height="42" rx="4" fill="#dcd8cf" stroke="#b5b0a4"/><path d="M38 30V20M82 22V12" stroke="#d5664a" stroke-width="4"/><circle cx="60" cy="16" r="7" fill="#d5664a"/>';
export const BundleImg = () => <svg viewBox="0 0 120 80" role="img" aria-label="ชุดโปร" dangerouslySetInnerHTML={{ __html: BUNDLE_SVG }} />;

/** Uploaded image of a shop product when there is one, else the category illustration. */
export function PosImg({ p, version }: { p: Product; version?: number }) {
  const img = useQuery({
    queryKey: ['product-image', p.id, version],
    enabled: version != null && !p.isScg,
    queryFn: () => api('GET', `/api/product-images/${p.id}`, { query: { v: version }, schema: ProductImage }),
    staleTime: Infinity,
  });
  if (img.data) return <img src={`data:${img.data.mime};base64,${img.data.data}`} alt={p.name} />;
  return <ProductImg p={p} />;
}

export function BundleTiles({ pricing, q, onAdd }: { pricing: Pricing | undefined; q: string; onAdd: (id: string) => void }) {
  const term = q.trim().toLowerCase();
  const list = (pricing?.bundles ?? []).filter((b) => !term || b.name.toLowerCase().includes(term) || (b.sku ?? '').toLowerCase().includes(term));
  return (
    <>
      {list.map((b) => (
        <button key={b.id} className="tile" onClick={() => onAdd(b.id)} disabled={b.setsAvailable < 1} data-testid={`btile-${b.sku ?? b.code}`}>
          <span className="im"><BundleImg /></span>
          <span className="small muted mono">{b.sku ?? b.code} · ชุดโปร</span>
          <span className="nm">{b.name}</span>
          <span className="row" style={{ gap: 4 }}><Pill k="ok">ชุดโปร</Pill><span className="small muted">{b.setsAvailable > 0 ? `จัดได้ ${b.setsAvailable} ชุด` : 'ของในชุดไม่ครบ'}</span></span>
          <span className="pr">{fmt(b.setPrice)} <s className="small muted">{fmt(b.normalSetPrice)}</s></span>
        </button>
      ))}
    </>
  );
}

/** One bundle in the cart: name, components × sets, set price vs normal. */
export function BundleLine({ pricing, b, net, onSets, onRemove, testId }: {
  pricing: Pricing | undefined; b: CartBundle; net: string; onSets: (s: string) => void; onRemove: () => void; testId?: string;
}) {
  const x = pricing?.bundles.find((y) => y.id === b.promoId);
  if (!x) return <div className="cline"><div className="note warn small">ชุดโปรนี้หมดเวลาแล้ว ลบออกจากบิล</div><button className="btn sm bad" onClick={onRemove}>ลบ</button></div>;
  const n = /^\d+$/.test(b.sets) ? Number(b.sets) : 0;
  return (
    <div className="cline" data-testid={testId}>
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}><span className="thumb"><BundleImg /></span><span className="nm">{x.name}</span><Pill k="ok">ชุดโปร</Pill></div>
        <div className="small muted" style={{ margin: '4px 0' }}>{x.components.map((c) => `${c.name} × ${fq(d(c.qtyPerSet).times(n || 0))} ${c.unitName}`).join(' · ')}</div>
        <div className="ctl">
          <button className="qbtn" aria-label="ลดชุด" onClick={() => onSets(String(Math.max(1, n - 1)))}>−</button>
          <input className={`qty${n < 1 || n > x.setsAvailable ? ' bad' : ''}`} type="text" inputMode="numeric" value={b.sets} aria-label="จำนวนชุด" onChange={(e) => onSets(e.target.value)} />
          <button className="qbtn" aria-label="เพิ่มชุด" onClick={() => onSets(String(n + 1))}>+</button>
          <span className="small muted">@{fmt(x.setPrice)} <s>{fmt(x.normalSetPrice)}</s></span>
        </div>
        {n > x.setsAvailable && <div className="small" style={{ color: 'var(--bad)' }}>จัดได้ {x.setsAvailable} ชุด (ของในชุดไม่พอ)</div>}
      </div>
      <div style={{ textAlign: 'right' }}><b>{fmt(net)}</b><br /><button className="btn sm bad" onClick={onRemove}>ลบ</button></div>
    </div>
  );
}

// ---------- held bills ----------

export function HeldBar({ shiftId, canHold, onHold, onResume }: {
  shiftId: string; canHold: boolean; onHold: (label: string) => Promise<void>; onResume: (cart: HeldCartIn) => void;
}) {
  const [open, setOpen] = useState(false);
  const held = useQuery({
    queryKey: ['held', shiftId],
    queryFn: () => api('GET', '/api/pos/held', { query: { shiftId, limit: 20 }, schema: page(HeldBill) }),
  });
  const n = held.data?.items.length ?? 0;
  return (
    <>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn sm" disabled={!canHold} onClick={() => void onHold('')} data-testid="hold">พักบิล</button>
        <button className="btn sm" onClick={() => setOpen(true)} data-testid="held-open">บิลที่พักไว้{n ? ` (${n})` : ''}</button>
      </div>
      {open && <HeldModal shiftId={shiftId} onClose={() => setOpen(false)} onResume={(c) => { setOpen(false); onResume(c); }} />}
    </>
  );
}

function HeldModal({ shiftId, onClose, onResume }: { shiftId: string; onClose: () => void; onResume: (cart: HeldCartIn) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const held = useQuery({
    queryKey: ['held', shiftId],
    queryFn: () => api('GET', '/api/pos/held', { query: { shiftId, limit: 20 }, schema: page(HeldBill) }),
  });
  const act = async (id: string, what: 'resume' | 'discard') => {
    try {
      const h = await api('POST', `/api/pos/held/${id}/${what}`, { schema: HeldBill });
      await qc.invalidateQueries({ queryKey: ['held'] });
      if (what === 'resume') onResume(h.cart);
      else toast(`ทิ้งบิลพัก ${h.label} แล้ว`);
    } catch (e) {
      toast(errText(e));
    }
  };
  return (
    <Modal onClose={onClose} label="บิลที่พักไว้" wide>
      <h3>บิลที่พักไว้ในกะนี้</h3>
      <p className="small muted" style={{ margin: 0 }}>บิลพักยังไม่ตัดสต็อกและไม่จองคูปอง · เรียกกลับมาแล้วระบบคิดราคาและโปรใหม่ตอนชำระเงิน</p>
      <div className="tw">
        <table>
          <thead><tr><th>บิล</th><th>ลูกค้า</th><th className="n">รายการ</th><th className="n">ยอดตอนพัก</th><th>เวลา</th><th /></tr></thead>
          <tbody>
            {held.isLoading ? <SkeletonRows cols={6} rows={3} /> : (held.data?.items ?? []).map((h) => (
              <tr key={h.id}>
                <td>{h.label}<div className="small muted">{h.userName}</div></td>
                <td>{h.customer ?? 'ลูกค้าทั่วไป'}</td>
                <td className="n">{h.itemCount}</td>
                <td className="n">{fmt(h.total)}</td>
                <td>{hm(h.createdAt)}</td>
                <td><div className="row" style={{ flexWrap: 'nowrap' }}>
                  <button className="btn sm pri" onClick={() => void act(h.id, 'resume')} data-testid="held-resume">เรียกกลับ</button>
                  <button className="btn sm bad" onClick={() => void act(h.id, 'discard')}>ทิ้ง</button>
                </div></td>
              </tr>
            ))}
            {held.data && !held.data.items.length && <tr><td colSpan={6} className="empty">ไม่มีบิลที่พักไว้</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="act"><button className="btn" onClick={onClose}>ปิด</button></div>
    </Modal>
  );
}

export async function holdCart(shiftId: string, cart: HeldCartIn, total: string, label?: string): Promise<HeldBill> {
  return api('POST', '/api/pos/held', { body: { shiftId, ...(label ? { label } : {}), cart, total }, schema: HeldBill });
}

// ---------- POS machine (REQ-M01-07) ----------

/** Registered machines a shift may be opened on (retired ones excluded). */
export function useRegisteredDevices() {
  return useQuery({
    queryKey: ['pos-devices', 'open'],
    queryFn: async () => (await api('GET', '/api/pos-devices', { query: { limit: 100 }, schema: page(PosDevice) })).items.filter((x) => x.status !== 'retired'),
    staleTime: 60_000,
  });
}

/** Whether this machine may issue an ABB: true when the shop has no registry yet or the machine is approved. */
export function useAbbAllowed(deviceId: string | undefined): { allowed: boolean; posId: string | null; reason: ReactNode } {
  const devs = useQuery({
    queryKey: ['pos-devices'],
    queryFn: () => api('GET', '/api/pos-devices', { query: { limit: 100 }, schema: page(PosDevice) }),
    staleTime: 60_000,
  });
  const items = devs.data?.items ?? [];
  if (!items.length) return { allowed: true, posId: null, reason: null };
  const me = items.find((x) => x.code === deviceId);
  if (me?.canIssueAbb) return { allowed: true, posId: me.rdPosId, reason: null };
  return {
    allowed: false, posId: null,
    reason: <>เครื่อง {deviceId} {me ? (me.status === 'pending' ? 'ยังรออนุมัติ ภ.พ.06' : 'เลิกใช้แล้ว') : 'ยังไม่ได้ลงทะเบียน POS ID'} · ออกได้เฉพาะใบกำกับภาษีเต็มรูป</>,
  };
}
