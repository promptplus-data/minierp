/** Shared pieces of the sales screens: settings, status pills, A4 paper (mockup drawPrint), line editor, void + approval flows. */
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SalesSettings, type SalesTerm } from '@erp/contracts';
import { bahtText, d, termLabel } from '@erp/core';
import { ApiFail, api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useCustomers } from '../../data';
import { ApprovalModal, fmt, fq, Modal, Pill, ReasonField, reasonInit, reasonText, th, thTime, useToast, type ApprovalInput } from '../../ui';
import './sales.css';

export const useSalesSettings = () => useQuery({ queryKey: ['sales-settings'], queryFn: () => api('GET', '/api/sales/settings', { schema: SalesSettings }), staleTime: 5 * 60_000 });

export const TERM_TH = (t: SalesTerm | null | undefined) => termLabel(t ?? { t: 'cash' });
export const QT_STATUS: Record<string, [string, 'ok' | 'warn' | 'bad' | 'acc' | 'mut']> = {
  draft: ['ร่าง', 'mut'], sent: ['ส่งแล้ว · รอลูกค้า', 'acc'], accepted: ['ลูกค้ายอมรับ', 'ok'], lost: ['ไม่ได้งาน', 'mut'], expired: ['หมดอายุ', 'warn'], void: ['ยกเลิก', 'bad'],
};
export const DLV_STATUS: Record<string, [string, 'ok' | 'warn' | 'mut']> = { open: ['รอส่ง', 'warn'], partial: ['ส่งบางส่วน', 'warn'], delivered: ['ส่งครบแล้ว', 'ok'] };
export const SOURCE_TH: Record<string, string> = { delivery: 'จากใบส่งของ', direct: 'ขายตรง', installment: 'งวดโครงการ', deposit: 'รับล่วงหน้า', forfeit: 'ริบมัดจำ', abb: 'แทนใบกำกับอย่างย่อ', pos: 'ขายเชื่อหน้าร้าน' };
export const METHOD_TH: Record<string, string> = { cash: 'เงินสด', transfer: 'โอนเงิน', cheque: 'เช็ค', promptpay: 'พร้อมเพย์', card: 'บัตร', credit: 'ลดหนี้' };

export const StatusPill = ({ map, k }: { map: Record<string, [string, 'ok' | 'warn' | 'bad' | 'acc' | 'mut']>; k: string }) => {
  const [t, c] = map[k] ?? [k, 'mut'];
  return <Pill k={c}>{t}</Pill>;
};
export const VoidPill = () => <Pill k="bad">ยกเลิก</Pill>;
export const balPill = (bal: string, overdue = 0) =>
  !d(bal).gt(0) ? <Pill k="ok">ชำระแล้ว</Pill> : overdue > 0 ? <Pill k="bad">ค้าง {fmt(bal)} · เกิน {overdue} วัน</Pill> : <Pill k="warn">ค้าง {fmt(bal)}</Pill>;

/** Reload every sales query after a mutation. */
export function useSalesInvalidate() {
  const qc = useQueryClient();
  return () => Promise.all(['quotes', 'quote', 'orders', 'order', 'deliveries', 'delivery', 'invoices', 'invoice', 'projects', 'project', 'ar', 'docs', 'doc', 'stock', 'dlv-src', 'credit-notes', 'price-lists']
    .map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

// ---------- A4 paper (mockup drawPrint) ----------
export interface PaperRow { name: ReactNode; desc?: string; qty?: string | null; unit?: string; price?: string | null; disc?: string | null; amt?: string | null; extra?: ReactNode }
export interface PaperProps {
  title: string; sub?: string; no: string; date: string; voided?: boolean;
  party?: { label: string; name: string; tax?: string | null; br?: string | null; tel?: string | null };
  refs?: [string, ReactNode][]; cols: 'price' | 'qty' | 'amt'; rows: PaperRow[]; extraCol?: string;
  totals?: [string, string, boolean?][]; baht?: string | null; note?: ReactNode; bank?: boolean; sign?: string[];
}

export function Paper(p: PaperProps) {
  const s = useSalesSettings().data;
  const shop = s?.shop;
  const disc = p.rows.some((r) => r.disc && d(r.disc).gt(0));
  return (
    <div className="tw">
      <div className="paper a4 print-area" data-testid="paper">
        {p.voided && <div className="voidmark">ยกเลิก</div>}
        <div className="ph">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
            <div className="plogo">{(shop?.name ?? '').replace(/^ร้าน/, '').slice(0, 1)}</div>
            <div>
              <b style={{ fontSize: 15 }}>{shop?.name}</b>
              <div>{shop?.address}</div>
              <div>{shop?.vatRegistered ? `เลขประจำตัวผู้เสียภาษี ${shop.taxId} · ${shop.branch} · ` : ''}โทร {shop?.phone}</div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <h4>{p.title}</h4>
            {p.sub && <div className="pm">{p.sub}</div>}
            <div>เลขที่ <b>{p.no}</b></div>
            <div>วันที่ {th(p.date)}</div>
          </div>
        </div>
        {(p.party || p.refs?.length) && (
          <div className="pgrid">
            {p.party && (
              <div>
                <span className="pm">{p.party.label}</span><br /><b>{p.party.name}</b>
                {p.party.tax && <><br />เลขผู้เสียภาษี {p.party.tax}{p.party.br ? ` สาขา ${p.party.br}` : ''}</>}
                {p.party.tel && <><br />โทร {p.party.tel}</>}
              </div>
            )}
            <div>{(p.refs ?? []).map(([k, v]) => <div key={k}><span className="pm">{k}</span> {v}</div>)}</div>
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>#</th><th>รายการ</th>
              {p.cols === 'amt' ? <th className="n">จำนวนเงิน</th> : <><th className="n">จำนวน</th><th>หน่วย</th></>}
              {p.cols === 'price' && <><th className="n">ราคา/หน่วย</th>{disc && <th className="n">ส่วนลด</th>}<th className="n">จำนวนเงิน</th></>}
              {p.extraCol && <th>{p.extraCol}</th>}
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>{r.name}{r.desc && <div className="pm">{r.desc}</div>}</td>
                {p.cols === 'amt' ? <td className="n">{r.amt != null ? (d(r.amt).lt(0) ? `−${fmt(d(r.amt).neg())}` : fmt(r.amt)) : ''}</td> : <><td className="n">{r.qty != null ? fq(r.qty) : ''}</td><td>{r.unit ?? ''}</td></>}
                {p.cols === 'price' && <><td className="n">{r.price != null ? fmt(r.price) : ''}</td>{disc && <td className="n">{r.disc && d(r.disc).gt(0) ? `−${fmt(r.disc)}` : ''}</td>}<td className="n">{r.amt != null ? fmt(r.amt) : ''}</td></>}
                {p.extraCol && <td>{r.extra}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        {p.totals && <div className="tots">{p.totals.map(([k, v, b]) => <TotRow key={k} k={k} v={v} b={b} />)}</div>}
        {p.baht && <div className="pbaht">({bahtText(p.baht)})</div>}
        {p.note && <div style={{ marginTop: 10 }}><span className="pm">หมายเหตุ</span> {p.note}</div>}
        {p.bank && !!s?.banks.length && (
          <div className="pbank"><b>ชำระเงินโดยโอนเข้าบัญชี</b>{s.banks.map((b) => <div key={b.account}>{b.bank} {b.branch} · เลขที่บัญชี <b>{b.account}</b> · ชื่อบัญชี {b.name}</div>)}</div>
        )}
        {p.sign && (
          <div className="sig">
            {p.sign.map((x) => x.startsWith('@')
              ? <div key={x} className="stampwrap"><div className="stamp">ตราประทับ</div><span className="pm">{x.slice(1)}</span></div>
              : <div key={x}>{x}<br /><span className="pm">วันที่ ____/____/______</span></div>)}
          </div>
        )}
      </div>
    </div>
  );
}
const TotRow = ({ k, v, b }: { k: string; v: string; b?: boolean }) => <><span>{b ? <b>{k}</b> : k}</span><span style={{ textAlign: 'right' }}>{b ? <b>{v}</b> : v}</span></>;

/** Tax rows under the lines (mockup taxRows). */
export function taxRows(t: { gross: string; lineDisc: string; billDisc: string; base7: string; exempt: string; vat: string; total: string }, mode: 'inc' | 'exc' | 'none'): [string, string, boolean?][] {
  const r: [string, string, boolean?][] = [['รวมเป็นเงิน', fmt(t.gross)]];
  if (d(t.lineDisc).gt(0)) r.push(['ส่วนลดรายการ', `−${fmt(t.lineDisc)}`]);
  if (d(t.billDisc).gt(0)) r.push(['ส่วนลดท้ายบิล', `−${fmt(t.billDisc)}`]);
  if (mode === 'none') r.push(['จำนวนเงินรวมทั้งสิ้น', fmt(t.total), true]);
  else {
    if (d(t.lineDisc).gt(0) || d(t.billDisc).gt(0)) r.push(['ราคาหลังหักส่วนลด', fmt(d(t.gross).minus(d(t.lineDisc)).minus(d(t.billDisc)))]);
    r.push(['มูลค่าที่คำนวณภาษี 7%', fmt(t.base7)]);
    if (d(t.exempt).gt(0)) r.push(['มูลค่ายกเว้นภาษี / อัตรา 0%', fmt(t.exempt)]);
    r.push(['ภาษีมูลค่าเพิ่ม 7%', fmt(t.vat)]);
    r.push(['จำนวนเงินรวมทั้งสิ้น', fmt(t.total), true]);
  }
  return r;
}

export function PrintModal({ onClose, children, title }: { onClose: () => void; children: ReactNode; title: string }) {
  return (
    <Modal onClose={onClose} wide label="ตัวอย่างก่อนพิมพ์">
      <h3>ตัวอย่างก่อนพิมพ์ · {title}</h3>
      {children}
      <div className="act"><button className="btn" onClick={onClose}>ปิด</button><button className="btn pri" onClick={() => window.print()}>พิมพ์ / บันทึก PDF</button></div>
    </Modal>
  );
}

// ---------- pickers ----------
export function CustomerSelect({ value, onChange, noCash, testId }: { value: string; onChange: (id: string) => void; noCash?: boolean; testId?: string }) {
  const cs = useCustomers();
  const list = (cs.data ?? []).filter((c) => !noCash || c.code !== 'C00000');
  return (
    <select name="customerId" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} aria-label="ลูกค้า">
      <option value="">— เลือกลูกค้า —</option>
      {list.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.code}{c.taxId ? '' : ' (ไม่มีเลขผู้เสียภาษี)'}</option>)}
    </select>
  );
}

// ---------- line editor (quotation / sales order / direct invoice) ----------
export interface EditLine { productId: string; unitIdx: number; name: string; unitName: string; qty: string; unitPrice: string; discKind: 'amt' | 'pct'; discValue: string; vat: 'v7' | 'exempt'; quoteLineId?: string; priceSource?: string; free?: boolean }
export const blankLine = (productId = ''): EditLine => ({ productId, unitIdx: 0, name: '', unitName: '', qty: '1', unitPrice: '', discKind: 'amt', discValue: '', vat: 'v7' });

export function lineNet(l: EditLine): string {
  const g = d(l.qty || 0).times(d(l.unitPrice || 0));
  const disc = !l.discValue ? d(0) : l.discKind === 'pct' ? g.times(d(l.discValue)).div(100) : d(l.discValue);
  return g.minus(disc.gt(g) ? g : disc).toFixed(2);
}

/** Totals preview; the server recomputes everything (calcDoc) when saving. */
export function previewTotals(lines: EditLine[], mode: 'inc' | 'exc' | 'none', billDisc: string) {
  const net = lines.reduce((a, l) => a.plus(d(lineNet(l))), d(0));
  const after = net.minus(d(billDisc || 0));
  const v7 = lines.reduce((a, l) => (l.vat === 'v7' ? a.plus(d(lineNet(l))) : a), d(0));
  const share = net.gt(0) ? v7.div(net).times(after) : d(0);
  const vat = mode === 'none' ? d(0) : mode === 'inc' ? share.times(7).div(107) : share.times('0.07');
  const total = mode === 'exc' ? after.plus(vat) : after;
  return { net: net.toFixed(2), vat: vat.toFixed(2), total: total.toFixed(2) };
}

export const lineReq = (l: EditLine) => ({
  ...(l.productId && !l.free ? { productId: l.productId, unitIdx: l.unitIdx } : { name: l.name, unitName: l.unitName || 'รายการ', vat: l.vat }),
  qty: l.qty || '0', unitPrice: l.unitPrice || '0', ...(l.discValue && d(l.discValue).gt(0) ? { discount: { kind: l.discKind, value: l.discValue } } : {}),
  ...(l.quoteLineId ? { quoteLineId: l.quoteLineId } : {}),
});

export function LineEditor({ lines, setLines, customerId, vatMode, allowFree, belowCost }: {
  lines: EditLine[]; setLines: (f: (ls: EditLine[]) => EditLine[]) => void; customerId: string; vatMode: 'inc' | 'exc' | 'none'; allowFree?: boolean; belowCost?: Set<string>;
}) {
  const cat = useCatalog();
  const products = useMemo(() => (cat.data ?? []).filter((p) => p.active), [cat.data]);
  const set = (i: number, patch: Partial<EditLine>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  /** BR-05: fetch the price for the customer whenever product / unit / qty changes and the user did not type a price. */
  const fetchPrice = async (i: number, l: EditLine) => {
    if (!l.productId) return;
    try {
      const r = await api<{ unitPrice: string; source: string; ref: string | null }>('GET', '/api/sales/price', { query: { customerId: customerId || undefined, productId: l.productId, unitIdx: l.unitIdx, qty: l.qty || '1', vatMode } });
      set(i, { unitPrice: r.unitPrice, priceSource: r.source === 'quote' ? `ราคาตาม ${r.ref}` : r.source === 'customerList' ? `ราคาลูกค้า ${r.ref}` : r.source === 'groupList' ? `ราคากลุ่ม ${r.ref}` : 'ราคาปลีก' });
    } catch {
      // keep the typed price
    }
  };
  const label = vatMode === 'exc' ? ' (ก่อน VAT)' : vatMode === 'inc' ? ' (รวม VAT)' : '';
  return (
    <>
      <div className="tw">
        <table className="lines" data-testid="line-editor">
          <thead><tr><th>สินค้า / รายการ</th><th>หน่วย</th><th className="n">จำนวน</th><th className="n">ราคา/หน่วย{label}</th><th className="n">ส่วนลด</th><th className="n">รวม</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const p = l.productId ? cat.byId.get(l.productId) : undefined;
              return (
                <tr key={i}>
                  <td>
                    {!(allowFree && l.free) ? (
                      <select data-field={`lines.${i}.productId`} value={l.productId} aria-label={`สินค้าแถว ${i + 1}`} data-testid={`line-product-${i}`} style={{ maxWidth: 260 }} onChange={(e) => {
                        if (e.target.value === '__free') return set(i, { productId: '', name: '', unitName: 'งาน', unitPrice: '0', free: true });
                        if (l.quoteLineId) return set(i, { productId: e.target.value, unitIdx: 0 }); // keep the quoted price
                        const nl = { ...l, productId: e.target.value, unitIdx: 0, unitPrice: '' };
                        set(i, nl);
                        void fetchPrice(i, nl);
                      }}>
                        <option value="">— เลือกสินค้า —</option>
                        {products.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.sku}</option>)}
                        {allowFree && <option value="__free">✎ พิมพ์รายการเอง (ยังไม่มีในระบบ)</option>}
                      </select>
                    ) : (
                      <>
                        <input type="text" data-field={`lines.${i}.name`} value={l.name} placeholder="พิมพ์ชื่อรายการ เช่น ประตูไม้สักบานคู่" aria-label={`ชื่อรายการแถว ${i + 1}`} data-testid={`line-name-${i}`} onChange={(e) => set(i, { name: e.target.value })} style={{ width: '100%', minWidth: 180 }} />
                        <div className="row small" style={{ gap: 6, marginTop: 4 }}>
                          <Pill k="warn">นอกระบบ · ไม่มีต้นทุน</Pill>
                          {vatMode !== 'none' && <select value={l.vat} onChange={(e) => set(i, { vat: e.target.value as 'v7' | 'exempt' })} aria-label="ภาษีรายการ"><option value="v7">VAT 7%</option><option value="exempt">ยกเว้น / 0%</option></select>}
                          <button className="btn sm" onClick={() => set(i, { productId: '', unitIdx: 0, free: false })}>เลือกจากสินค้าในระบบ</button>
                        </div>
                      </>
                    )}
                    {l.quoteLineId && <div className="small muted">จากใบเสนอราคา{!l.productId && l.name ? `: "${l.name}" · เลือกสินค้าในระบบที่ตรงกัน` : ''}</div>}
                  </td>
                  <td data-l="หน่วย">
                    {p && !l.free ? (
                      <select value={l.unitIdx} onChange={(e) => { const nl = { ...l, unitIdx: Number(e.target.value), unitPrice: '' }; set(i, nl); void fetchPrice(i, nl); }} aria-label="หน่วย">
                        {p.units.map((u, k) => <option key={k} value={k}>{u.name}</option>)}
                      </select>
                    ) : !l.free ? null : <input type="text" value={l.unitName} onChange={(e) => set(i, { unitName: e.target.value })} placeholder="หน่วย" style={{ width: 70 }} aria-label="หน่วย" />}
                  </td>
                  <td className="n" data-l="จำนวน"><input className="qty" type="number" min="0" step="any" data-field={`lines.${i}.qty`} value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} onBlur={() => { if (l.productId && !l.quoteLineId) void fetchPrice(i, l); }} aria-label={`จำนวนแถว ${i + 1}`} data-testid={`line-qty-${i}`} /></td>
                  <td className="n" data-l="ราคา/หน่วย">
                    <input className={`qty${belowCost?.has(l.productId) ? ' bad' : ''}`} type="number" min="0" step="0.01" data-field={`lines.${i}.unitPrice`} value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value, priceSource: 'แก้ราคาเอง' })} style={{ width: 96 }} aria-label={`ราคาแถว ${i + 1}`} data-testid={`line-price-${i}`} />
                    {l.priceSource && <div className="small muted">{l.priceSource}</div>}
                    {belowCost?.has(l.productId) && <div className="small" style={{ color: 'var(--bad)' }}>ต่ำกว่าทุน</div>}
                  </td>
                  <td className="n" data-l="ส่วนลด">
                    <span className="row" style={{ gap: 4, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                      <input className="qty" type="number" min="0" step="any" value={l.discValue} placeholder="0" style={{ width: 62 }} onChange={(e) => set(i, { discValue: e.target.value })} aria-label="ส่วนลดรายการ" />
                      <select value={l.discKind} onChange={(e) => set(i, { discKind: e.target.value as 'amt' | 'pct' })} aria-label="หน่วยส่วนลด"><option value="amt">บาท</option><option value="pct">%</option></select>
                    </span>
                  </td>
                  <td className="n" data-l="รวม">{fmt(lineNet(l))}</td>
                  <td><button className="btn sm bad" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))} aria-label={`ลบแถว ${i + 1}`} title="ลบแถว">✕</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="btn sm" onClick={() => setLines((ls) => [...ls, blankLine()])} data-testid="line-add">+ เพิ่มสินค้า</button>
        {allowFree && <button className="btn sm" onClick={() => setLines((ls) => [...ls, { ...blankLine(), unitName: 'งาน', unitPrice: '', free: true }])} data-testid="line-add-free">+ รายการพิมพ์เอง (ไม่มีในระบบ)</button>}
      </div>
    </>
  );
}

// ---------- approvals for BR-08 / BR-16 on save ----------
export type Gate = { kind: 'credit' | 'belowCost'; text: ReactNode } | null;

/**
 * Runs a save; when the server asks for a credit approval (BR-08, 403 need=creditApproval) or below-cost approval
 * (BR-16, 409 BELOW_COST) it opens the PIN modal and retries with the approval attached.
 */
export function useGatedSave<T>(save: (extra: Record<string, unknown>) => Promise<T>, onDone: (r: T) => void, onError?: (e: ApiFail) => boolean) {
  const [gate, setGate] = useState<{ kind: 'credit' | 'belowCost'; text: ReactNode; extra: Record<string, unknown> } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (extra: Record<string, unknown> = {}): Promise<string | null> => {
    setBusy(true);
    setErr('');
    try {
      const r = await save(extra);
      setGate(null);
      onDone(r);
      return null;
    } catch (e) {
      if (e instanceof ApiFail && e.detail('approvalError')) return e.message;
      if (e instanceof ApiFail && e.detail('need') === 'creditApproval') {
        e.claim();
        const x = e.details as { limit: string; balance: string; amount: string; after: string; over: boolean; overdue: { no: string; days: number }[] };
        setGate({
          kind: 'credit', extra,
          text: <div className="note bad" data-testid="credit-need">{x.over && <>วงเงิน {fmt(x.limit)} · ค้างอยู่ {fmt(x.balance)} · รวมใบนี้ {fmt(x.after)} บาท (เกินวงเงิน)<br /></>}{x.overdue.length > 0 && <>มีบิลเกินกำหนด {x.overdue.length} ใบ: {x.overdue.map((o) => `${o.no} (${o.days} วัน)`).join(', ')}</>}</div>,
        });
        return null;
      }
      if (e instanceof ApiFail && e.code === 'BELOW_COST') {
        e.claim();
        const lines = (e.detail<{ name: string; sell?: string; cost?: string }[]>('lines') ?? []);
        setGate({ kind: 'belowCost', extra, text: <div className="note bad">ขายต่ำกว่าทุน: {lines.map((l) => l.name + (l.sell ? ` (ขาย ${fmt(l.sell)} < ทุน ${fmt(l.cost!)})` : '')).join(', ')}</div> });
        return null;
      }
      setGate(null);
      if (!(e instanceof ApiFail && onError?.(e))) setErr(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const modal = gate && (
    <ApprovalModal ownerOnly={gate.kind === 'belowCost'} title={gate.kind === 'credit' ? 'เกินวงเงิน / มีบิลเกินกำหนด · ต้องอนุมัติ' : undefined} label={gate.text}
      onClose={() => setGate(null)} onSubmit={(a: ApprovalInput) => run({ ...gate.extra, [gate.kind === 'credit' ? 'creditApproval' : 'belowCostApproval']: a })} />
  );
  return { run, err, busy, modal, setErr };
}

// ---------- void with reason (+ PIN when the role has 'apv') ----------
export function VoidDocModal({ what, url, total, onClose, onDone, perm = 'sales.voidDoc', effects = [] }: {
  what: string; url: string; total?: string; onClose: () => void; onDone: () => void; perm?: 'sales.voidDoc' | 'fin.ar'; effects?: string[];
}) {
  const { can } = useAuth();
  const toast = useToast();
  const [reason, setReason] = useState(reasonInit('void'));
  const [err, setErr] = useState('');
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [apv, setApv] = useState(false);
  const needPin = perm === 'sales.voidDoc' && can('sales.voidDoc') === 'apv';
  const submit = async (a?: ApprovalInput): Promise<string | null> => {
    const r = reasonText(reason);
    if (r === null) { setErr('เลือก "อื่น ๆ" แล้ว ต้องพิมพ์เหตุผลก่อน'); return null; }
    try {
      await api('POST', url, { body: { reason: r, ...(a ?? {}) } });
      toast(`${what} ยกเลิกแล้ว`);
      onDone();
      onClose();
      return null;
    } catch (e) {
      if (e instanceof ApiFail && e.detail('approvalError')) return e.message;
      setApv(false);
      if (e instanceof ApiFail && e.code === 'DOWNSTREAM_FIRST' && e.claim()) setBlocked(e.detail<string[]>('docs') ?? []);
      else setErr(errText(e));
      return null;
    }
  };
  if (blocked) {
    return (
      <Modal onClose={onClose} label="ยกเลิกไม่ได้">
        <h3>ยกเลิก {what} ไม่ได้</h3>
        <div className="note bad" data-testid="downstream">ต้องยกเลิกเอกสารปลายทางก่อน (BR-22): {blocked.join(', ') || '-'}</div>
        <div className="act"><button className="btn pri" onClick={onClose}>ตกลง</button></div>
      </Modal>
    );
  }
  if (apv) return <ApprovalModal onClose={() => setApv(false)} onSubmit={submit} label={<p style={{ margin: 0 }}>"ยกเลิก {what}{total ? ` ฿${fmt(total)}` : ''}"</p>} />;
  return (
    <Modal onClose={onClose} label="ยกเลิกเอกสาร">
      <h3>ยกเลิก {what}</h3>
      <p className="small muted" style={{ margin: 0 }}>ระบบไม่ลบเอกสาร แต่ติดสถานะ "ยกเลิก" เลขที่เดิมไม่นำกลับมาใช้ และบันทึกผู้ยกเลิก เวลา เหตุผล</p>
      {effects.length > 0 && <div className="note small">{effects.map((x) => <div key={x}>• {x}</div>)}</div>}
      <ReasonField kind="void" value={reason} onChange={setReason} testId="void-reason" />
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ไม่ยกเลิก</button>
        <button className="btn bad" data-testid="void-ok" onClick={() => (needPin ? (reasonText(reason) === null ? setErr('ต้องพิมพ์เหตุผล') : setApv(true)) : void submit())}>ยืนยันยกเลิก{needPin ? ' (ขออนุมัติ)' : ''}</button>
      </div>
    </Modal>
  );
}

export const VoidedNote = ({ v }: { v: { by: string; at: string; reason: string } | null }) =>
  v ? <div className="note bad small" style={{ marginTop: 12 }} data-testid="voided">ยกเลิกโดย {v.by} เมื่อ {thTime(v.at)} · เหตุผล: {v.reason}</div> : null;


/** Quotation validity, default credit limit and the bank accounts printed on quotations / invoices / billing notes (REQ-M08-08). */
export function SalesSettingsModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const s = useSalesSettings();
  const [days, setDays] = useState<string | null>(null);
  const [limit, setLimit] = useState<string | null>(null);
  const [banks, setBanks] = useState<SalesSettings['banks'] | null>(null);
  const [err, setErr] = useState('');
  if (!s.data) return <Modal onClose={onClose} label="ตั้งค่าเอกสารขาย"><div className="sk" /></Modal>;
  const bs = banks ?? s.data.banks;
  const setB = (i: number, patch: Partial<SalesSettings['banks'][number]>) => setBanks(bs.map((b, k) => (k === i ? { ...b, ...patch } : b)));
  const go = async () => {
    setErr('');
    try {
      await api('PATCH', '/api/sales/settings', { body: { quoteValidDays: Number(days ?? s.data!.quoteValidDays), defaultCreditLimit: limit ?? s.data!.defaultCreditLimit, banks: bs.filter((b) => b.bank.trim() && b.account.trim()) } });
      await qc.invalidateQueries({ queryKey: ['sales-settings'] });
      toast('บันทึกการตั้งค่าแล้ว');
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <Modal onClose={onClose} wide label="ตั้งค่าเอกสารขาย">
      <h3>ตั้งค่าเอกสารขาย</h3>
      <div className="fgrid">
        <label className="f">ยืนราคาใบเสนอราคา (วัน)<input type="number" min="1" max="365" value={days ?? s.data.quoteValidDays} onChange={(e) => setDays(e.target.value)} /></label>
        <label className="f">วงเงินเครดิตเริ่มต้น (บาท)<input type="number" min="0" step="0.01" value={limit ?? s.data.defaultCreditLimit} onChange={(e) => setLimit(e.target.value)} /></label>
      </div>
      <b className="small">บัญชีธนาคารรับโอน (พิมพ์ท้ายใบเสนอราคา ใบกำกับเงินเชื่อ ใบวางบิล)</b>
      <div className="tw">
        <table>
          <thead><tr><th>ธนาคาร</th><th>สาขา</th><th>เลขที่บัญชี</th><th>ชื่อบัญชี</th><th /></tr></thead>
          <tbody>
            {bs.map((b, i) => (
              <tr key={i}>
                <td><input type="text" value={b.bank} onChange={(e) => setB(i, { bank: e.target.value })} aria-label="ธนาคาร" /></td>
                <td><input type="text" value={b.branch} onChange={(e) => setB(i, { branch: e.target.value })} aria-label="สาขา" /></td>
                <td><input type="text" value={b.account} onChange={(e) => setB(i, { account: e.target.value })} aria-label="เลขที่บัญชี" /></td>
                <td><input type="text" value={b.name} onChange={(e) => setB(i, { name: e.target.value })} aria-label="ชื่อบัญชี" /></td>
                <td><button className="btn sm bad" onClick={() => setBanks(bs.filter((_, k) => k !== i))} aria-label="ลบบัญชี">✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {bs.length < 6 && <div><button className="btn sm" onClick={() => setBanks([...bs, { bank: '', branch: '', account: '', name: s.data!.shop.name }])}>+ เพิ่มบัญชี</button></div>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" onClick={() => void go()}>บันทึก</button></div>
    </Modal>
  );
}
