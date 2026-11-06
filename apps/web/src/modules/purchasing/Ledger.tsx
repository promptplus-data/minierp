/** M06 "สมุดคุมสต็อก": stock ledger with running balance and source documents (REQ-M06-01), reorder-point list. */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { LedgerEntry, ReorderItem, page } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { useCatalog, useWarehouses } from '../../data';
import { fmt, fq, Pager, Pill, SkeletonRows, thTime, useCursorPager, useDebounced } from '../../ui';
import { GrAlertBanner } from './shared';
import { ErrorBanner } from '../../errors';

const DOC_TH: Record<string, string> = { GR: 'รับสินค้า', PR: 'คืนผู้ขาย', TR: 'โอนคลัง', ADJ: 'เบิก / ปรับยอด', ABB: 'ขายหน้าร้าน', INV: 'ใบกำกับ', CN: 'รับคืน', OPEN: 'สต็อกเปิด', DO: 'ส่งของ', MO: 'ผลิต' };

export default function Ledger() {
  const [tab, setTab] = useState<'ledger' | 'reorder'>('ledger');
  return (
    <>
      <GrAlertBanner />
      <div className="card">
        <div className="tabs" style={{ marginBottom: 12 }}>
          <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>ความเคลื่อนไหว (stock ledger)</button>
          <button className={tab === 'reorder' ? 'on' : ''} onClick={() => setTab('reorder')} data-testid="tab-reorder">สินค้าต่ำกว่าจุดสั่งซื้อ</button>
        </div>
        {tab === 'ledger' ? <LedgerTab /> : <ReorderTab />}
      </div>
    </>
  );
}

function LedgerTab() {
  const { can } = useAuth();
  const cat = useCatalog();
  const whs = useWarehouses();
  const [q, setQ] = useState('');
  const [productId, setProductId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const dq = useDebounced(q.trim());
  const filt = { q: dq, productId, warehouseId, from, to };
  const pager = useCursorPager(JSON.stringify(filt));
  const r = useQuery({
    queryKey: ['pu', 'ledger', filt, pager.cursor],
    queryFn: () => api('GET', '/api/stock/ledger', { query: { ...filt, cursor: pager.cursor }, schema: page(LedgerEntry) }),
    placeholderData: keepPreviousData,
  });
  const loading = r.isLoading || (r.isFetching && r.isPlaceholderData);
  const seeCost = can('data.cost') === 1;
  const cols = seeCost ? 9 : 8;
  return (
    <>
      <div className="pu-filters">
        <input type="search" placeholder="ค้นหาเลขที่เอกสาร สินค้า หรือหมายเหตุ" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาความเคลื่อนไหว" />
        <select value={productId} onChange={(e) => setProductId(e.target.value)} aria-label="สินค้า"><option value="">ทุกสินค้า</option>{(cat.data ?? []).filter((p) => p.kind === 'stock').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} aria-label="คลัง"><option value="">ทุกคลัง</option>{(whs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="ตั้งแต่วันที่" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="ถึงวันที่" />
      </div>
      {r.isError && <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      <div className="tw">
        <table data-testid="ledger-table">
          <thead><tr><th>วันที่</th><th>เอกสาร</th><th>สินค้า</th><th>คลัง</th><th className="n">จำนวน</th><th className="n">คงเหลือหลังรายการ</th>{seeCost && <th className="n">ทุน/หน่วย</th>}<th>หมายเหตุ</th><th>โดย</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={cols} rows={8} /> : (r.data?.items ?? []).map((m) => (
              <tr key={m.id}>
                <td className="small">{thTime(m.at)}</td>
                <td className="mono">{m.docNo}<div className="small muted">{DOC_TH[m.docType] ?? m.docType}</div></td>
                <td>{m.name}<div className="small muted mono">{m.sku}</div></td>
                <td>{whs.data?.find((w) => w.id === m.warehouseId)?.name}</td>
                <td className="n" style={{ color: d(m.qty).lt(0) ? 'var(--bad)' : 'var(--ok)' }}>{d(m.qty).gt(0) ? '+' : ''}{fq(m.qty)} <span className="small muted">{m.unitName}</span></td>
                <td className="n">{fq(m.balance)}</td>
                {seeCost && <td className="n">{m.unitCost != null ? fmt(m.unitCost) : ''}</td>}
                <td className="small pu-cell-wrap">{m.note}</td>
                <td className="small">{m.user}</td>
              </tr>
            ))}
            {!loading && !r.data?.items.length && <tr><td colSpan={cols} className="empty">ไม่มีความเคลื่อนไหว</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!r.data?.nextCursor} count={r.data?.items.length} loading={r.isFetching} onPrev={pager.prev} onNext={() => pager.next(r.data?.nextCursor ?? null)} />
      <p className="small muted" style={{ margin: '8px 0 0' }}>สต็อกเปลี่ยนได้ผ่านเอกสารเท่านั้น (BR-02) · คงเหลือหลังรายการคิดต่อสินค้าต่อคลัง</p>
    </>
  );
}

function ReorderTab() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const pager = useCursorPager(dq);
  const r = useQuery({
    queryKey: ['pu', 'reorder', dq, pager.cursor],
    queryFn: () => api('GET', '/api/stock/reorder', { query: { q: dq, cursor: pager.cursor }, schema: page(ReorderItem) }),
    placeholderData: keepPreviousData,
  });
  const loading = r.isLoading || (r.isFetching && r.isPlaceholderData);
  return (
    <>
      <input type="search" placeholder="ค้นหาชื่อสินค้าหรือรหัส" value={q} onChange={(e) => setQ(e.target.value)} aria-label="ค้นหาสินค้าต่ำกว่าจุดสั่งซื้อ" style={{ width: '100%', marginBottom: 10 }} />
      <div className="tw">
        <table data-testid="reorder-table">
          <thead><tr><th>สินค้า</th><th>หมวด</th><th className="n">คงเหลือ (ทุกคลัง)</th><th className="n">จุดสั่งซื้อ</th><th className="n">ขาดอีก</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={5} rows={5} /> : (r.data?.items ?? []).map((x) => (
              <tr key={x.productId}>
                <td>{x.name}<div className="small muted mono">{x.sku}</div></td><td>{x.category}</td>
                <td className="n">{fq(x.qty)} {x.unitName}</td><td className="n">{fq(x.reorderPoint)}</td><td className="n"><Pill k="warn">{fq(x.shortBy)}</Pill></td>
              </tr>
            ))}
            {!loading && !r.data?.items.length && <tr><td colSpan={5} className="empty">ไม่มีสินค้าต่ำกว่าจุดสั่งซื้อ</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!r.data?.nextCursor} count={r.data?.items.length} onPrev={pager.prev} onNext={() => pager.next(r.data?.nextCursor ?? null)} />
    </>
  );
}
