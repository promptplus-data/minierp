/** M08 sales documents: cursor-paged list, filter by type, search. */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { DocSummary, page } from '@erp/contracts';
import { api, errText } from '../api';
import { fmt, Pager, Pill, SkeletonRows, th, useCursorPager, useDebounced } from '../ui';
import { ErrorBanner } from '../errors';

const TYPES = [['', 'ทั้งหมด'], ['ABB', 'ใบกำกับอย่างย่อ'], ['INV', 'ใบกำกับเต็มรูป'], ['RC', 'ใบเสร็จรับเงิน'], ['CN', 'ใบลดหนี้ / รับคืน']] as const;
export const TYPE_TH: Record<string, string> = { ABB: 'อย่างย่อ', INV: 'เต็มรูป', RC: 'ใบเสร็จ', CN: 'ใบลดหนี้', QT: 'ใบเสนอราคา', SO: 'ใบสั่งขาย', DO: 'ใบส่งของ' };

export default function SalesDocs() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [type, setType] = useState(sp.get('type') ?? '');
  const [q, setQ] = useState(sp.get('q') ?? '');
  // report drill-down filters (?from&to&productId&customerId&createdBy&category), cleared with the chip
  const filt = Object.fromEntries(['from', 'to', 'productId', 'customerId', 'createdBy', 'category'].flatMap((k) => (sp.get(k) ? [[k, sp.get(k)!]] : []))) as Record<string, string>;
  const fkey = JSON.stringify(filt);
  const dq = useDebounced(q.trim(), 250);
  const pager = useCursorPager(`${type}|${dq}|${fkey}`);
  const list = useQuery({
    queryKey: ['docs', type, dq, fkey, pager.cursor],
    queryFn: () => api('GET', '/api/sales/docs', { query: { type, q: dq, ...filt, limit: 20, cursor: pager.cursor }, schema: page(DocSummary) }),
    placeholderData: keepPreviousData,
  });
  const loading = list.isLoading || (list.isFetching && list.isPlaceholderData);
  const open = (no: string) => nav(`/sales/${encodeURIComponent(no)}`);
  return (
    <div className="card">
      <h2>เอกสารขาย</h2>
      {Object.keys(filt).length > 0 && (
        <div className="note small row" style={{ marginBottom: 10 }} data-testid="docs-filter">
          <span>กรองจากรายงาน{filt.from ? ` · ${th(filt.from)}${filt.to && filt.to !== filt.from ? ` – ${th(filt.to)}` : ''}` : ''}{q ? ` · "${q}"` : ''}</span>
          <Link className="btn sm" to="/sales">ล้างตัวกรอง</Link>
        </div>
      )}
      <div className="steps" style={{ marginBottom: 12 }}>
        {TYPES.map(([t, l]) => (
          <span key={t} role="button" tabIndex={0} className={type === t ? 'on' : ''} onClick={() => setType(t)} onKeyDown={(e) => { if (e.key === 'Enter') setType(t); }}>{l}</span>
        ))}
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นเลขที่เอกสาร ชื่อ/เบอร์ลูกค้า สินค้า หรือยอดเงิน" style={{ flex: 1, minWidth: 200 }} aria-label="ค้นหาเอกสาร" data-testid="docs-search" />
      </div>
      {list.isError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      <div className="tw">
        <table data-testid="docs-table">
          <thead><tr><th>เลขที่</th><th>ประเภท</th><th>วันที่</th><th>ลูกค้า</th><th>สินค้า</th><th className="n">ยอด</th><th>สถานะ</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={7} /> : (list.data?.items ?? []).map((x) => (
              <tr key={x.id} className="click" onClick={() => open(x.no)} style={x.status === 'void' ? { opacity: 0.65 } : undefined}>
                <td className="mono"><a href={`/sales/${encodeURIComponent(x.no)}`} onClick={(e) => { e.preventDefault(); open(x.no); }}>{x.no}</a></td>
                <td>{TYPE_TH[x.type] ?? x.type}</td>
                <td>{th(x.date)}</td>
                <td>{x.customer.name}</td>
                <td className="small">{x.itemsPreview}</td>
                <td className="n">{x.status === 'void' ? <s>{fmt(x.total)}</s> : fmt(x.total)}</td>
                <td>{x.status === 'void' ? <Pill k="bad">ยกเลิก</Pill> : <Pill k="ok">ปกติ</Pill>}</td>
              </tr>
            ))}
            {!loading && list.data && !list.data.items.length && <tr><td colSpan={7} className="empty">ไม่พบเอกสาร</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!list.data?.nextCursor} count={list.data?.items.length} loading={list.isFetching} onPrev={pager.prev} onNext={() => pager.next(list.data?.nextCursor ?? null)} />
    </div>
  );
}
