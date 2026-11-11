/**
 * ใบสั่งซื้อ (PO): list (search, status, lazy 20), create form (blank or from a QT / SO with the shortfall prefilled),
 * detail with A4 print, รับของตาม PO (the manual receipt form against the PO), close (short shipment) and void.
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PoPrefill, PoSummary, PurchaseOrder, type PoStatus, type Product } from '@erp/contracts';
import { calcDoc, d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useMeta, useWarehouses } from '../../data';
import { DocLink } from '../../doclink';
import { checkFields, ErrorBanner, qtyMsg } from '../../errors';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { NoteField, NoteText } from '../../ui/NoteField';
import { ProductPicker } from '../../ui/ProductPicker';
import { VendorPicker } from '../../ui/VendorPicker';
import { ReceiptModal } from '../../stock/forms';
import { fmt, fq, Modal, Pill, SkeletonRows, th, useDebounced, useToast } from '../../ui';
import { Paper, PrintModal, taxRows } from '../sales/shared';
import { ReasonModal } from './shared';
import './purchasing.css';

export const PO_STATUS: Record<PoStatus, [string, 'ok' | 'warn' | 'bad' | 'acc' | 'mut']> = {
  open: ['รอรับของ', 'warn'], partial: ['รับบางส่วน', 'acc'], received: ['รับครบ', 'ok'], closed: ['ปิดแล้ว', 'mut'], void: ['ยกเลิก', 'bad'],
};
export const PoPill = ({ s }: { s: PoStatus }) => <Pill k={PO_STATUS[s][1]}>{PO_STATUS[s][0]}</Pill>;
const VAT_TH = { exc: 'ราคาไม่รวม VAT', inc: 'ราคารวม VAT แล้ว', none: 'ไม่มี VAT' } as const;
const isStock = (p: Product) => p.kind === 'stock' && p.active;
const isNum = (s: string) => /^\d+(\.\d+)?$/.test(s.trim());
const enc = encodeURIComponent;

// ---------- list ----------
export function PoList({ onNew }: { onNew?: () => void }) {
  const whs = useWarehouses();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('pending');
  const dq = useDebounced(q.trim());
  const r = useLoadMore(['pu', 'pos'], '/api/purchase-orders', PoSummary, { q: dq, status }, 20);
  const loading = r.isLoading;
  return (
    <div className="card" data-testid="po-card">
      <h2><span>ใบสั่งซื้อ (PO)</span>{onNew && <button className="btn sm pri" onClick={onNew} data-testid="po-new">+ สร้างใบสั่งซื้อ</button>}</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" placeholder="ค้นหาเลขที่ ผู้ขาย สินค้า อ้างอิง หรือ SO/QT" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหาใบสั่งซื้อ" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="สถานะใบสั่งซื้อ" data-testid="po-status">
          <option value="pending">ค้างรับ (รอรับ + รับบางส่วน)</option>
          <option value="">ทุกสถานะ</option>
          {(Object.keys(PO_STATUS) as PoStatus[]).map((k) => <option key={k} value={k}>{PO_STATUS[k][0]}</option>)}
        </select>
      </div>
      {r.isError && <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      <div className="tw">
        <table data-testid="po-table">
          <thead><tr><th>เลขที่</th><th>วันที่ / กำหนดรับ</th><th>ผู้ขาย</th><th className="pu-hide-sm">สินค้า</th><th className="n">ยอด</th><th>สถานะ</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} rows={3} /> : r.rows.map((x) => (
              <tr key={x.id}>
                <td className="mono"><DocLink no={x.no} type="PO" />{x.sourceNo && <div className="small muted">จาก <DocLink no={x.sourceNo} /></div>}</td>
                <td>{th(x.date)}{x.expectedDate && <div className="small muted">รับ {th(x.expectedDate)}</div>}</td>
                <td className="pu-cell-wrap">{x.vendorName}<div className="small muted">{whs.data?.find((w) => w.id === x.warehouseId)?.name}{x.vendorRef ? ` · ${x.vendorRef}` : ''}</div></td>
                <td className="pu-cell-wrap small pu-hide-sm">{x.itemsPreview}{x.note && <div className="muted">หมายเหตุ: {x.note}</div>}</td>
                <td className="n">{x.total != null ? fmt(x.total) : '-'}</td>
                <td><PoPill s={x.status} /></td>
              </tr>
            ))}
            {!loading && !r.rows.length && <tr><td colSpan={6} className="empty">ไม่มีใบสั่งซื้อ{status ? 'ในสถานะนี้' : ''}</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="pos-more" />
    </div>
  );
}

// ---------- form ----------
interface FLine {
  pid: string; u: number; q: string; cost: string; disc: string; sourceLineId?: string; ordered?: string; avail?: string; onOrder?: string; unitName?: string;
  /** Source lines: ticked = saved (default when the suggested qty is above 0). */
  on?: boolean;
  /** ของแถมตามเงื่อนไขผู้ขาย: cost 0. */
  free?: boolean;
}
const blank = (): FLine => ({ pid: '', u: 0, q: '1', cost: '0', disc: '' });
/** "10%" → 10 percent, "50" → 50 baht, "" → none. */
const parseDisc = (s: string): { kind: 'pct' | 'amt'; value: string } | null | 'bad' => {
  const t = s.trim().replace(/\s/g, '');
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)(%?)$/.exec(t);
  if (!m) return 'bad';
  if (m[2] && Number(m[1]) > 100) return 'bad';
  return { kind: m[2] ? 'pct' : 'amt', value: m[1]! };
};

/** New purchase order; `fromNo` = QT… / SO… to prefill the stock lines with what is short. */
export function PoFormModal({ fromNo, onClose, onSaved }: { fromNo?: string | null; onClose: () => void; onSaved: (no: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useMeta();
  const whs = useWarehouses();
  const cat = useCatalog();
  const vatShop = meta.data?.shop.vatRegistered ?? true;
  const active = (whs.data ?? []).filter((w) => w.active && w.kind !== 'damaged');
  const [vendor, setVendor] = useState<string | null>(null);
  const [wh, setWh] = useState('');
  const [expected, setExpected] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [vatMode, setVatMode] = useState<'exc' | 'inc' | 'none'>(vatShop ? 'exc' : 'none');
  const [lines, setLines] = useState<FLine[]>(fromNo ? [] : [blank()]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const whId = wh || active.find((w) => !w.isPos)?.id || active[0]?.id || '';
  const pf = useQuery({
    queryKey: ['pu', 'po-prefill', fromNo, wh],
    enabled: !!fromNo,
    queryFn: () => api('GET', `/api/purchase-orders/prefill/${enc(fromNo!)}`, { query: { warehouseId: wh || undefined }, schema: PoPrefill }),
  });
  useEffect(() => {
    if (!pf.data) return;
    if (!wh) setWh(pf.data.warehouseId);
    setVatMode(pf.data.vatMode);
    setLines(pf.data.lines.map((l) => ({
      pid: l.productId, u: l.unitIdx, q: l.qty, cost: l.unitCost ?? '0', disc: '', sourceLineId: l.sourceLineId, ordered: l.orderedQty, avail: l.availableQty,
      onOrder: l.onOrderQty, unitName: l.unitName, on: d(l.qty).gt(0),
    })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pf.data]);
  const update = (i: number, patch: Partial<FLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const ticked = (l: FLine) => !l.sourceLineId || l.on === true;
  const counted = lines.filter((l) => l.pid && ticked(l) && isNum(l.q) && d(l.q).gt(0));
  const srcLines = lines.filter((l) => l.sourceLineId);
  const allOn = srcLines.length > 0 && srcLines.every((l) => l.on);
  const totals = calcDoc(counted.map((l) => {
    const disc = parseDisc(l.disc);
    return { qty: l.q, unitPrice: l.free ? '0' : isNum(l.cost) ? l.cost : '0', discount: disc === 'bad' || l.free ? null : disc, vat: cat.byId.get(l.pid)?.vat ?? 'v7' };
  }), vatShop ? vatMode : 'none', 0);
  const net = (l: FLine) => {
    if (l.free || !isNum(l.q) || !isNum(l.cost)) return d(0);
    const disc = parseDisc(l.disc);
    return calcDoc([{ qty: l.q, unitPrice: l.cost, discount: disc === 'bad' ? null : disc, vat: 'v7' }], 'none', 0).lines[0]!.net;
  };

  const save = async () => {
    if (!counted.length) return setErr(fromNo ? 'ไม่มีรายการที่จะสั่งซื้อ · ติ๊กเลือกรายการและใส่จำนวนมากกว่า 0 หรือเพิ่มสินค้า' : 'เลือกสินค้าอย่างน้อย 1 รายการ');
    if (!checkFields({
      vendorId: !vendor && 'เลือกผู้ขาย',
      ...Object.fromEntries(lines.flatMap((l, i) => (l.pid && ticked(l) ? [
        [`lines.${i}.qty`, qtyMsg(l.q)], [`lines.${i}.unitCost`, !l.free && !isNum(l.cost) && 'ราคาต้องเป็นตัวเลข'], [`lines.${i}.discount`, !l.free && parseDisc(l.disc) === 'bad' && 'ส่วนลด เช่น 10% หรือ 50'],
      ] : []))),
    })) return;
    setBusy(true);
    setErr('');
    try {
      const res = await api('POST', '/api/purchase-orders', {
        body: {
          vendorId: vendor, warehouseId: whId, expectedDate: expected || null, vendorRef: ref.trim(), note: note.trim(), vatMode: vatShop ? vatMode : undefined,
          sourceNo: fromNo ?? undefined,
          lines: counted.map((l) => {
            const disc = parseDisc(l.disc);
            return l.free
              ? { productId: l.pid, unitIdx: l.u, qty: l.q.trim(), unitCost: '0', free: true, sourceLineId: l.sourceLineId }
              : { productId: l.pid, unitIdx: l.u, qty: l.q.trim(), unitCost: l.cost.trim(), discount: disc && disc !== 'bad' ? disc : undefined, sourceLineId: l.sourceLineId };
          }),
        },
        schema: PurchaseOrder,
      });
      await qc.invalidateQueries({ queryKey: ['pu'] });
      await Promise.all(['order', 'quote'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast(`บันทึกใบสั่งซื้อ ${res.no} แล้ว`);
      onSaved(res.no);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const fromSrc = !!fromNo;
  return (
    <Modal onClose={onClose} wide label="สร้างใบสั่งซื้อ">
      <h3>สร้างใบสั่งซื้อ (PO){fromNo && <> · จาก <span className="mono" data-testid="po-from">{fromNo}</span></>}</h3>
      {fromNo && <p className="small muted" style={{ margin: 0 }}>
        ระบบใส่จำนวนที่ขาด = สั่งขาย − พร้อมขายในคลังที่เลือก − สั่งแล้ว (ค้างรับ) (ไม่ต่ำกว่า 0) · แก้จำนวนได้ · ข้ามรายการบริการและรายการนอกระบบ{pf.data?.skipped ? ` (${pf.data.skipped} รายการ)` : ''}
      </p>}
      {fromNo && <p className="note small" style={{ margin: '6px 0' }} data-testid="po-partial-hint">
        ติ๊กเฉพาะรายการที่จะสั่งกับผู้ขายนี้ · รายการหรือจำนวนที่เหลือสั่งภายหลังได้ หรือสร้างใบสั่งซื้ออีกใบกับผู้ขายรายอื่น — ระบบจะหักยอดที่สั่งไปแล้วให้
      </p>}
      {pf.isError && <ErrorBanner error={pf.error} onRetry={() => void pf.refetch()} retrying={pf.isFetching} />}
      <div className="fgrid">
        <label className="f">ผู้ขาย *<VendorPicker value={vendor} onChange={(id) => setVendor(id)} testId="po-vendor" invalid={!!err && !vendor} /></label>
        <label className="f">รับเข้าคลัง<select name="warehouseId" value={whId} onChange={(e) => setWh(e.target.value)} data-testid="po-wh">{active.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label className="f">กำหนดรับของ<input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} data-testid="po-expected" /></label>
        <label className="f">อ้างอิงผู้ขาย (เลขใบเสนอราคา / ผู้ติดต่อ)<input type="text" value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} data-testid="po-ref" /></label>
        {vatShop && <label className="f">ราคาในเอกสาร<select value={vatMode} onChange={(e) => setVatMode(e.target.value as 'exc' | 'inc')} data-testid="po-vat"><option value="exc">ไม่รวม VAT</option><option value="inc">รวม VAT แล้ว</option></select></label>}
      </div>
      <div className="tw">
        <table data-testid="po-lines">
          <thead><tr>
            {fromSrc && <th><input type="checkbox" checked={allOn} aria-label="เลือกทุกรายการ" data-testid="po-all" onChange={(e) => setLines((ls) => ls.map((l) => (l.sourceLineId ? { ...l, on: e.target.checked } : l)))} /></th>}
            <th>สินค้า</th><th>หน่วย</th>{fromSrc && <><th className="n">สั่งขาย</th><th className="n">พร้อมขาย</th><th className="n">สั่งแล้ว (ค้างรับ)</th></>}<th className="n">จำนวนสั่งซื้อ</th><th className="n">ราคา/หน่วย</th><th className="n">ส่วนลด</th><th className="n">รวม</th><th>ของแถม</th><th />
          </tr></thead>
          <tbody>
            {fromNo && pf.isLoading && <SkeletonRows cols={12} rows={2} />}
            {lines.map((l, i) => {
              const p = cat.byId.get(l.pid);
              return (
                <tr key={i} className={l.sourceLineId && !l.on ? 'muted' : undefined} data-testid={`po-row${i}`}>
                  {fromSrc && <td>{l.sourceLineId && <input type="checkbox" checked={!!l.on} aria-label={`เลือกแถว ${i + 1}`} data-testid={`po-on${i}`} onChange={(e) => update(i, { on: e.target.checked })} />}</td>}
                  <td>
                    {l.sourceLineId ? <>{p?.name ?? '…'}<div className="small muted mono">{p?.sku}</div></> : (
                      <ProductPicker value={l.pid || null} warehouseId={whId} filter={isStock} ariaLabel={`สินค้าแถว ${i + 1}`} testId={`po-p${i}`} style={{ minWidth: 220 }}
                        onChange={(id, np) => update(i, { pid: id ?? '', u: 0, cost: np?.cost ?? l.cost })} />
                    )}
                  </td>
                  <td>{p ? (l.sourceLineId ? l.unitName : <select value={l.u} aria-label="หน่วย" onChange={(e) => update(i, { u: Number(e.target.value) })}>{p.units.map((u, k) => <option key={k} value={k}>{u.name}</option>)}</select>) : '-'}</td>
                  {fromSrc && <><td className="n">{l.ordered ? fq(l.ordered) : '-'}</td><td className="n">{l.avail != null ? <span className={d(l.avail).lt(0) ? 'bad-text' : ''}>{fq(l.avail)}</span> : '-'}</td>
                    <td className="n" data-testid={`po-onorder${i}`}>{l.onOrder != null ? fq(l.onOrder) : '-'}</td></>}
                  <td className="n"><input className="qty" type="text" inputMode="decimal" data-field={`lines.${i}.qty`} value={l.q} aria-label={`จำนวนสั่งซื้อแถว ${i + 1}`} onChange={(e) => update(i, { q: e.target.value })} data-testid={`po-q${i}`} /></td>
                  <td className="n"><input className="qty" type="text" inputMode="decimal" data-field={`lines.${i}.unitCost`} value={l.free ? '0' : l.cost} disabled={l.free} style={{ width: 96 }} aria-label={`ราคาแถว ${i + 1}`} onChange={(e) => update(i, { cost: e.target.value })} data-testid={`po-c${i}`} /></td>
                  <td className="n"><input className="qty" type="text" data-field={`lines.${i}.discount`} value={l.free ? '' : l.disc} disabled={l.free} style={{ width: 70 }} placeholder="10% / 50" aria-label={`ส่วนลดแถว ${i + 1}`} onChange={(e) => update(i, { disc: e.target.value })} /></td>
                  <td className="n">{l.free ? <Pill k="acc">ของแถม</Pill> : fmt(net(l))}</td>
                  <td><input type="checkbox" checked={!!l.free} aria-label={`ของแถมแถว ${i + 1}`} title="ของแถมตามเงื่อนไขผู้ขาย (ราคา 0)" data-testid={`po-free${i}`} onChange={(e) => update(i, { free: e.target.checked })} /></td>
                  <td><button className="btn sm bad" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`ลบแถว ${i + 1}`} data-testid={`po-del${i}`}>ลบ</button></td>
                </tr>
              );
            })}
            {!pf.isLoading && !lines.length && <tr><td colSpan={12} className="empty">ไม่มีรายการสินค้า{fromNo ? 'ที่เป็นสินค้าสต็อกในเอกสารนี้' : ''}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="row"><button className="btn sm" onClick={() => setLines((ls) => [...ls, blank()])} data-testid="po-add">+ เพิ่มสินค้า</button><span className="small muted" data-testid="po-count">{counted.length} รายการจะถูกบันทึก{fromSrc ? ' · รายการที่ไม่ได้ติ๊กหรือจำนวน 0 ไม่บันทึก' : ''}</span></div>
      <NoteField value={note} onChange={setNote} testId="po-note" placeholder="เช่น ส่งก่อน 10 โมง / โทรหาก่อนส่ง" />
      <div className="tot" style={{ maxWidth: 360, marginLeft: 'auto' }}>
        {taxRows({ ...totals, billDisc: '0' }, vatShop ? vatMode : 'none').map(([k, v, b]) => <TotLine key={k} k={k} v={v} b={b} />)}
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={busy || (!!fromNo && pf.isLoading)} onClick={() => void save()} data-testid="po-save">บันทึกใบสั่งซื้อ</button>
      </div>
    </Modal>
  );
}
const TotLine = ({ k, v, b }: { k: string; v: string; b?: boolean }) => <><span className={b ? '' : 'muted'} style={b ? { fontWeight: 600 } : undefined}>{k}</span><span className={b ? 'big' : ''}>{b ? `฿${v}` : v}</span></>;

// ---------- detail ----------
export function PoDetailPage() {
  const { no = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [m, setM] = useState<null | 'print' | 'receive' | 'close' | 'void'>(null);
  const q = useQuery({ queryKey: ['pu', 'po', no], queryFn: () => api('GET', `/api/purchase-orders/${enc(no)}`, { schema: PurchaseOrder }) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['pu'] }), qc.invalidateQueries({ queryKey: ['stock'] })]);
  if (q.isLoading) return <div className="card"><div className="sk" /><div className="sk" /><div className="sk" /></div>;
  if (q.isError || !q.data) return <div className="card"><ErrorBanner error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /><p><Link to="/purchasing">‹ กลับไปหน้าซื้อเข้า</Link></p></div>;
  const x = q.data;
  const canAct = can('inv.receive') === 1;
  const pending = x.status === 'open' || x.status === 'partial';
  const activeGr = x.receipts.filter((r) => r.status === 'active');
  return (
    <>
      <div className="card">
        <h2>
          <span className="row"><Link to="/purchasing" className="btn sm">‹ กลับ</Link> ใบสั่งซื้อ <b className="mono" data-testid="doc-no">{x.no}</b> <span data-testid="po-status-pill"><PoPill s={x.status} /></span></span>
          <span className="actions">
            <button className="btn sm" onClick={() => setM('print')}>พิมพ์</button>
            {canAct && pending && <button className="btn sm pri" onClick={() => setM('receive')} data-testid="po-receive">รับของตาม PO</button>}
            {canAct && pending && <button className="btn sm" onClick={() => setM('close')} data-testid="po-close">ปิดใบสั่งซื้อ (ส่งไม่ครบ)</button>}
            {canAct && x.status !== 'void' && !activeGr.length && <button className="btn sm bad" onClick={() => setM('void')} data-testid="void">ยกเลิก</button>}
          </span>
        </h2>
        <div className="kv">
          <span>ผู้ขาย</span><span>{x.vendor.name}{x.vendor.phone ? ` · โทร ${x.vendor.phone}` : ''}</span>
          <span>วันที่ / กำหนดรับ</span><span>{th(x.date)}{x.expectedDate ? ` – ${th(x.expectedDate)}` : ''}</span>
          <span>รับเข้าคลัง</span><span>{x.warehouseName}</span>
          {x.vendorRef && <><span>อ้างอิงผู้ขาย</span><span>{x.vendorRef}</span></>}
          {x.source && <><span>ที่มา</span><span data-testid="po-source">จาก <span className="mono"><DocLink no={x.source.no} type={x.source.type} /></span></span></>}
          <span>ใบรับสินค้า</span><span className="mono" data-testid="po-receipts">{x.receipts.length ? x.receipts.map((r, i) => <span key={r.no}>{i > 0 && ', '}<span style={r.status === 'void' ? { textDecoration: 'line-through' } : undefined}><DocLink no={r.no} type="GR" /></span></span>) : <span className="muted">-</span>}</span>
          {x.receipts.filter((r) => r.overReceiveNote && r.status === 'active').map((r) => (
            <Fragment key={r.no}><span>รับเกิน ({r.no})</span><span className="small" data-testid="po-over-note">หมายเหตุ: {r.overReceiveNote}</span></Fragment>
          ))}
          <span>หมายเหตุ</span><NoteText note={x.note} dash />
          <span>สร้างโดย</span><span>{x.createdBy}</span>
        </div>
        {x.closed && <div className="note small" style={{ marginTop: 10 }} data-testid="po-closed">ปิดโดย {x.closed.by} · เหตุผล: {x.closed.reason}</div>}
        {x.voided && <div className="note bad small" style={{ marginTop: 10 }} data-testid="voided">ยกเลิกโดย {x.voided.by} · เหตุผล: {x.voided.reason}</div>}
      </div>
      <div className="card">
        <h2>รายการและยอดค้างรับ</h2>
        <div className="tw">
          <table data-testid="po-detail-lines">
            <thead><tr><th>สินค้า</th><th className="n">สั่ง</th>{x.totals && <><th className="n">ราคา/หน่วย</th><th className="n">จำนวนเงิน</th></>}<th className="n">รับแล้ว</th><th className="n">ค้างรับ</th></tr></thead>
            <tbody>
              {x.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}{l.free && <> <Pill k="acc">ของแถม</Pill></>}<div className="small muted mono">{l.sku}{l.sourceQty ? ` · ลูกค้าสั่ง ${fq(l.sourceQty)}` : ''}</div></td>
                  <td className="n">{fq(l.qty)} {l.unitName}</td>
                  {x.totals && <><td className="n">{l.unitCost != null ? fmt(l.unitCost) : '-'}{l.discAmt && d(l.discAmt).gt(0) ? <div className="small muted">ลด {fmt(l.discAmt)}</div> : null}</td><td className="n">{l.net != null ? fmt(l.net) : '-'}</td></>}
                  <td className="n">{fq(l.receivedQty)}{d(l.overQty).gt(0) && <div data-testid="po-over-pill"><Pill k="warn">รับเกิน +{fq(l.overQty)}</Pill></div>}</td>
                  <td className="n">{d(l.remainingQty).gt(0) ? <b>{fq(l.remainingQty)}</b> : <Pill k="ok">ครบ</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {x.totals && <div className="tot" style={{ maxWidth: 360, marginLeft: 'auto' }}>{taxRows(x.totals, x.vatMode).map(([k, v, b]) => <TotLine key={k} k={k} v={v} b={b} />)}</div>}
      </div>
      <div className="card"><Paper {...poPaper(x)} /></div>
      {m === 'print' && <PrintModal title={x.no} onClose={() => setM(null)}><Paper {...poPaper(x)} /></PrintModal>}
      {m === 'receive' && <ReceiptModal po={x} onClose={() => { setM(null); void refresh(); }} />}
      {m === 'close' && <ReasonModal title={`ปิดใบสั่งซื้อ ${x.no}`} url={`/api/purchase-orders/${enc(x.no)}/close`} okLabel="ยืนยันปิดใบสั่งซื้อ" danger={false} testId="po-close"
        effects={['ไม่รอรับของที่ค้างอีก (ผู้ขายส่งไม่ครบ / ยกเลิกส่วนที่เหลือ)', 'ของที่รับแล้วและบิลเจ้าหนี้ไม่เปลี่ยน']} onClose={() => setM(null)} onDone={() => void refresh()} />}
      {m === 'void' && <ReasonModal title={`ยกเลิกใบสั่งซื้อ ${x.no}`} url={`/api/purchase-orders/${enc(x.no)}/void`} okLabel="ยืนยันยกเลิก" testId="void"
        onClose={() => setM(null)} onDone={() => void refresh()} />}
    </>
  );
}

function poPaper(x: PurchaseOrder) {
  const priced = !!x.totals;
  return {
    title: 'ใบสั่งซื้อ', sub: 'Purchase Order', no: x.no, date: x.date, voided: x.status === 'void',
    party: { label: 'ผู้ขาย', name: x.vendor.name, tax: x.vendor.taxId, tel: x.vendor.phone },
    refs: [
      ...(x.expectedDate ? [['กำหนดส่ง', th(x.expectedDate)]] : []), ['ส่งที่', x.warehouseName], ...(x.vendorRef ? [['อ้างอิง', x.vendorRef]] : []),
      ...(x.vatMode !== 'none' ? [['ราคาในเอกสาร', VAT_TH[x.vatMode]]] : []),
    ] as [string, ReactNode][],
    cols: priced ? 'price' as const : 'qty' as const,
    rows: x.lines.map((l) => ({ name: l.free ? `${l.name} (ของแถม)` : l.name, desc: l.sku, qty: l.qty, unit: l.unitName, price: l.unitCost, disc: l.discAmt, amt: l.net })),
    totals: x.totals ? taxRows(x.totals, x.vatMode) : undefined, baht: x.totals?.total ?? null, note: x.note || undefined,
    sign: ['ผู้สั่งซื้อ', 'ผู้อนุมัติ', 'ผู้ขายรับคำสั่งซื้อ'],
  };
}
