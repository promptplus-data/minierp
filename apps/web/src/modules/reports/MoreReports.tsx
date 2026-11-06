/** M11-06 internal cost, M11-07 promotion P&L (links to the retail report), M11-05 SCG Family coupons (cloud only). */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ReportCosts, ReportPromotions } from '@erp/contracts';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { fmt, fq, th } from '../../ui';
import { DownloadButtons, Field, SourceNotes, bkkToday, monthStart, monthTh, thisMonth } from './shared';
import { ErrorBanner } from '../../errors';
import { RouteLink } from '../../doclink';

export function CostReport() {
  const [month, setMonth] = useState(thisMonth());
  const r = useQuery({ queryKey: ['rp', 'costs', month], queryFn: () => api('GET', '/api/reports/costs', { query: { month }, schema: ReportCosts }) });
  const x = r.data;
  return (
    <>
      <div className="rp-filters">
        <Field label="เดือน"><input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} aria-label="เดือน" data-testid="cost-month" /></Field>
        <span className="sp" />
        <DownloadButtons path="/api/reports/costs" query={{ month }} testId="cost-dl" />
      </div>
      {r.isError && <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      {r.isLoading && <div className="sk" />}
      {x && (
        <div className="tw">
          <table data-testid="cost-table">
            <thead><tr><th>ต้นทุนภายในร้าน เดือน {monthTh(month)}</th><th className="n">เอกสาร</th><th className="n">บาท</th></tr></thead>
            <tbody>
              <tr><td>ยอดขายก่อน VAT (สุทธิ)</td><td /><td className="n">{fmt(x.sales)}</td></tr>
              <tr><td>ต้นทุนขาย (FIFO)</td><td /><td className="n">{fmt(x.cogs)}</td></tr>
              <tr><td><b>กำไรขั้นต้น</b></td><td /><td className="n"><b>{fmt(x.gp)}</b></td></tr>
              {x.lines.map((l) => <tr key={l.key}><td>{l.label}{l.note && <div className="small muted">{l.note}</div>}</td><td className="n">{l.count ?? ''}</td><td className="n">{l.amount != null ? fmt(l.amount) : '-'}</td></tr>)}
              <tr className="rp-tot"><td>รวมต้นทุนภายใน</td><td /><td className="n">{fmt(x.totalCost)}</td></tr>
              <tr className="rp-tot"><td>กำไรหลังหักต้นทุนภายใน</td><td /><td className="n">{fmt(x.profitAfter)}</td></tr>
            </tbody>
          </table>
        </div>
      )}
      <SourceNotes sources={x?.sources} />
      <p className="small muted" style={{ marginTop: 8 }}>เบิกใช้ในร้าน ปรับยอดสต็อก และรับคืนชำรุด คิดที่ทุน FIFO · เงินเดือนและประกันสังคมส่วนนายจ้างมาจากงวดที่อนุมัติแล้ว (แสดงเฉพาะผู้มีสิทธิ์ดูเงินเดือน)</p>
    </>
  );
}

export function PromoReport() {
  const { can } = useAuth();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(bkkToday());
  const r = useQuery({ queryKey: ['rp', 'promos', from, to], enabled: from <= to, queryFn: () => api('GET', '/api/reports/promotions', { query: { from, to }, schema: ReportPromotions }) });
  const rows = r.data?.rows ?? [];
  const cost = rows.some((x) => x.gp != null);
  return (
    <>
      <div className="rp-filters">
        <Field label="ตั้งแต่วันที่"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="ตั้งแต่วันที่" /></Field>
        <Field label="ถึงวันที่"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="ถึงวันที่" /></Field>
        <span className="sp" />
        {!!can('promo.manage') && <Link className="btn sm" to="/promos" data-testid="promo-link">จัดการโปรโมชั่น / รายงานฉบับเต็ม</Link>}
        <DownloadButtons path="/api/reports/promotions" query={{ from, to }} testId="promo-dl" />
      </div>
      {r.isError && <ErrorBanner error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      <div className="tw">
        <table data-testid="promo-table">
          <thead><tr><th>โปรโมชั่น</th><th className="n">บิล</th><th className="n">ชุดที่ขาย</th><th className="n">ยอดขายก่อน VAT</th><th className="n">ส่วนลดที่ให้</th>{cost && <><th className="n">ต้นทุน</th><th className="n">กำไร</th></>}<th className="n">ยอดช่วงก่อนโปร</th></tr></thead>
          <tbody>
            {r.isLoading && <tr><td colSpan={8}><div className="sk" /></td></tr>}
            {rows.map((x) => (
              <tr key={x.key}><td><RouteLink to="/promos">{x.label}</RouteLink></td><td className="n">{x.bills}</td><td className="n">{Number(x.sets) ? fq(x.sets) : ''}</td><td className="n">{fmt(x.sales)}</td><td className="n">{fmt(x.discount)}</td>
                {cost && <><td className="n">{x.cogs != null ? fmt(x.cogs) : ''}</td><td className="n">{x.gp != null ? fmt(x.gp) : ''}</td></>}
                <td className="n">{x.before ? fmt(x.before.sales) : '-'}</td></tr>
            ))}
            {!r.isLoading && !rows.length && <tr><td colSpan={8} className="empty">ยังไม่มีโปรโมชั่นในช่วงนี้</td></tr>}
          </tbody>
        </table>
      </div>
      <SourceNotes sources={r.data?.sources} />
      <p className="small muted" style={{ marginTop: 8 }}>ตัวเลขชุดเดียวกับรายงานกำไรขาดทุนโปรโมชั่นในหน้าโปรโมชั่นของร้าน (M15)</p>
    </>
  );
}
