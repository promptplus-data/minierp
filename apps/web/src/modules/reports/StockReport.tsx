/** M11-02 stock on hand with FIFO value as of a date, slow movers, below reorder point. */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ReportStock } from '@erp/contracts';
import { api, errText } from '../../api';
import { useWarehouses } from '../../data';
import { fmt, fq, Pager, Pill, SkeletonRows, th, useCursorPager, useDebounced } from '../../ui';
import { DownloadButtons, Field, bkkToday } from './shared';
import { ErrorBanner } from '../../errors';
import { RouteLink } from '../../doclink';

export default function StockReport() {
  const whs = useWarehouses();
  const [asOf, setAsOf] = useState(bkkToday());
  const [warehouseId, setWarehouse] = useState('');
  const [only, setOnly] = useState<'all' | 'low' | 'slow'>('all');
  const [slowDays, setSlowDays] = useState(90);
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const filt = { asOf, warehouseId, only, slowDays, q: dq };
  const pager = useCursorPager(JSON.stringify(filt));
  const r = useQuery({
    queryKey: ['rp', 'stock', filt, pager.cursor], placeholderData: keepPreviousData,
    queryFn: () => api('GET', '/api/reports/stock', { query: { ...filt, cursor: pager.cursor }, schema: ReportStock }),
  });
  const data = r.data;
  const loading = r.isLoading || (r.isFetching && r.isPlaceholderData);
  const cost = data?.costVisible ?? false;
  const t = data?.totals;
  // Damaged-goods warehouses (คลังสินค้าชำรุด) are reported apart from sellable stock when any exist.
  const dmg = !!t?.damagedQty && Number(t.damagedQty) !== 0;
  const cols = 8 + (cost ? 2 : 0) + (dmg ? 1 : 0);
  return (
    <>
      <div className="rp-filters">
        <Field label="ณ วันที่"><input type="date" value={asOf} max={bkkToday()} onChange={(e) => setAsOf(e.target.value || bkkToday())} aria-label="ณ วันที่" data-testid="stock-asof" /></Field>
        <Field label="คลัง"><select value={warehouseId} onChange={(e) => setWarehouse(e.target.value)} aria-label="คลัง"><option value="">ทุกคลัง</option>{(whs.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
        <Field label="แสดง"><select value={only} onChange={(e) => setOnly(e.target.value as typeof only)} aria-label="แสดง" data-testid="stock-only"><option value="all">ทุกรายการ</option><option value="low">ต่ำกว่าจุดสั่งซื้อ</option><option value="slow">ไม่เคลื่อนไหว (ขายช้า)</option></select></Field>
        {only === 'slow' && <Field label="ไม่เคลื่อนไหวเกิน (วัน)"><input type="number" min={1} max={3650} value={slowDays} onChange={(e) => setSlowDays(Math.max(1, Number(e.target.value) || 90))} aria-label="จำนวนวัน" /></Field>}
        <Field label="ค้นหา" className="rp-search"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ชื่อ / รหัสสินค้า" aria-label="ค้นหาสินค้า" /></Field>
        <span className="sp" />
        <DownloadButtons path="/api/reports/stock" query={filt} testId="stock-dl" />
      </div>
      {r.isError && <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      {t && (
        <div className="rp-kpis" data-testid="stock-kpis">
          <div className="card"><div className="l">สินค้า (รายการ)</div><div className="v">{t.products}</div></div>
          {cost && t.value != null && <div className="card"><div className="l">มูลค่าสต็อก FIFO ณ {th(data!.asOf)}</div><div className="v">฿{fmt(t.value)}</div></div>}
          {dmg && <div className="card"><div className="l">สินค้าชำรุด (ไม่นับในคงเหลือ){cost && t.damagedValue != null ? ` · ฿${fmt(t.damagedValue)}` : ''}</div><div className="v" data-testid="stock-damaged">{fq(t.damagedQty!)}</div></div>}
          <div className="card"><div className="l">ต่ำกว่าจุดสั่งซื้อ</div><div className="v">{t.low}</div></div>
          <div className="card"><div className="l">ไม่เคลื่อนไหวเกิน {data!.slowDays} วัน</div><div className="v">{t.slow}</div></div>
        </div>
      )}
      <div className="tw">
        <table data-testid="stock-table">
          <thead><tr><th>สินค้า</th><th>หมวด</th><th className="n">คงเหลือ</th>{dmg && <th className="n">ชำรุด</th>}{cost && <><th className="n">ทุนเฉลี่ย</th><th className="n">มูลค่า FIFO</th></>}<th className="n">จุดสั่งซื้อ</th><th>ขายล่าสุด</th><th className="n">ไม่เคลื่อนไหว (วัน)</th><th>สถานะ</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={cols} rows={8} /> : (data?.rows ?? []).map((x) => (
              <tr key={x.productId}>
                <td><RouteLink to={`/stock-ledger?productId=${encodeURIComponent(x.productId)}`}>{x.name}</RouteLink><div className="small muted mono">{x.sku}</div></td><td className="small">{x.category}</td>
                <td className="n">{fq(x.qty)} <span className="small muted">{x.unit}</span></td>
                {dmg && <td className="n">{x.damagedQty && Number(x.damagedQty) ? fq(x.damagedQty) : ''}</td>}
                {cost && <><td className="n">{x.avgCost != null ? fmt(x.avgCost) : ''}</td><td className="n">{x.value != null ? fmt(x.value) : ''}</td></>}
                <td className="n">{Number(x.reorderPoint) ? fq(x.reorderPoint) : ''}</td>
                <td className="small">{x.lastOut ? th(x.lastOut) : '-'}</td><td className="n">{x.idleDays ?? ''}</td>
                <td><span className="rp-pills">{x.low && <Pill k="bad">ต่ำกว่าจุดสั่งซื้อ</Pill>}{x.slow && <Pill k="warn">ขายช้า</Pill>}</span></td>
              </tr>
            ))}
            {!loading && !data?.rows.length && <tr><td colSpan={cols} className="empty">ไม่มีสินค้าตามเงื่อนไข</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(data?.nextCursor ?? null)} count={data?.rows.length} loading={loading} />
    </>
  );
}
