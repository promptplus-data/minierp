/** M06 "สมุดคุมสต็อก": stock ledger with running balance and source documents (REQ-M06-01), reorder-point list. */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { LedgerEntry, ReorderItem, StockBalance, page } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useAllWarehouses } from '../../data';
import { fmt, fq, Pill, SkeletonRows, thTime, useDebounced } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { ProductPicker } from '../../ui/ProductPicker';
import type { Product } from '@erp/contracts';
import '../../stock/stock.css';
import { GrAlertBanner } from './shared';
import { ErrorBanner } from '../../errors';
import { DocLink, DocText, type DocType } from '../../doclink';

const isStockProduct = (p: Product) => p.kind === 'stock';
const DOC_TH: Record<string, string> = { GR: 'รับสินค้า', PR: 'คืนผู้ขาย', TR: 'โอนคลัง', ADJ: 'เบิก / ปรับยอด', ABB: 'ขายหน้าร้าน', INV: 'ใบกำกับ', CN: 'รับคืน', OPEN: 'สต็อกเปิด', DO: 'ส่งของ', MO: 'ผลิต' };

export default function Ledger() {
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<'ledger' | 'reorder'>(sp.get('tab') === 'reorder' ? 'reorder' : 'ledger');
  return (
    <>
      <GrAlertBanner />
      <div className="card">
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>ความเคลื่อนไหว (stock ledger)</button>
          <button className={tab === 'reorder' ? 'on' : ''} onClick={() => setTab('reorder')} data-testid="tab-reorder">สินค้าต่ำกว่าจุดสั่งซื้อ</button>
        </div>
        {tab === 'ledger' ? <LedgerTab key={`${sp.get('q')}|${sp.get('productId')}`} /> : <ReorderTab />}
      </div>
    </>
  );
}

function LedgerTab() {
  const { can } = useAuth();
  const cat = useCatalog();
  const whs = useAllWarehouses();
  const [sp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [productId, setProductId] = useState(sp.get('productId') ?? '');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const dq = useDebounced(q.trim());
  const filt = { q: dq, productId, warehouseId, from, to };
  const r = useLoadMore(['pu', 'ledger'], '/api/stock/ledger', LedgerEntry, filt, 20);
  const loading = r.isLoading;
  // REQ-M06-01: on hand, reserved by open sales orders and available for the chosen product (and warehouse).
  const bal = useQuery({
    queryKey: ['stock', 'ledger-balance', productId, warehouseId], enabled: !!productId,
    queryFn: () => api('GET', '/api/stock', { query: { productId, warehouseId: warehouseId || undefined, damaged: 'include', limit: 50 }, schema: page(StockBalance) }),
  });
  const sumOf = (k: 'qty' | 'reserved' | 'available', damaged: boolean) => (bal.data?.items ?? []).filter((b) => !!b.damaged === damaged).reduce((a, b) => a.plus(d(b[k] ?? 0)), d(0));
  const unit = cat.byId.get(productId)?.units[0]?.name ?? '';
  const seeCost = can('data.cost') === 1;
  const cols = seeCost ? 9 : 8;
  return (
    <>
      <div className="pu-filters">
        <input type="search" placeholder="ค้นหาเลขที่เอกสาร สินค้า หรือหมายเหตุ" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาความเคลื่อนไหว" />
        <ProductPicker value={productId || null} onChange={(id) => setProductId(id ?? '')} filter={isStockProduct} showStock={false} placeholder="ทุกสินค้า (ค้นหาเพื่อกรอง)" testId="ledger-product" ariaLabel="สินค้า" />
        {productId && <button className="btn sm" onClick={() => setProductId('')}>ล้างสินค้า</button>}
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="คลัง"><option value="">ทุกคลัง</option>{(whs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}{w.kind === 'damaged' ? ' (ของเสีย)' : ''}</option>)}</select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="ตั้งแต่วันที่" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="ถึงวันที่" />
      </div>
      {productId && bal.data && (
        <div className="stk-summary small" data-testid="ledger-balance">
          <span>คงเหลือ <b>{fq(sumOf('qty', false))}</b> {unit}</span>
          <span>จอง (ใบสั่งขายที่ยังไม่ส่ง) <b>{fq(sumOf('reserved', false))}</b></span>
          <span>พร้อมขาย <b style={sumOf('available', false).lt(0) ? { color: 'var(--bad)' } : undefined}>{fq(sumOf('available', false))}</b></span>
          {!sumOf('qty', true).isZero() && <span>คลังสินค้าชำรุด <b>{fq(sumOf('qty', true))}</b> (ไม่นับเป็นสต็อกขาย)</span>}
        </div>
      )}
      {r.isError && <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      <div className="tw">
        <table data-testid="ledger-table">
          <thead><tr><th>วันที่</th><th>เอกสาร</th><th>สินค้า</th><th>คลัง</th><th className="n">จำนวน</th><th className="n">คงเหลือหลังรายการ</th>{seeCost && <th className="n">ทุน/หน่วย</th>}<th>หมายเหตุ</th><th>โดย</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={cols} rows={8} /> : r.rows.map((m) => (
              <tr key={m.id}>
                <td className="small">{thTime(m.at)}</td>
                <td className="mono"><DocLink no={m.docNo} type={m.docType === 'OPEN' ? undefined : (m.docType as DocType)} /><div className="small muted">{DOC_TH[m.docType] ?? m.docType}</div></td>
                <td>{m.name}<div className="small muted mono">{m.sku}</div></td>
                <td>{whs.data?.find((w) => w.id === m.warehouseId)?.name}</td>
                <td className="n" style={{ color: d(m.qty).lt(0) ? 'var(--bad)' : 'var(--ok)' }}>{d(m.qty).gt(0) ? '+' : ''}{fq(m.qty)} <span className="small muted">{m.unitName}</span></td>
                <td className="n">{fq(m.balance)}</td>
                {seeCost && <td className="n">{m.unitCost != null ? fmt(m.unitCost) : ''}</td>}
                <td className="small pu-cell-wrap"><DocText text={m.note} /></td>
                <td className="small">{m.user}</td>
              </tr>
            ))}
            {!loading && !r.rows.length && <tr><td colSpan={cols} className="empty">ไม่มีความเคลื่อนไหว</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="ledger-more" />
      <p className="small muted" style={{ margin: '8px 0 0' }}>สต็อกเปลี่ยนได้ผ่านเอกสารเท่านั้น (BR-02) · คงเหลือหลังรายการคิดต่อสินค้าต่อคลัง</p>
    </>
  );
}

function ReorderTab() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const r = useLoadMore(['pu', 'reorder'], '/api/stock/reorder', ReorderItem, { q: dq }, 20);
  const loading = r.isLoading;
  return (
    <>
      <input type="search" placeholder="ค้นหาชื่อสินค้าหรือรหัส" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาสินค้าต่ำกว่าจุดสั่งซื้อ" style={{ width: '100%', marginBottom: 10 }} />
      <div className="tw">
        <table data-testid="reorder-table">
          <thead><tr><th>สินค้า</th><th>หมวด</th><th className="n">คงเหลือ (ทุกคลัง)</th><th className="n">จุดสั่งซื้อ</th><th className="n">ขาดอีก</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={5} rows={5} /> : r.rows.map((x) => (
              <tr key={x.productId}>
                <td>{x.name}<div className="small muted mono">{x.sku}</div></td><td>{x.category}</td>
                <td className="n">{fq(x.qty)} {x.unitName}</td><td className="n">{fq(x.reorderPoint)}</td><td className="n"><Pill k="warn">{fq(x.shortBy)}</Pill></td>
              </tr>
            ))}
            {!loading && !r.rows.length && <tr><td colSpan={5} className="empty">ไม่มีสินค้าต่ำกว่าจุดสั่งซื้อ</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!r.hasNextPage} loading={r.isFetchingNextPage} onMore={() => void r.fetchNextPage()} count={r.rows.length} testId="reorder-more" />
    </>
  );
}
