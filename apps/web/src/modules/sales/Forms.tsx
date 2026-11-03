/** Create / edit modals of the B2B flow: quotation, sales order (with project options), direct invoice, delivery order, invoice from deliveries, full INV from an ABB. */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  SalesDelivery, SalesDeliverySource, SalesDeliverySummary, SalesInvoice, SalesOrder, SalesProjectSummary, SalesQuote, page, type SalesTerm,
} from '@erp/contracts';
import { d } from '@erp/core';
import { ApiFail, api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCustomers, useMeta, useWarehouses } from '../../data';
import { fmt, fq, Modal, Pill, ShortageModal, th, useToast, type Shortage } from '../../ui';
import {
  blankLine, CustomerSelect, LineEditor, lineReq, previewTotals, TERM_TH, useGatedSave, useSalesInvalidate, useSalesSettings, type EditLine,
} from './shared';

type Mode = 'QT' | 'SO' | 'INV';
const TEMPLATES = ['30/40/30', '50/50', '100%', 'custom'] as const;

/** Quotation, sales order or direct invoice (mockup qtModal). `quote` converts a quotation; `edit` revises one. */
export function DocFormModal({ mode, quote, edit, presetProject, newProject, onClose }: {
  mode: Mode; quote?: SalesQuote; edit?: SalesQuote; presetProject?: { id: string; customerId: string }; newProject?: boolean; onClose: () => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const meta = useMeta();
  const settings = useSalesSettings();
  const customers = useCustomers();
  const whs = useWarehouses();
  const src = edit ?? quote;
  const vatShop = meta.data?.shop.vatRegistered ?? true;
  const [customerId, setCustomerId] = useState(src?.customer.id ?? presetProject?.customerId ?? '');
  const [vatMode, setVatMode] = useState<'inc' | 'exc' | 'none'>(src?.vatMode ?? (vatShop ? meta.data?.shop.b2bVatMode ?? 'exc' : 'none'));
  const [attn, setAttn] = useState(src?.attn ?? '');
  const [note, setNote] = useState(edit?.note ?? '');
  const [validUntil, setValidUntil] = useState(edit?.validUntil ?? '');
  const [billDisc, setBillDisc] = useState(src?.billDiscount && d(src.billDiscount).gt(0) ? src.billDiscount : '');
  const [lines, setLines] = useState<EditLine[]>(() => src
    ? src.lines.map((l) => ({
      productId: l.productId ?? '', unitIdx: l.unitIdx ?? 0, name: l.name, unitName: l.unitName, qty: l.qty, unitPrice: l.unitPrice,
      discKind: l.discount?.kind ?? 'amt', discValue: l.discount?.value ?? '', vat: l.vat, free: !quote && !l.productId, quoteLineId: quote ? l.id : undefined, priceSource: quote ? `ราคาตาม ${quote.no}` : undefined,
    }))
    : [blankLine()]);
  const [warehouseId, setWarehouseId] = useState('');
  const [shipTo, setShipTo] = useState('');
  const [goodsLeft, setGoodsLeft] = useState(false);
  const [pay, setPay] = useState<'credit' | 'cash' | 'transfer'>('credit');
  const [pjMode, setPjMode] = useState<'' | 'new' | string>(presetProject ? presetProject.id : newProject ? 'new' : '');
  const [pjName, setPjName] = useState('');
  const [pjSite, setPjSite] = useState('');
  const [pjTpl, setPjTpl] = useState<(typeof TEMPLATES)[number]>('30/40/30');
  const [pjCustom, setPjCustom] = useState('40,30,30');
  const [short, setShort] = useState<Shortage[] | null>(null);
  const cust = customers.data?.find((c) => c.id === customerId);
  const credit = useQuery({
    queryKey: ['ar', 'credit', customerId], enabled: !!customerId && mode !== 'QT',
    queryFn: () => api<{ limit: string; balance: string; available: string | null; overdue: { no: string }[]; term: SalesTerm }>('GET', `/api/sales/customers/${customerId}/credit`),
  });
  const projects = useQuery({
    queryKey: ['projects', 'customer', customerId], enabled: mode === 'SO' && !!customerId,
    queryFn: () => api('GET', '/api/sales/projects', { query: { customerId, status: 'active', limit: 50 }, schema: page(SalesProjectSummary) }),
  });
  const stockWhs = (whs.data ?? []).filter((w) => w.active);
  const wh = warehouseId || stockWhs.find((w) => !w.isPos)?.id || stockWhs[0]?.id || '';
  const t = previewTotals(lines, vatMode, billDisc);
  const pcts = pjCustom.split(/[,\s/]+/).filter(Boolean);
  const pctSum = pcts.reduce((a, x) => a.plus(d(Number.isFinite(Number(x)) ? x : 0)), d(0));

  const body = (extra: Record<string, unknown>) => {
    const ls = lines.map(lineReq);
    const disc = billDisc && d(billDisc).gt(0) ? billDisc : '0';
    if (mode === 'QT') return { customerId, attn, note, vatMode: vatShop ? vatMode : undefined, validUntil: validUntil || undefined, billDiscount: disc, lines: ls, status: 'draft' };
    if (mode === 'SO') {
      const project = pjMode === 'new'
        ? { mode: 'new', name: pjName, site: pjSite, template: pjTpl, ...(pjTpl === 'custom' ? { installments: pcts.map((p) => ({ pct: p })) } : {}) }
        : pjMode ? { mode: 'existing', projectId: pjMode } : undefined;
      return { customerId, quoteNo: quote?.no, vatMode: vatShop && !quote ? vatMode : undefined, warehouseId: wh, shipTo, note, billDiscount: disc, lines: ls, project, ...extra };
    }
    const payments = pay === 'credit' ? undefined : [{ method: pay, amount: t.total }];
    return { source: 'direct', customerId, vatMode: vatShop ? vatMode : undefined, warehouseId: wh, goodsLeft, note, billDiscount: disc, lines: ls, payments, ...extra };
  };
  const save = useGatedSave(
    async (extra) => {
      if (!customerId) throw new ApiFail(400, 'VALIDATION', 'เลือกลูกค้าก่อน', null);
      if (mode === 'QT' && edit) return { kind: 'QT', no: (await api<SalesQuote>('PATCH', `/api/sales/quotations/${edit.no}`, { body: body(extra) })).no };
      if (mode === 'QT') return { kind: 'QT', no: (await api<SalesQuote>('POST', '/api/sales/quotations', { body: body(extra) })).no };
      if (mode === 'SO') return { kind: 'SO', no: (await api<SalesOrder>('POST', '/api/sales/orders', { body: body(extra) })).no };
      return { kind: 'INV', no: (await api<SalesInvoice>('POST', '/api/sales/invoices', { body: body(extra) })).doc.no };
    },
    async (r) => {
      await invalidate();
      toast(`${r.no} บันทึกแล้ว`);
      onClose();
      nav(`/b2b/${r.kind.toLowerCase()}/${encodeURIComponent(r.no)}`);
    },
    (e) => { if (e.code === 'INSUFFICIENT_STOCK') { setShort(e.details as Shortage[]); return true; } return false; },
  );
  const freeLeft = mode !== 'QT' && lines.some((l) => !l.productId);
  const title = mode === 'QT' ? (edit ? `แก้ไขใบเสนอราคา ${edit.no}` : 'สร้างใบเสนอราคา') : mode === 'SO' ? (quote ? `แปลง ${quote.no} เป็นใบสั่งขาย` : 'สร้างใบสั่งขาย') : 'ออกใบกำกับภาษี (ขายตรง)';
  return (
    <Modal onClose={onClose} wide label={title}>
      <h3>{title}</h3>
      <p className="small muted" style={{ margin: 0 }}>
        {mode === 'QT' && 'ใส่สินค้าที่ยังไม่มีในระบบได้ (พิมพ์รายการเอง) และไม่ตรวจต้นทุน จะผูกสินค้าและตรวจต้นทุนตอนแปลงเป็นใบสั่งขาย'}
        {mode === 'SO' && 'สร้างได้เลยโดยไม่ต้องมีใบเสนอราคา · ราคาต่อหน่วยต้องไม่ต่ำกว่าต้นทุน ถ้าต่ำกว่าต้องให้เจ้าของร้านอนุมัติ · ขายเชื่อเกินวงเงินหรือมีบิลเกินกำหนดต้องอนุมัติ'}
        {mode === 'INV' && 'ใบกำกับภาษีที่ตัดสต็อกทันที (ไม่ผ่านใบสั่งขาย) · ถ้าลูกค้าฝากของไว้ ออกใบส่งของภายหลังได้โดยไม่ตัดสต็อกซ้ำ'}
      </p>
      <div className="fgrid">
        <label className="f">ลูกค้า<CustomerSelect value={customerId} onChange={(id) => { setCustomerId(id); setPjMode((m) => (m === 'new' ? m : '')); }} noCash testId="doc-customer" /></label>
        {mode === 'QT' && <label className="f">เรียน (ผู้ติดต่อ)<input type="text" value={attn} onChange={(e) => setAttn(e.target.value)} placeholder="เช่น คุณอรุณ (หุ้นส่วนผู้จัดการ)" /></label>}
        {vatShop ? (
          <label className="f">ราคาในเอกสาร
            <select value={vatMode} onChange={(e) => setVatMode(e.target.value as 'inc' | 'exc')} disabled={!!quote}>
              <option value="exc">ไม่รวม VAT · บวก VAT 7% ท้ายเอกสาร</option><option value="inc">รวม VAT แล้ว</option>
            </select>
          </label>
        ) : <div><div className="small muted">ภาษี</div>ร้านไม่จด VAT · ไม่มีภาษีมูลค่าเพิ่ม</div>}
        {mode === 'QT' && <label className="f">ยืนราคาถึง (เว้นว่าง = {settings.data?.quoteValidDays ?? 15} วัน)<input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>}
        {mode !== 'QT' && (
          <label className="f">{mode === 'SO' ? 'ส่งของจากคลัง' : 'ตัดสต็อกจากคลัง'}
            <select value={wh} onChange={(e) => setWarehouseId(e.target.value)}>{stockWhs.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          </label>
        )}
        {mode === 'SO' && <label className="f">ที่อยู่ส่งของ / หน้างาน<input type="text" value={shipTo} onChange={(e) => setShipTo(e.target.value)} placeholder="ใช้ที่ตั้งโครงการถ้าเว้นว่าง" /></label>}
        {mode === 'INV' && (
          <label className="f">การชำระ
            <select value={pay} onChange={(e) => setPay(e.target.value as 'credit' | 'cash' | 'transfer')} data-testid="inv-pay">
              <option value="credit">เงินเชื่อ ({cust ? TERM_TH(cust.term as SalesTerm) : 'ตามเงื่อนไขลูกค้า'})</option><option value="cash">เงินสด (ชำระแล้ว)</option><option value="transfer">โอนเงิน (ชำระแล้ว)</option>
            </select>
          </label>
        )}
      </div>
      {mode === 'INV' && <label className="row small"><input type="checkbox" checked={goodsLeft} onChange={(e) => setGoodsLeft(e.target.checked)} /> ลูกค้าฝากของไว้ที่ร้าน (ส่งภายหลังด้วยใบส่งของ)</label>}
      {mode === 'SO' && (
        <>
          <label className="f">ประเภทการขาย
            <select value={pjMode} onChange={(e) => setPjMode(e.target.value)} data-testid="so-project">
              <option value="">ขายส่ง/เงินเชื่อทั่วไป</option>
              {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>เพิ่มเข้าโครงการเดิม (งานเพิ่ม): {p.name}</option>)}
              <option value="new">ขายโครงการ: สร้างโครงการ/หน้างานใหม่จากใบนี้</option>
            </select>
          </label>
          {pjMode === 'new' && (
            <>
              <div className="fgrid">
                <label className="f">ชื่อโครงการ / หน้างาน *<input type="text" value={pjName} onChange={(e) => setPjName(e.target.value)} placeholder="เช่น บ้านคุณสมชาย หมู่บ้านลานนา แปลง 5" data-testid="pj-name" /></label>
                <label className="f">ที่ตั้งหน้างาน (ใช้เป็นที่ส่งของ)<input type="text" value={pjSite} onChange={(e) => setPjSite(e.target.value)} /></label>
                <label className="f">รูปแบบงวดวางบิล
                  <select value={pjTpl} onChange={(e) => setPjTpl(e.target.value as (typeof TEMPLATES)[number])} data-testid="pj-template">
                    {TEMPLATES.map((x) => <option key={x} value={x}>{x === 'custom' ? 'กำหนดเอง' : x}</option>)}
                  </select>
                </label>
                {pjTpl === 'custom' && <label className="f">% แต่ละงวด (คั่นด้วยจุลภาค) <input type="text" value={pjCustom} onChange={(e) => setPjCustom(e.target.value)} /><span className={pctSum.eq(100) ? 'sum-ok' : 'sum-bad'}>รวม {fq(pctSum)}%{pctSum.eq(100) ? '' : ' (ต้องเท่ากับ 100%)'}</span></label>}
              </div>
              <div className="note small">บันทึกแล้วระบบสร้างโครงการจากใบสั่งขายนี้ (มูลค่าใบนี้ = มูลค่าสัญญา) และงวดวางบิลพร้อมวันครบกำหนด</div>
            </>
          )}
          {pjMode && pjMode !== 'new' && <div className="note small">มูลค่าใบนี้จะบวกเข้ามูลค่าโครงการเดิม และส่งของเข้าหน้างานเดียวกันได้</div>}
        </>
      )}
      <LineEditor lines={lines} setLines={setLines} customerId={customerId} vatMode={vatMode} allowFree={mode === 'QT'} />
      {freeLeft && <div className="note warn small">มีรายการที่ยังไม่มีในระบบ ต้องเลือกสินค้าในระบบให้ครบทุกแถวก่อนบันทึก (ใบสั่งขายตรวจต้นทุนและตัดสต็อก)</div>}
      {mode === 'QT' && <label className="f">หมายเหตุท้ายใบเสนอราคา<input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ราคานี้รวมค่าขนส่งในเขตอำเภอ · ส่งภายใน 3 วันหลังยืนยัน" /></label>}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <label className="f" style={{ maxWidth: 180 }}>ส่วนลดท้ายบิล (บาท)<input type="number" min="0" step="0.01" value={billDisc} onChange={(e) => setBillDisc(e.target.value)} /></label>
        <div className="tot" style={{ minWidth: 240 }}>
          <span className="muted">รวมหลังส่วนลด</span><span>{fmt(d(t.net).minus(d(billDisc || 0)))}</span>
          {vatMode !== 'none' && <><span className="muted">VAT 7%{vatMode === 'inc' ? ' (รวมในราคา)' : ''}</span><span>{fmt(t.vat)}</span></>}
          <span style={{ fontWeight: 600 }}>รวมทั้งสิ้น</span><span className="big" data-testid="doc-total">฿{fmt(t.total)}</span>
        </div>
      </div>
      {mode !== 'QT' && credit.data && cust && (
        <div className={`small ${credit.data.available != null && d(credit.data.balance).plus(d(t.total)).gt(d(credit.data.limit)) ? 'err' : 'muted'}`}>
          {TERM_TH(credit.data.term)} · วงเงิน {fmt(credit.data.limit)} · ค้างอยู่ {fmt(credit.data.balance)} · หลังบันทึกใบนี้ {fmt(d(credit.data.balance).plus(d(t.total)))}
          {credit.data.overdue.length > 0 && ` · มีบิลเกินกำหนด ${credit.data.overdue.length} ใบ`}
        </div>
      )}
      {save.err && <div className="err" role="alert">{save.err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={save.busy || !customerId || freeLeft || (pjMode === 'new' && (!pjName.trim() || (pjTpl === 'custom' && !pctSum.eq(100))))} onClick={() => void save.run()} data-testid="doc-save">
          {mode === 'QT' ? 'บันทึกใบเสนอราคา' : mode === 'SO' ? 'บันทึกใบสั่งขาย' : 'ออกใบกำกับภาษี'}
        </button>
      </div>
      {save.modal}
      {short && <ShortageModal shortages={short} onClose={() => setShort(null)} />}
    </Modal>
  );
}

/** Delivery order from a sales order or a goods-left invoice (mockup doModal). */
export function DeliveryModal({ initial, onClose }: { initial?: { kind: 'SO' | 'INV'; no: string }; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const whs = useWarehouses();
  const src = useQuery({ queryKey: ['dlv-src'], queryFn: () => api('GET', '/api/sales/delivery-sources', { query: { limit: 50 }, schema: page(SalesDeliverySource) }) });
  const [pick, setPick] = useState(initial ? `${initial.kind}:${initial.no}` : '');
  const s = src.data?.items.find((x) => `${x.kind}:${x.no}` === pick);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [warehouseId, setWarehouseId] = useState('');
  const [shipTo, setShipTo] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [short, setShort] = useState<Shortage[] | null>(null);
  useEffect(() => {
    if (!s) return;
    setQty(Object.fromEntries(s.lines.map((l) => [l.id, d(l.remaining).gt(0) ? l.remaining : '0'])));
    setShipTo(s.shipTo);
    setWarehouseId(s.warehouseId ?? '');
  }, [s?.no]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    if (!s) return;
    const lines = s.lines.filter((l) => qty[l.id] && d(qty[l.id]!).gt(0)).map((l) => ({ srcLineId: l.id, qty: qty[l.id]! }));
    if (!lines.length) return setErr('ใส่จำนวนที่ส่งรอบนี้อย่างน้อย 1 รายการ');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/sales/deliveries', { body: { [s.kind === 'SO' ? 'soNo' : 'invoiceNo']: s.no, warehouseId: s.kind === 'SO' ? warehouseId || undefined : undefined, shipTo, vehicle, lines }, schema: SalesDelivery });
      await invalidate();
      toast(`${r.no} ออกแล้ว${r.cutsStock ? ' · ตัดสต็อกแล้ว' : ''}`);
      onClose();
      nav(`/b2b/do/${encodeURIComponent(r.no)}`);
    } catch (e) {
      if (e instanceof ApiFail && e.code === 'INSUFFICIENT_STOCK') setShort(e.details as Shortage[]);
      else setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="สร้างใบส่งของ">
      <h3>สร้างใบส่งของ</h3>
      <p className="small muted" style={{ margin: 0 }}>อ้างอิงใบสั่งขายหรือบิลที่ลูกค้าฝากของไว้ แล้วใส่จำนวนที่ส่งรอบนี้ ส่งหลายรอบได้จนครบ</p>
      <label className="f">อ้างอิงใบขาย
        <select value={pick} onChange={(e) => setPick(e.target.value)} data-testid="dlv-source">
          <option value="">— เลือกใบขายที่ยังส่งไม่ครบ —</option>
          {(src.data?.items ?? []).map((x) => <option key={`${x.kind}:${x.no}`} value={`${x.kind}:${x.no}`}>{x.no} · {x.kind === 'SO' ? 'ใบสั่งขาย' : 'บิลฝากของ'} · {x.customer.name}{x.project ? ` · ${x.project.name}` : ''} · {th(x.date)}</option>)}
        </select>
      </label>
      {src.isLoading && <div className="sk" />}
      {s ? (
        <>
          <div className="tw">
            <table>
              <thead><tr><th>สินค้า</th><th className="n">ตามใบขาย</th><th className="n">ส่งแล้ว</th><th className="n">คงเหลือ</th><th className="n">ส่งรอบนี้</th></tr></thead>
              <tbody>
                {s.lines.map((l, i) => (
                  <tr key={l.id}>
                    <td>{l.name}</td><td className="n">{fq(l.qty)} {l.unitName}</td><td className="n">{fq(l.delivered)}</td><td className="n">{fq(l.remaining)}</td>
                    <td className="n"><input className={`qty${d(qty[l.id] || 0).gt(d(l.remaining)) ? ' bad' : ''}`} type="number" min="0" step="any" value={qty[l.id] ?? ''} disabled={!d(l.remaining).gt(0)} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} aria-label={`ส่งรอบนี้ ${l.name}`} data-testid={`dlv-qty-${i}`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fgrid">
            <label className="f">ส่งที่<input type="text" value={shipTo} onChange={(e) => setShipTo(e.target.value)} placeholder={s.project?.site || 'ที่อยู่ลูกค้า'} /></label>
            {s.kind === 'SO' && <label className="f">ตัดสต็อกจากคลัง<select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>{(whs.data ?? []).filter((w) => w.active).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>}
            <label className="f">ทะเบียนรถ / คนขับ<input type="text" value={vehicle} onChange={(e) => setVehicle(e.target.value)} placeholder="เช่น 3ฒก-4521 · ลุงแดง" /></label>
          </div>
          {s.kind === 'INV' && <div className="note small">บิลนี้ตัดสต็อกไปแล้วตอนขาย ใบส่งของนี้เป็นหลักฐานการส่งของ ไม่ตัดสต็อกซ้ำ</div>}
        </>
      ) : !src.isLoading && <div className="empty">เลือกใบขายที่ยังส่งไม่ครบจากรายการด้านบน</div>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={!s || busy} onClick={() => void go()} data-testid="dlv-save">ออกใบส่งของ</button></div>
      {short && <ShortageModal shortages={short} what="ใบส่งของ" onClose={() => setShort(null)} />}
    </Modal>
  );
}

/** Tax invoice from unbilled delivery orders of one customer (REQ-M08-05). */
export function InvoiceFromDeliveriesModal({ preselect, onClose }: { preselect?: string; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const list = useQuery({ queryKey: ['deliveries', 'unbilled'], queryFn: () => api('GET', '/api/sales/deliveries', { query: { status: 'unbilled', limit: 100 }, schema: page(SalesDeliverySummary) }) });
  const [sel, setSel] = useState<string[]>(preselect ? [preselect] : []);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const items = list.data?.items ?? [];
  const cust = items.find((x) => sel.includes(x.no))?.customer.id;
  const shown = cust ? items.filter((x) => x.customer.id === cust) : items;
  const total = items.filter((x) => sel.includes(x.no)).reduce((a, x) => a.plus(d(x.total)), d(0));
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/sales/invoices', { body: { source: 'delivery', deliveryNos: sel }, schema: SalesInvoice });
      await invalidate();
      toast(`${r.doc.no} ออกแล้ว · ครบกำหนด ${th(r.dueDate)}`);
      onClose();
      nav(`/b2b/inv/${encodeURIComponent(r.doc.no)}`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} wide label="ออกใบกำกับจากใบส่งของ">
      <h3>ออกใบกำกับภาษีจากใบส่งของ</h3>
      <p className="small muted" style={{ margin: 0 }}>รวมหลายใบส่งของของลูกค้าเดียวกันเป็นใบกำกับเดียวได้ · วันครบกำหนดคิดจากเงื่อนไขชำระ · เข้าลูกหนี้ทันที</p>
      <div className="tw">
        <table data-testid="unbilled-dos">
          <thead><tr><th /><th>ใบส่งของ</th><th>วันที่</th><th>ลูกค้า</th><th>ใบสั่งขาย</th><th>สินค้า</th><th className="n">มูลค่า</th></tr></thead>
          <tbody>
            {list.isLoading ? <tr><td colSpan={7}><div className="sk" /></td></tr> : shown.map((x) => (
              <tr key={x.id}>
                <td><input type="checkbox" checked={sel.includes(x.no)} onChange={(e) => setSel(e.target.checked ? [...sel, x.no] : sel.filter((n) => n !== x.no))} aria-label={`เลือก ${x.no}`} /></td>
                <td className="mono">{x.no}</td><td>{th(x.date)}</td><td>{x.customer.name}</td><td className="mono">{x.soNo}</td><td className="small">{x.itemsPreview}</td><td className="n">{fmt(x.total)}</td>
              </tr>
            ))}
            {!list.isLoading && !shown.length && <tr><td colSpan={7} className="empty">ไม่มีใบส่งของที่รอออกใบกำกับ</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="small muted">เลือก {sel.length} ใบ · มูลค่าตามใบส่งของ {fmt(total)} (ก่อน VAT เมื่อเอกสารราคาไม่รวม VAT) · ออกเป็นเงินเชื่อ รับชำระที่หน้าลูกหนี้</div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={!sel.length || busy} onClick={() => void go()} data-testid="inv-from-do-save">ออกใบกำกับภาษี</button></div>
    </Modal>
  );
}

/** Full tax invoice issued later for a POS abbreviated invoice. */
export function AbbInvoiceModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const { can } = useAuth();
  const [abbNo, setAbbNo] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/sales/invoices/from-abb', { body: { abbNo: abbNo.trim(), customerId }, schema: SalesInvoice });
      await invalidate();
      toast(`${r.doc.no} ออกแทน ${abbNo.trim()} แล้ว`);
      onClose();
      nav(`/b2b/inv/${encodeURIComponent(r.doc.no)}`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} label="ใบกำกับเต็มรูปจากใบกำกับอย่างย่อ">
      <h3>ออกใบกำกับภาษีเต็มรูปแทนใบกำกับอย่างย่อ</h3>
      <p className="small muted" style={{ margin: 0 }}>ลูกค้าขอใบกำกับเต็มรูปภายหลัง: ระบบยกเลิกใบกำกับอย่างย่อเดิม (ระบุเหตุผลอ้างเลขใบใหม่) และออกใบกำกับเต็มรูปที่อ้างอิงเลขเดิม สต็อกและยอดกะไม่เปลี่ยน</p>
      <label className="f">เลขที่ใบกำกับอย่างย่อ<input type="text" value={abbNo} onChange={(e) => setAbbNo(e.target.value)} placeholder="เช่น ABB2610-0012" data-testid="abb-no" /></label>
      <label className="f">ลูกค้า (ต้องมีเลขประจำตัวผู้เสียภาษี)<CustomerSelect value={customerId} onChange={setCustomerId} noCash testId="abb-customer" /></label>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={!abbNo.trim() || !customerId || busy || !(can('sales.doc') || can('pos.sell'))} onClick={() => void go()} data-testid="abb-save">ออกใบกำกับเต็มรูป</button></div>
    </Modal>
  );
}

export const KindPill = ({ kind }: { kind: 'credit' | 'cash' }) => (kind === 'credit' ? <Pill k="acc">เงินเชื่อ</Pill> : <Pill k="mut">เงินสด</Pill>);
