/** M11-01 sales and gross profit by day / month / product / category / customer / seller / sale type. */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ReportSales, type ReportSalesBy } from '@erp/contracts';
import { api, errText } from '../../api';
import { fmt, fq, Pager, SkeletonRows, useCursorPager, useDebounced } from '../../ui';
import { DownloadButtons, Field, SourceNotes, bkkToday, monthStart } from './shared';
import { ErrorBanner } from '../../errors';

const BY: [ReportSalesBy, string][] = [
  ['day', 'รายวัน'], ['month', 'รายเดือน'], ['product', 'ตามสินค้า'], ['category', 'ตามหมวดสินค้า'], ['customer', 'ตามลูกค้า'], ['seller', 'ตามพนักงานขาย'], ['saleType', 'ตามประเภทการขาย'],
];
const LABEL_TH: Record<string, string> = { retail: 'ขายปลีกหน้าร้าน', whole: 'ขายส่ง / เงินเชื่อ', project: 'ขายโครงการ' };

export default function SalesReport() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(bkkToday());
  const [by, setBy] = useState<ReportSalesBy>('day');
  const [saleType, setSaleType] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const filt = { from, to, by, saleType, q: dq };
  const pager = useCursorPager(JSON.stringify(filt));
  const ok = !!from && !!to && from <= to;
  const r = useQuery({
    queryKey: ['rp', 'sales', filt, pager.cursor], enabled: ok, placeholderData: keepPreviousData,
    queryFn: () => api('GET', '/api/reports/sales', { query: { ...filt, cursor: pager.cursor }, schema: ReportSales }),
  });
  const data = r.data;
  const loading = r.isLoading || (r.isFetching && r.isPlaceholderData);
  const cost = data?.costVisible ?? false;
  const cols = 7 + (cost ? 3 : 0) + (by === 'product' ? 1 : 0);
  const t = data?.totals;
  return (
    <>
      <div className="rp-filters">
        <Field label="ตั้งแต่วันที่"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="ตั้งแต่วันที่" /></Field>
        <Field label="ถึงวันที่"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="ถึงวันที่" /></Field>
        <Field label="จัดกลุ่ม"><select value={by} onChange={(e) => setBy(e.target.value as ReportSalesBy)} aria-label="จัดกลุ่มตาม" data-testid="sales-by">{BY.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="ประเภทการขาย"><select value={saleType} onChange={(e) => setSaleType(e.target.value)} aria-label="ประเภทการขาย"><option value="">ทั้งหมด</option><option value="retail">ขายปลีก</option><option value="whole">ขายส่ง</option><option value="project">โครงการ</option></select></Field>
        {['product', 'customer', 'category', 'seller'].includes(by) && <Field label="ค้นหา" className="rp-search"><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ชื่อ / รหัส" aria-label="ค้นหา" /></Field>}
        <span className="sp" />
        <DownloadButtons path="/api/reports/sales" query={{ from, to, by, saleType, q: dq }} disabled={!ok} testId="sales-dl" />
      </div>
      {!ok && <div className="note warn small">ช่วงวันที่ไม่ถูกต้อง</div>}
      {r.isError && <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      {t && (
        <div className="rp-kpis" data-testid="sales-kpis">
          <div className="card"><div className="l">ยอดขายก่อน VAT</div><div className="v">฿{fmt(t.net)}</div></div>
          <div className="card"><div className="l">VAT</div><div className="v">฿{fmt(t.vat)}</div></div>
          <div className="card"><div className="l">รวม VAT</div><div className="v">฿{fmt(t.total)}</div></div>
          {cost && t.cogs != null && <div className="card"><div className="l">ต้นทุนขาย (FIFO)</div><div className="v">฿{fmt(t.cogs)}</div></div>}
          {cost && t.gp != null && <div className="card"><div className="l">กำไรขั้นต้น</div><div className="v">฿{fmt(t.gp)}{t.gpPct != null ? <span className="small muted"> {t.gpPct}%</span> : null}</div></div>}
          <div className="card"><div className="l">เอกสาร</div><div className="v">{t.bills}<span className="small muted"> บิล · คืน {t.returns}</span></div></div>
        </div>
      )}
      <div className="tw">
        <table data-testid="sales-table">
          <thead><tr>
            <th>{BY.find((x) => x[0] === by)?.[1].replace('ตาม', '').replace('ราย', '') ?? ''}</th><th className="n">บิล</th><th className="n">รับคืน</th>{by === 'product' && <th className="n">จำนวน</th>}
            <th className="n">ขายก่อน VAT</th><th className="n">VAT</th><th className="n">รวม</th>{cost && <><th className="n">ต้นทุน</th><th className="n">กำไร</th><th className="n">GP %</th></>}
          </tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={cols} rows={8} /> : (data?.rows ?? []).map((x) => (
              <tr key={x.key}>
                <td>{by === 'saleType' ? (LABEL_TH[x.key] ?? x.label) : x.label}{x.sub && <div className="small muted">{x.sub}</div>}</td>
                <td className="n">{x.bills}</td><td className="n">{x.returns || ''}</td>{by === 'product' && <td className="n">{x.qty != null ? fq(x.qty) : ''}</td>}
                <td className="n">{fmt(x.net)}</td><td className="n">{fmt(x.vat)}</td><td className="n">{fmt(x.total)}</td>
                {cost && <><td className="n">{x.cogs != null ? fmt(x.cogs) : ''}</td><td className="n">{x.gp != null ? fmt(x.gp) : ''}</td><td className="n">{x.gpPct ?? ''}</td></>}
              </tr>
            ))}
            {!loading && !data?.rows.length && <tr><td colSpan={cols} className="empty">ไม่มีรายการขายในช่วงนี้</td></tr>}
            {!loading && t && !!data?.rows.length && (
              <tr className="rp-tot"><td>รวมทั้งช่วง</td><td className="n">{t.bills}</td><td className="n">{t.returns || ''}</td>{by === 'product' && <td />}
                <td className="n">{fmt(t.net)}</td><td className="n">{fmt(t.vat)}</td><td className="n">{fmt(t.total)}</td>
                {cost && <><td className="n">{t.cogs != null ? fmt(t.cogs) : ''}</td><td className="n">{t.gp != null ? fmt(t.gp) : ''}</td><td className="n">{t.gpPct ?? ''}</td></>}</tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(data?.nextCursor ?? null)} count={data?.rows.length} loading={loading} />
      {data && data.voided.count > 0 && <p className="small muted" style={{ marginTop: 8 }}>ไม่นับบิลที่ยกเลิก {data.voided.count} ใบ (มูลค่า ฿{fmt(data.voided.total)}) · ยอดสุทธิหักใบลดหนี้ / รับคืนแล้ว</p>}
      <SourceNotes sources={data?.sources} />
    </>
  );
}
