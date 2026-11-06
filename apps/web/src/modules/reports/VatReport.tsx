/** M11-03 monthly output / input VAT report (Revenue Department layout): ABB daily summary per POS, voids at 0. */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ReportVat } from '@erp/contracts';
import { api, errText } from '../../api';
import { fmt, Pager, SkeletonRows, th, useCursorPager } from '../../ui';
import { DownloadButtons, Field, SourceNotes, monthTh, thisMonth } from './shared';
import { ErrorBanner } from '../../errors';
import { DocLink } from '../../doclink';

/** ABB summaries per device-day have no document of their own (the note says so); every other number opens its document. */
function VatNo({ no }: { no: string }) {
  const parts = no.split(/\s+[–-]\s+/);
  return <>{parts.map((n, i) => <span key={n}>{i > 0 && ' – '}<DocLink no={n} /></span>)}</>;
}

export default function VatReport() {
  const [month, setMonth] = useState(thisMonth());
  const [kind, setKind] = useState<'sales' | 'purchase'>('sales');
  const filt = { month, kind };
  const pager = useCursorPager(JSON.stringify(filt));
  const r = useQuery({
    queryKey: ['rp', 'vat', filt, pager.cursor], enabled: /^\d{4}-\d{2}$/.test(month), placeholderData: keepPreviousData,
    queryFn: () => api('GET', '/api/reports/vat', { query: { ...filt, cursor: pager.cursor }, schema: ReportVat }),
  });
  const data = r.data;
  const loading = r.isLoading || (r.isFetching && r.isPlaceholderData);
  const t = data?.totals;
  const sales = kind === 'sales';
  return (
    <>
      <div className="tabs rp-tabs" role="tablist" aria-label="ประเภทรายงานภาษี">
        <button role="tab" aria-selected={sales} className={sales ? 'on' : ''} onClick={() => setKind('sales')} data-testid="vat-sales">รายงานภาษีขาย</button>
        <button role="tab" aria-selected={!sales} className={!sales ? 'on' : ''} onClick={() => setKind('purchase')} data-testid="vat-purchase">รายงานภาษีซื้อ</button>
      </div>
      <div className="rp-filters">
        <Field label="เดือนภาษี"><input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} aria-label="เดือนภาษี" data-testid="vat-month" /></Field>
        <span className="sp" />
        <DownloadButtons path="/api/reports/vat" query={filt} testId="vat-dl" />
      </div>
      {r.isError && <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      {data && (
        <p className="small" style={{ margin: '0 0 8px' }}>
          รายงานภาษี{sales ? 'ขาย' : 'ซื้อ'} เดือน {monthTh(month)} · {data.shop.name} · เลขประจำตัวผู้เสียภาษี <span className="mono">{data.shop.taxId}</span> · สาขา {data.shop.branch}
        </p>
      )}
      <div className="tw">
        <table data-testid="vat-table" className="rp-nowrap">
          <thead><tr><th className="n">ลำดับ</th><th>วันที่</th><th>เลขที่{sales ? 'ใบกำกับภาษี' : 'ใบกำกับภาษี (ผู้ขาย)'}</th><th>{sales ? 'ชื่อผู้ซื้อ' : 'ชื่อผู้ขาย'}</th><th>เลขผู้เสียภาษี</th><th>สาขา</th><th className="n">มูลค่าสินค้า / บริการ</th><th className="n">ยกเว้น</th><th className="n">VAT</th><th className="n">รวม</th><th>หมายเหตุ</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={11} rows={8} /> : (data?.rows ?? []).map((x) => (
              <tr key={`${x.seq}-${x.no}`} className={x.note.startsWith('ยกเลิก') ? 'rp-void' : ''}>
                <td className="n">{x.seq}</td><td className="small">{th(x.date)}</td><td className="mono small"><VatNo no={x.no} /></td><td>{x.name}</td><td className="mono small">{x.taxId || '-'}</td><td className="small">{x.branch}</td>
                <td className="n">{fmt(x.base7)}</td><td className="n">{fmt(x.exempt)}</td><td className="n">{fmt(x.vat)}</td><td className="n">{fmt(x.total)}</td><td className="small">{x.note}</td>
              </tr>
            ))}
            {!loading && !data?.rows.length && <tr><td colSpan={11} className="empty">ไม่มีรายการภาษี{sales ? 'ขาย' : 'ซื้อ'}ในเดือนนี้</td></tr>}
            {!loading && t && !!data?.rows.length && (
              <tr className="rp-tot"><td colSpan={6}>รวมทั้งเดือน ({t.docs} เอกสาร{t.voided ? ` · ยกเลิก ${t.voided}` : ''})</td><td className="n">{fmt(t.base7)}</td><td className="n">{fmt(t.exempt)}</td><td className="n">{fmt(t.vat)}</td><td className="n">{fmt(t.total)}</td><td /></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={pager.page} hasNext={!!data?.nextCursor} onPrev={pager.prev} onNext={() => pager.next(data?.nextCursor ?? null)} count={data?.rows.length} loading={loading} />
      <p className="small muted" style={{ marginTop: 8 }}>
        {sales ? 'ใบกำกับภาษีอย่างย่อ (POS) สรุปรายวันต่อเครื่อง · ใบที่ยกเลิกแสดงยอด 0 พร้อมเหตุผล · ใบลดหนี้แสดงเป็นยอดติดลบ' : 'ภาษีซื้อจากใบตั้งเจ้าหนี้ (AP) ที่เกิดจากการรับสินค้า คิดจากยอดหลังหักส่วนลดท้ายบิล'}
      </p>
      <SourceNotes sources={data?.sources} />
    </>
  );
}
