/** Detail pages of the B2B chain with their actions and A4 print layouts: quotation, sales order, delivery order, tax invoice. */
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SalesDelivery, SalesInvoice, SalesOrder, SalesProject, SalesQuote } from '@erp/contracts';
import { d } from '@erp/core';
import { ApiFail, api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useMeta } from '../../data';
import { fmt, fq, Modal, Pill, th, useToast } from '../../ui';
import { DeliveryModal, DocFormModal, InvoiceFromDeliveriesModal, KindPill } from './Forms';
import { ProjectSetupModal } from './Projects';
import { DocLink, DocLinks, RouteLink } from '../../doclink';
import {
  balPill, DLV_STATUS, METHOD_TH, Paper, PrintModal, priceSourceText, ProfitSummary, QT_STATUS, SOURCE_TH, StatusPill, taxRows, TERM_TH, SO_TERM_TH, useSalesInvalidate, VoidDocModal, VoidedNote, VoidPill,
} from './shared';

const Loading = () => <div className="card"><div className="sk" /><div className="sk" /><div className="sk" /></div>;
const Fail = ({ error }: { error: unknown }) => <div className="card"><div className="note bad">{errText(error)}</div><p><Link to="/b2b">‹ กลับไปเอกสารขายส่ง</Link></p></div>;
const Back = ({ tab }: { tab: string }) => <Link to={`/b2b?tab=${tab}`} className="btn sm">‹ กลับ</Link>;
const Refs = ({ items }: { items: { no: string; status: 'active' | 'void'; date?: string; to?: string; extra?: ReactNode }[] }) =>
  items.length ? <>{items.map((x, i) => <span key={x.no}>{i > 0 && ', '}<span className="mono" style={x.status === 'void' ? { textDecoration: 'line-through' } : undefined}>{x.to ? <RouteLink to={x.to}>{x.no}</RouteLink> : x.no}</span>{x.extra}</span>)}</> : <span className="muted">-</span>;

/** Purchase orders made from this document; each number links only when the role can open the purchasing screen. */
const PoRefs = ({ items }: { items: { no: string; status: string }[] }) =>
  <>{items.map((x, i) => <span key={x.no}>{i > 0 && ', '}<span className="mono" style={x.status === 'void' ? { textDecoration: 'line-through' } : undefined}><DocLink no={x.no} type="PO" /></span></span>)}</>;

// ---------- quotation ----------
export function QuoteDetail() {
  const { no = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const invalidate = useSalesInvalidate();
  const [m, setM] = useState<null | 'edit' | 'convert' | 'print' | 'void'>(null);
  const [err, setErr] = useState('');
  const q = useQuery({ queryKey: ['quote', no], queryFn: () => api('GET', `/api/sales/quotations/${encodeURIComponent(no)}`, { schema: SalesQuote }) });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Fail error={q.error} />;
  const x = q.data;
  const canDoc = can('sales.doc') === 1;
  const live = x.status !== 'void';
  const setStatus = async (status: string) => {
    setErr('');
    try {
      await api('POST', `/api/sales/quotations/${encodeURIComponent(no)}/status`, { body: { status } });
      await invalidate();
      toast('เปลี่ยนสถานะแล้ว');
    } catch (e) {
      setErr(errText(e));
    }
  };
  const free = x.lines.filter((l) => l.free).length;
  return (
    <>
      <div className="card">
        <h2>
          <span className="row"><Back tab="qt" /> ใบเสนอราคา <b className="mono" data-testid="doc-no">{x.no}</b> <StatusPill map={QT_STATUS} k={x.status} />{x.revision > 1 && <Pill k="mut">แก้ไขครั้งที่ {x.revision - 1}</Pill>}</span>
          <span className="actions">
            <button className="btn sm" onClick={() => setM('print')}>พิมพ์</button>
            {canDoc && x.editable && <button className="btn sm" onClick={() => setM('edit')} data-testid="qt-edit">แก้ไข</button>}
            {canDoc && live && x.editable && x.status !== 'sent' && x.status !== 'expired' && <button className="btn sm" onClick={() => void setStatus('sent')} data-testid="qt-sent">ส่งให้ลูกค้าแล้ว</button>}
            {canDoc && live && x.editable && x.status !== 'lost' && <button className="btn sm" onClick={() => void setStatus('lost')}>ไม่ได้งาน</button>}
            {canDoc && live && x.editable && ['draft', 'sent', 'accepted'].includes(x.status) && <button className="btn sm pri" onClick={() => setM('convert')} data-testid="qt-convert">แปลงเป็นใบสั่งขาย{free ? ' (ต้องผูกสินค้า)' : ''}</button>}
            {live && can('inv.receive') === 1 && x.lines.some((l) => !l.free) && <Link className="btn sm" to={`/purchasing?po=new&from=${encodeURIComponent(x.no)}`} data-testid="make-po">สร้างใบสั่งซื้อ (PO)</Link>}
            {!!can('sales.voidDoc') && live && <button className="btn sm bad" onClick={() => setM('void')} data-testid="void">ยกเลิก</button>}
          </span>
        </h2>
        <div className="kv">
          <span>ลูกค้า</span><span>{x.customer.name}{x.attn ? ` · เรียน ${x.attn}` : ''}</span>
          <span>วันที่ / ยืนราคาถึง</span><span>{th(x.date)} – {th(x.validUntil)}</span>
          <span>เงื่อนไขชำระ</span><span>{TERM_TH(x.term)}</span>
          <span>พนักงานขาย</span><span>{x.salesperson?.name ?? '-'}</span>
          <span>ใบสั่งขาย</span><span data-testid="qt-orders"><Refs items={x.orders.map((o) => ({ ...o, to: `/b2b/so/${encodeURIComponent(o.no)}` }))} /></span>
          {x.purchaseOrders.length > 0 && <><span>ใบสั่งซื้อ</span><span data-testid="doc-pos"><PoRefs items={x.purchaseOrders} /></span></>}
          <span>หมายเหตุ</span><span data-testid="doc-note-view">{x.note || <span className="muted">-</span>}</span>
        </div>
        {x.priceApproval && <div className="note small" style={{ marginTop: 10 }} data-testid="price-approval">อนุมัติราคา/ส่วนลด: {x.priceApproval.detail}</div>}
        {x.belowCostApproval && <div className="note warn small" style={{ marginTop: 6 }} data-testid="below-approval">{x.belowCostApproval.detail}</div>}
        {free > 0 && live && x.editable && <div className="note warn small" style={{ marginTop: 10 }}>มีรายการที่ยังไม่มีในระบบ {free} รายการ · ตอนแปลงเป็นใบสั่งขายต้องเลือกสินค้าในระบบให้ครบ (ถ้ายังไม่มี ให้เพิ่มสินค้าที่หน้า "สินค้าและหน่วยนับ" ก่อน)</div>}
        {err && <div className="err">{err}</div>}
        <VoidedNote v={x.voided} />
      </div>
      <div className="card">
        <h2>รายการ · ที่มาของราคา</h2>
        <LinesTable lines={x.lines} />
        <ProfitSummary profit={x.profit} />
      </div>
      <div className="card"><Paper {...quotePaper(x)} /></div>
      {m === 'edit' && <DocFormModal mode="QT" edit={x} onClose={() => setM(null)} />}
      {m === 'convert' && <DocFormModal mode="SO" quote={x} onClose={() => setM(null)} />}
      {m === 'print' && <PrintModal title={x.no} onClose={() => setM(null)}><Paper {...quotePaper(x)} /></PrintModal>}
      {m === 'void' && <VoidDocModal what={x.no} url={`/api/sales/quotations/${encodeURIComponent(x.no)}/void`} total={x.totals.total} onClose={() => setM(null)} onDone={() => void invalidate()} />}
    </>
  );
}

function quotePaper(x: SalesQuote) {
  return {
    title: 'ใบเสนอราคา', no: x.no, date: x.date, voided: x.status === 'void',
    party: { label: 'ลูกค้า', name: x.customer.name, tax: x.customer.taxId, br: x.customer.branch, tel: x.customer.phone },
    refs: [
      ...(x.attn ? [['เรียน', x.attn] as [string, ReactNode]] : []), ['ยืนราคาถึง', th(x.validUntil)], ['เงื่อนไขชำระ', TERM_TH(x.term)],
      ...(x.salesperson ? [['พนักงานขาย', `${x.salesperson.name}${x.salesperson.phone ? ` · โทร ${x.salesperson.phone}` : ''}`] as [string, ReactNode]] : []),
      ...(x.vatMode !== 'none' ? [['ราคาในเอกสาร', x.vatMode === 'exc' ? 'ไม่รวมภาษีมูลค่าเพิ่ม' : 'รวมภาษีมูลค่าเพิ่มแล้ว'] as [string, ReactNode]] : []),
    ] as [string, ReactNode][],
    cols: 'price' as const, rows: x.lines.map((l) => ({ name: <>{l.name}{l.free && <span className="pm"> (สั่งพิเศษ)</span>}{l.giveaway && ' (ของแถม)'}</>, qty: l.qty, unit: l.unitName, price: l.unitPrice, disc: l.discAmt, amt: l.net })),
    totals: taxRows(x.totals, x.vatMode), baht: x.totals.total, bank: true,
    note: [x.note, x.lines.some((l) => l.free) ? 'บางรายการสั่งพิเศษ ร้านจะยืนยันกำหนดส่งอีกครั้ง' : ''].filter(Boolean).join(' · ') || undefined,
    sign: [`ผู้เสนอราคา${x.salesperson ? ` (${x.salesperson.name})` : ''}`, 'ผู้อนุมัติ', 'ลูกค้าอนุมัติสั่งซื้อ', '@ตราประทับลูกค้า'],
  };
}

// ---------- sales order ----------
export function OrderDetail() {
  const { no = '' } = useParams();
  const { can } = useAuth();
  const invalidate = useSalesInvalidate();
  const [m, setM] = useState<null | 'deliver' | 'project' | 'print' | 'void'>(null);
  const q = useQuery({ queryKey: ['order', no], queryFn: () => api('GET', `/api/sales/orders/${encodeURIComponent(no)}`, { schema: SalesOrder }) });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Fail error={q.error} />;
  const x = q.data;
  const live = x.status === 'active';
  const canDeliver = can('sales.doc') === 1 || can('inv.receive') === 1;
  const seeCost = can('data.cost') === 1;
  return (
    <>
      <div className="card">
        <h2>
          <span className="row"><Back tab="so" /> ใบสั่งขาย <b className="mono" data-testid="doc-no">{x.no}</b> {live ? <StatusPill map={DLV_STATUS} k={x.dlvStatus} /> : <VoidPill />}</span>
          <span className="actions">
            <button className="btn sm" onClick={() => setM('print')}>พิมพ์</button>
            {live && canDeliver && x.dlvStatus !== 'delivered' && <button className="btn sm pri" onClick={() => setM('deliver')} data-testid="so-deliver">ออกใบส่งของ</button>}
            {live && !x.project && can('sales.project') === 1 && !x.invoices.some((i) => i.status === 'active') && <button className="btn sm" onClick={() => setM('project')} data-testid="so-make-project">ตั้งเป็นโครงการ</button>}
            {x.project && <RouteLink className="btn sm" to={`/projects/${x.project.id}`}>ดูโครงการ</RouteLink>}
            {live && can('inv.receive') === 1 && x.dlvStatus !== 'delivered' && <Link className="btn sm" to={`/purchasing?po=new&from=${encodeURIComponent(x.no)}`} data-testid="make-po">สร้างใบสั่งซื้อ (PO)</Link>}
            {live && !!can('sales.voidDoc') && <button className="btn sm bad" onClick={() => setM('void')} data-testid="void">ยกเลิก</button>}
          </span>
        </h2>
        <div className="kv">
          <span>ลูกค้า</span><span>{x.customer.name}</span>
          <span>วันที่</span><span>{th(x.date)}</span>
          <span>เงื่อนไขชำระ</span><span data-testid="so-terms"><KindPill kind={x.term.t === 'cash' ? 'cash' : 'credit'} /> {SO_TERM_TH(x.term)}</span>
          {x.quoteNo && <><span>จากใบเสนอราคา</span><span className="mono"><DocLink no={x.quoteNo} type="QT" /></span></>}
          {x.project && <><span>โครงการ</span><span><RouteLink to={`/projects/${x.project.id}`}>{x.project.name}</RouteLink> {x.project.isMain ? <Pill k="acc">สัญญางาน</Pill> : <Pill k="mut">งานเพิ่ม</Pill>}</span></>}
          {x.shipTo && <><span>ส่งที่</span><span>{x.shipTo}</span></>}
          <span>พนักงานขาย</span><span>{x.salesperson?.name ?? '-'}</span>
          <span>หมายเหตุ</span><span data-testid="doc-note-view">{x.note || <span className="muted">-</span>}</span>
          <span>ใบส่งของ</span><span><Refs items={x.deliveries.map((v) => ({ ...v, to: `/b2b/do/${encodeURIComponent(v.no)}`, extra: v.invoiceNo ? <span className="small muted"> → <DocLink no={v.invoiceNo} type="INV" /></span> : null }))} /></span>
          <span>ใบกำกับภาษี</span><span><Refs items={x.invoices.map((v) => ({ ...v, to: `/b2b/inv/${encodeURIComponent(v.no)}` }))} /></span>
          {x.purchaseOrders.length > 0 && <><span>ใบสั่งซื้อ</span><span data-testid="doc-pos"><PoRefs items={x.purchaseOrders} /></span></>}
        </div>
        {x.creditApproval && <div className="note small" style={{ marginTop: 10 }} data-testid="credit-approval">อนุมัติขายเชื่อ: {x.creditApproval.detail}</div>}
        {x.belowCostApproval && <div className="note warn small" style={{ marginTop: 6 }} data-testid="below-approval">{x.belowCostApproval.detail}</div>}
        {x.priceApproval && <div className="note small" style={{ marginTop: 6 }} data-testid="price-approval">อนุมัติราคา/ส่วนลด: {x.priceApproval.detail}</div>}
        <VoidedNote v={x.voided} />
      </div>
      <div className="card">
        <h2>รายการและยอดคงค้างส่ง</h2>
        <div className="tw">
          <table>
            <thead><tr><th>สินค้า</th><th className="n">สั่ง</th><th className="n">ราคา/หน่วย</th><th className="n">จำนวนเงิน</th>{seeCost && <th className="n">กำไร</th>}<th className="n">ส่งแล้ว</th><th className="n">ค้างส่ง</th></tr></thead>
            <tbody>
              {x.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}{l.giveaway && <> <Pill k="acc">ของแถม</Pill></>}<div className="small muted mono">{l.sku}</div></td><td className="n">{fq(l.qty)} {l.unitName}</td>
                  <td className="n">{fmt(l.unitPrice)}<PriceSrc l={l} /></td><td className="n">{fmt(l.net)}</td>
                  {seeCost && <td className="n"><Profit l={l} /></td>}
                  <td className="n">{fq(l.deliveredQty)}</td><td className="n">{d(l.remainingQty).gt(0) ? <b>{fq(l.remainingQty)}</b> : <Pill k="ok">ครบ</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tot" style={{ maxWidth: 360, marginLeft: 'auto' }}>
          {taxRows(x.totals, x.vatMode).map(([k, v, b]) => <TotLine key={k} k={k} v={v} b={b} />)}
        </div>
        <ProfitSummary profit={x.profit} />
      </div>
      {m === 'deliver' && <DeliveryModal initial={{ kind: 'SO', no: x.no }} onClose={() => setM(null)} />}
      {m === 'project' && <ProjectSetupModal so={x} onClose={() => setM(null)} />}
      {m === 'print' && <PrintModal title={x.no} onClose={() => setM(null)}><Paper {...orderPaper(x)} /></PrintModal>}
      {m === 'void' && <VoidDocModal what={x.no} url={`/api/sales/orders/${encodeURIComponent(x.no)}/void`} total={x.totals.total} onClose={() => setM(null)} onDone={() => void invalidate()} />}
    </>
  );
}
const PriceSrc = ({ l }: { l: SalesQuote['lines'][number] }) => {
  const t = priceSourceText(l.priceSource, l.priceRef);
  const lowered = l.listPrice != null && d(l.unitPrice).lt(d(l.listPrice));
  return t || lowered ? <div className="small muted">{t}{lowered ? ` · แก้จาก ${fmt(l.listPrice!)}` : ''}</div> : null;
};
const Profit = ({ l }: { l: SalesQuote['lines'][number] }) =>
  l.profit != null ? <><span className={d(l.profit).lt(0) ? 'bad-text' : ''}>{fmt(l.profit)}</span>{l.unitCost != null && <div className="small muted">ทุน {fmt(l.unitCost)}</div>}</> : <span className="muted">-</span>;

/** Internal view of quotation lines: price, BR-05 source, profit for data.cost users. */
function LinesTable({ lines }: { lines: SalesQuote['lines'] }) {
  const { can } = useAuth();
  const seeCost = can('data.cost') === 1;
  return (
    <div className="tw">
      <table data-testid="qt-lines">
        <thead><tr><th>รายการ</th><th className="n">จำนวน</th><th className="n">ราคา/หน่วย</th><th className="n">จำนวนเงิน</th>{seeCost && <th className="n">กำไร</th>}</tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>{l.name}{l.free && <> <Pill k="warn">นอกระบบ</Pill></>}{l.giveaway && <> <Pill k="acc">ของแถม</Pill></>}{l.sku && <div className="small muted mono">{l.sku}</div>}</td>
              <td className="n">{fq(l.qty)} {l.unitName}</td><td className="n">{fmt(l.unitPrice)}<PriceSrc l={l} /></td><td className="n">{fmt(l.net)}</td>
              {seeCost && <td className="n"><Profit l={l} /></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
const TotLine = ({ k, v, b }: { k: string; v: string; b?: boolean }) => <><span className={b ? '' : 'muted'} style={b ? { fontWeight: 600 } : undefined}>{k}</span><span className={b ? 'big' : ''}>{b ? `฿${v}` : v}</span></>;

function orderPaper(x: SalesOrder) {
  return {
    title: 'ใบสั่งขาย', no: x.no, date: x.date, voided: x.status === 'void',
    party: { label: 'ลูกค้า', name: x.customer.name, tax: x.customer.taxId, br: x.customer.branch, tel: x.customer.phone },
    refs: [...(x.quoteNo ? [['อ้างอิง', x.quoteNo]] : []), ['เงื่อนไขชำระ', SO_TERM_TH(x.term)], ...(x.project ? [['โครงการ', x.project.name]] : []), ...(x.shipTo ? [['ส่งที่', x.shipTo]] : []),
      ...(x.salesperson ? [['พนักงานขาย', x.salesperson.name]] : [])] as [string, ReactNode][],
    cols: 'price' as const, rows: x.lines.map((l) => ({ name: l.giveaway ? `${l.name} (ของแถม)` : l.name, qty: l.qty, unit: l.unitName, price: l.unitPrice, disc: l.discAmt, amt: l.net })),
    totals: taxRows(x.totals, x.vatMode), baht: x.totals.total, note: x.note || undefined, sign: ['ผู้รับคำสั่งซื้อ', 'ผู้อนุมัติ', 'ลูกค้า'],
  };
}

// ---------- delivery order ----------
export function DeliveryDetail() {
  const { no = '' } = useParams();
  const { can } = useAuth();
  const invalidate = useSalesInvalidate();
  const [m, setM] = useState<null | 'invoice' | 'print' | 'void'>(null);
  const q = useQuery({ queryKey: ['delivery', no], queryFn: () => api('GET', `/api/sales/deliveries/${encodeURIComponent(no)}`, { schema: SalesDelivery }) });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <Fail error={q.error} />;
  const x = q.data;
  const live = x.status === 'active';
  const billable = live && !!x.soNo && !x.project && !x.invoiceNos.length;
  return (
    <>
      <div className="card">
        <h2>
          <span className="row"><Back tab="do" /> ใบส่งของ <b className="mono" data-testid="doc-no">{x.no}</b> {!live ? <VoidPill /> : x.invoiceNos.length ? <Pill k="ok">ออกใบกำกับแล้ว</Pill> : billable ? <Pill k="warn">รอออกใบกำกับ</Pill> : <Pill k="mut">ส่งแล้ว</Pill>}</span>
          <span className="actions">
            <button className="btn sm" onClick={() => setM('print')}>พิมพ์</button>
            {billable && can('sales.doc') === 1 && <button className="btn sm pri" onClick={() => setM('invoice')} data-testid="do-invoice">ออกใบกำกับภาษี</button>}
            {live && !!can('sales.voidDoc') && <button className="btn sm bad" onClick={() => setM('void')} data-testid="void">ยกเลิก</button>}
          </span>
        </h2>
        <div className="kv">
          <span>ลูกค้า</span><span>{x.customer.name}</span>
          <span>วันที่</span><span>{th(x.date)}</span>
          <span>อ้างอิง</span><span className="mono">{x.soNo ? <DocLink no={x.soNo} type="SO" /> : x.invoiceNo ? <DocLink no={x.invoiceNo} type="INV" /> : '-'}</span>
          {x.project && <><span>โครงการ / หน้างาน</span><span><RouteLink to={`/projects/${x.project.id}`}>{x.project.name}</RouteLink>{x.project.site ? ` · ${x.project.site}` : ''}</span></>}
          <span>ส่งที่</span><span>{x.shipTo || '-'}</span>
          <span>รถ / คนขับ</span><span>{x.vehicle || '-'}</span>
          <span>หมายเหตุ</span><span data-testid="doc-note-view">{x.note || <span className="muted">-</span>}</span>
          <span>สต็อก</span><span>{x.cutsStock ? `ตัดสต็อก FIFO จาก ${x.warehouse?.name}` : 'ไม่ตัดสต็อก (ตัดแล้วตอนออกใบกำกับ)'}</span>
          <span>ใบกำกับภาษี</span><span><Refs items={x.invoiceNos.map((n) => ({ no: n, status: 'active' as const, to: `/b2b/inv/${encodeURIComponent(n)}` }))} /></span>
        </div>
        {x.project && <p className="small muted">ใบส่งของของโครงการไม่ออกใบกำกับแยกทีละรอบ แต่วางบิลตามงวดที่หน้าโครงการ</p>}
        <VoidedNote v={x.voided} />
      </div>
      <div className="card"><Paper {...deliveryPaper(x)} /></div>
      {m === 'invoice' && <InvoiceFromDeliveriesModal preselect={x.no} onClose={() => setM(null)} />}
      {m === 'print' && <PrintModal title={x.no} onClose={() => setM(null)}><Paper {...deliveryPaper(x)} /></PrintModal>}
      {m === 'void' && <VoidDocModal what={x.no} url={`/api/sales/deliveries/${encodeURIComponent(x.no)}/void`} onClose={() => setM(null)} onDone={() => void invalidate()} effects={x.cutsStock ? ['คืนสต็อกกลับเข้าล็อตเดิมตามต้นทุนเดิม'] : []} />}
    </>
  );
}

function deliveryPaper(x: SalesDelivery) {
  return {
    title: 'ใบส่งของ', no: x.no, date: x.date, voided: x.status === 'void',
    party: { label: 'ลูกค้า', name: x.customer.name, tel: x.customer.phone },
    refs: [['อ้างอิง', x.soNo ?? x.invoiceNo ?? '-'], ['ส่งที่', x.shipTo || (x.project?.site ?? '-')], ...(x.vehicle ? [['รถ / คนขับ', x.vehicle]] : [])] as [string, ReactNode][],
    cols: 'qty' as const, rows: x.lines.map((l) => ({ name: l.giveaway ? `${l.name} (ของแถม)` : l.name, qty: l.qty, unit: l.unitName })),
    note: [x.note, 'กรุณาตรวจนับสินค้าก่อนลงชื่อรับ'].filter(Boolean).join(' · '), sign: ['ผู้ส่งของ', 'ผู้รับของ'],
  };
}

// ---------- tax invoice ----------
export function InvoiceDetail() {
  const { no = '' } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const meta = useMeta();
  const invalidate = useSalesInvalidate();
  const [m, setM] = useState<null | 'print' | 'void' | 'deliver'>(null);
  const q = useQuery({ queryKey: ['invoice', no], queryFn: () => api('GET', `/api/sales/invoices/${encodeURIComponent(no)}`, { schema: SalesInvoice }), retry: false });
  if (q.isLoading) return <Loading />;
  // a POS full tax invoice has no B2B record: its document page is the core sales-document screen
  if (!q.data && q.error instanceof ApiFail && q.error.status === 404) return <Navigate to={`/sales/${encodeURIComponent(no)}`} replace />;
  if (!q.data) return <Fail error={q.error} />;
  const x = q.data;
  const live = x.doc.status === 'active';
  const left = Object.values(x.undelivered).some((v) => d(v).gt(0));
  const vatShop = meta.data?.shop.vatRegistered ?? true;
  return (
    <>
      <div className="card">
        <h2>
          <span className="row"><Back tab="inv" /> {vatShop ? 'ใบกำกับภาษี' : 'ใบแจ้งหนี้'} <b className="mono" data-testid="doc-no">{x.doc.no}</b> <KindPill kind={x.kind} /> {live ? balPill(x.arBalance) : <VoidPill />}</span>
          <span className="actions">
            <button className="btn sm" onClick={() => setM('print')}>พิมพ์</button>
            {live && d(x.arBalance).gt(0) && can('fin.ar') === 1 && <button className="btn sm pri" onClick={() => nav(`/ar?customer=${x.customer.id}&receive=1`)} data-testid="inv-receive">รับชำระ</button>}
            {live && x.goodsLeft && left && (can('sales.doc') === 1 || can('inv.receive') === 1) && <button className="btn sm" onClick={() => setM('deliver')}>ออกใบส่งของ (ของฝาก)</button>}
            {live && !!can('sales.voidDoc') && <button className="btn sm bad" onClick={() => setM('void')} data-testid="void">ยกเลิก</button>}
          </span>
        </h2>
        <div className="kv">
          <span>ลูกค้า</span><span>{x.customer.name}{x.customer.taxId ? ` · เลขผู้เสียภาษี ${x.customer.taxId}` : ''}</span>
          <span>วันที่</span><span>{th(x.doc.date)}</span>
          <span>ที่มา</span><span>{SOURCE_TH[x.source]}{x.doc.ref ? <> · อ้างอิง <span className="mono"><DocLink no={x.doc.ref} /></span></> : ''}</span>
          {x.kind === 'credit' && <><span>ครบกำหนด</span><span>{th(x.dueDate)} ({TERM_TH(x.term)})</span></>}
          <span>ยอดค้าง</span><span><b data-testid="inv-balance">{fmt(x.arBalance)}</b>{d(x.settled).gt(0) ? ` · รับชำระแล้ว ${fmt(x.settled)}` : ''}{d(x.credited).gt(0) ? ` · ลดหนี้ ${fmt(x.credited)}` : ''}</span>
          {x.deliveries.length > 0 && <><span>ใบส่งของ</span><span><Refs items={x.deliveries.map((n) => ({ no: n, status: 'active' as const, to: `/b2b/do/${encodeURIComponent(n)}` }))} /></span></>}
          {x.soNo && <><span>ใบสั่งขาย</span><span className="mono"><DocLink no={x.soNo} type="SO" /></span></>}
          {x.project && <><span>โครงการ</span><span><RouteLink to={`/projects/${x.project.id}`}>{x.project.name}</RouteLink>{x.installment ? ` · งวดที่ ${x.installment.n} (${x.installment.pct}%)` : ''}</span></>}
          <span>หมายเหตุ</span><span data-testid="doc-note-view">{x.note || <span className="muted">-</span>}</span>
          <span>ใบวางบิล</span><span><Refs items={x.billingNotes.map((v) => ({ ...v, to: `/ar/bn/${encodeURIComponent(v.no)}` }))} /></span>
          <span>ใบเสร็จรับเงิน</span><span><Refs items={x.receipts.map((v) => ({ ...v, to: `/ar/rc/${encodeURIComponent(v.no)}`, extra: <span className="small muted"> {fmt(v.settled)}</span> }))} /></span>
          <span>ใบลดหนี้</span><span><Refs items={x.creditNotes.map((v) => ({ ...v, to: `/sales/${encodeURIComponent(v.no)}`, extra: <span className="small muted"> {fmt(v.total)}{v.refund === 'credit' ? ' ลดหนี้' : ''}</span> }))} /></span>
          {x.laterDeliveries.length > 0 && <><span>ส่งของฝาก</span><span><Refs items={x.laterDeliveries.map((v) => ({ ...v, to: `/b2b/do/${encodeURIComponent(v.no)}` }))} /></span></>}
        </div>
        {x.goodsLeft && <div className="note small" style={{ marginTop: 10 }}>ลูกค้าฝากของไว้ที่ร้าน · คงเหลือที่ร้าน: {x.doc.lines.map((l) => `${l.name.split(' ')[0]} ${fq(x.undelivered[l.id] ?? '0')} ${l.unitName}`).join(', ')}</div>}
        <VoidedNote v={x.doc.voided} />
      </div>
      <div className="card"><Paper {...invoicePaper(x, vatShop)} /></div>
      {m === 'print' && <PrintModal title={x.doc.no} onClose={() => setM(null)}><Paper {...invoicePaper(x, vatShop)} /></PrintModal>}
      {m === 'deliver' && <DeliveryModal initial={{ kind: 'INV', no: x.doc.no }} onClose={() => setM(null)} />}
      {m === 'void' && (
        <VoidDocModal what={x.doc.no} url={`/api/sales/docs/${encodeURIComponent(x.doc.no)}/void`} total={x.doc.totals.total} onClose={() => setM(null)} onDone={() => void invalidate()}
          effects={['ต้องยกเลิกใบเสร็จรับเงิน ใบวางบิล และใบส่งของที่อ้างอิงก่อน', ...(x.source === 'direct' ? ['คืนสต็อกเข้าล็อตเดิมตามต้นทุนเดิม'] : []), 'ใบกำกับที่ยกเลิกต้องเก็บต้นฉบับและสำเนาไว้ครบชุด เลขที่เดิมไม่นำกลับมาใช้']} />
      )}
    </>
  );
}

export function invoicePaper(x: SalesInvoice, vatShop: boolean) {
  const nv = x.doc.vatMode === 'none' || !vatShop;
  const title = nv ? (x.kind === 'credit' ? 'ใบแจ้งหนี้' : 'ใบเสร็จรับเงิน') : x.kind === 'credit' ? 'ใบกำกับภาษี / ใบแจ้งหนี้' : 'ใบกำกับภาษี / ใบเสร็จรับเงิน';
  const rows = x.doc.lines.length
    ? x.doc.lines.map((l) => ({ name: l.free ? `${l.name} (ของแถม)` : l.name, qty: l.qty, unit: l.unitName, price: l.unitPrice, disc: l.discount, amt: l.net }))
    : x.textLines.map((t) => ({ name: t.name, qty: null, unit: '', price: null, amt: t.amount }));
  const totals = taxRows(x.doc.totals, nv ? 'none' : x.doc.vatMode);
  if (x.depositType === 'guarantee' && d(x.depositDeduct).gt(0)) totals.push(['หักเงินมัดจำ', `−${fmt(x.depositDeduct)}`], ['ยอดที่ต้องชำระ', fmt(d(x.doc.totals.total).minus(d(x.depositDeduct))), true]);
  return {
    title, sub: 'ต้นฉบับ', no: x.doc.no, date: x.doc.date, voided: x.doc.status === 'void',
    party: { label: 'ลูกค้า', name: x.customer.name, tax: x.customer.taxId, br: x.customer.branch, tel: x.customer.phone },
    refs: [
      ...(x.attn ? [['เรียน', x.attn]] : []), ...(x.doc.ref ? [['อ้างอิง', x.doc.ref]] : []), ...(x.deliveries.length ? [['ใบส่งของ', x.deliveries.join(', ')]] : []),
      ...(x.kind === 'credit' ? [['ครบกำหนดชำระ', `${th(x.dueDate)} (${TERM_TH(x.term)})`]] : [['ชำระโดย', x.doc.payments.map((p) => `${METHOD_TH[p.method] ?? p.method} ${fmt(p.amount)}`).join(' + ') || '-']]),
      ...(x.project ? [['โครงการ', x.project.name]] : []), ...(x.salesperson ? [['พนักงานขาย', x.salesperson.name]] : []),
    ] as [string, ReactNode][],
    cols: x.doc.lines.length ? ('price' as const) : ('amt' as const), rows, totals,
    baht: x.depositType === 'guarantee' && d(x.depositDeduct).gt(0) ? d(x.doc.totals.total).minus(d(x.depositDeduct)).toFixed(2) : x.doc.totals.total,
    bank: x.kind === 'credit', note: [x.doc.voided ? `ยกเลิก · ${x.doc.voided.reason}` : '', x.note].filter(Boolean).join(' · ') || undefined,
    sign: ['ผู้รับเงิน', 'ผู้รับสินค้า'],
  };
}

/** Small modal used by the project page to show a document quickly. */
export function QuickView({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <Modal onClose={onClose} wide label={title}><h3>{title}</h3>{children}<div className="act"><button className="btn pri" onClick={onClose}>ปิด</button></div></Modal>;
}
export type { SalesProject };
