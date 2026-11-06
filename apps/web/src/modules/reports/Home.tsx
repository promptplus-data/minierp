/** M11-04 home dashboard ("/"): one card per thing to do today, readable on a phone. Cards other modules own are reused. */
import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArDueSoon, ReportDashboard } from '@erp/contracts';
import { d } from '@erp/core';
import { api, errText } from '../../api';
import { useAuth } from '../../auth';
import { fmt, fq, th } from '../../ui';
import { DocLink, RouteLink } from '../../doclink';
import { ApDueCard, GrAlertBanner } from '../purchasing/shared';
import { monthTh } from './shared';
import './reports.css';
import { ErrorBanner } from '../../errors';

const useDash = () => useQuery({ queryKey: ['rp', 'dashboard'], queryFn: () => api('GET', '/api/reports/dashboard', { schema: ReportDashboard }), staleTime: 30_000 });

/** Receivables due in 7 days and overdue: the sales module's own endpoint (M10). */
function ArDueCard() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['ar', 'due-soon'], queryFn: () => api('GET', '/api/ar/due-soon', { query: { days: 7 }, schema: ArDueSoon }), enabled: !!can('fin.ar'), staleTime: 30_000 });
  if (!can('fin.ar') || !q.data) return null;
  const { dueSoon, overdue } = q.data;
  return (
    <Link className="card kpi" to="/ar?tab=inv" data-testid="ar-due-card" style={{ '--k': 'var(--c-sale)' } as CSSProperties}>
      <div className="l">ลูกหนี้ครบกำหนดใน 7 วัน</div>
      <div className="v">฿{fmt(dueSoon.amount)}</div>
      <div className="s">{dueSoon.invoices} ใบ · {dueSoon.customers} ราย{d(overdue.amount).gt(0) ? ` · เกินกำหนดแล้ว ${overdue.invoices} ใบ ฿${fmt(overdue.amount)}` : ''}</div>
    </Link>
  );
}

function Chart({ rows }: { rows: { date: string; total: string }[] }) {
  const W = 420, H = 200, pl = 42, pb = 24, top = 10;
  const max = Math.max(1000, ...rows.map((r) => Number(r.total))) * 1.15;
  const bw = (W - pl - 8) / rows.length;
  const step = max > 60000 ? 20000 : max > 24000 ? 10000 : max > 8000 ? 5000 : 2000;
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  const y = (v: number) => H - pb - (v / max) * (H - pb - top);
  return (
    <svg className="hm-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="ยอดขาย 7 วันล่าสุด" data-testid="sales-chart">
      {ticks.map((t) => <g key={t}><line x1={pl} x2={W - 6} y1={y(t)} y2={y(t)} /><text x={pl - 6} y={y(t) + 4} textAnchor="end">{t >= 1000 ? `${t / 1000}k` : t}</text></g>)}
      {rows.map((r, i) => {
        const h = H - pb - y(Number(r.total));
        const x = pl + i * bw + bw * 0.18;
        return (
          <g key={r.date}>
            <rect className={`bar${i === rows.length - 1 ? ' today' : ''}`} x={x} y={y(Number(r.total))} width={bw * 0.64} height={Math.max(h, 0)} rx={3}><title>{`${th(r.date)} ฿${fmt(r.total)}`}</title></rect>
            <text x={x + bw * 0.32} y={H - 8} textAnchor="middle">{r.date.slice(8)}/{r.date.slice(5, 7)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Home() {
  const { user, can } = useAuth();
  const q = useDash();
  const dash = q.data;
  const k = (c: string) => ({ '--k': `var(--c-${c})` }) as CSSProperties;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (!dash) return <div className="hm-grid" aria-busy="true">{[0, 1, 2, 3].map((i) => <div key={i} className="card"><div className="sk" /><div className="sk" style={{ width: '60%' }} /></div>)}</div>;
  const a = dash.approvals;
  return (
    <>
      <GrAlertBanner />
      <div className="muted small" style={{ marginBottom: 8 }}>สวัสดี {user?.name} · วันนี้ {th(dash.today)}</div>
      <div className="hm-quick">
        {!!can('pos.sell') && <Link className="btn pri" to="/pos">เปิดหน้าขาย</Link>}
        {!!can('inv.receive') && <Link className="btn" to="/purchasing">รับของ</Link>}
        {!!can('rep.view') && <Link className="btn" to="/reports">รายงาน</Link>}
      </div>
      <div className="hm-grid" data-testid="home-cards">
        {dash.salesToday && (
          <Link className="card kpi" to="/sales" style={k('sale')} data-testid="card-sales-today">
            <div className="l">ยอดขายวันนี้</div>
            <div className="v">฿{fmt(dash.salesToday.total)}</div>
            <div className="s">{dash.salesToday.bills} บิล · VAT {fmt(dash.salesToday.vat)}{d(dash.salesToday.returns).gt(0) ? ` · รับคืน ฿${fmt(dash.salesToday.returns)}` : ''}</div>
          </Link>
        )}
        {dash.grPending && (
          <Link className="card kpi" to={can('inv.receive') ? '/purchasing' : '/stock-ledger'} style={k('inv')} data-testid="card-gr">
            <div className="l">ของรอยืนยันรับ</div>
            <div className="v">{dash.grPending.count} ใบ</div>
            <div className="s">{dash.grPending.count ? `รอนานสุด ${dash.grPending.oldestDays} วัน` : 'ไม่มีของค้างรอ'}</div>
          </Link>
        )}
        {dash.lowStock && (
          <Link className="card kpi" to="/stock-ledger?tab=reorder" style={k('inv')} data-testid="card-low-stock">
            <div className="l">สินค้าต่ำกว่าจุดสั่งซื้อ</div>
            <div className="v">{dash.lowStock.count} รายการ</div>
            <div className="s">{dash.lowStock.items[0] ? `ใกล้หมดสุด: ${dash.lowStock.items[0].name}` : 'สต็อกเพียงพอ'}</div>
          </Link>
        )}
        <ArDueCard />
        <ApDueCard />
        {a && (
          <Link className="card kpi" to={a.items[0]?.path ?? '/stock'} style={k('adm')} data-testid="card-approvals">
            <div className="l">รออนุมัติ</div>
            <div className="v">{a.count} รายการ</div>
            <div className="s">{a.items[0] ? a.items[0].label : 'ไม่มีรายการรออนุมัติ'}</div>
          </Link>
        )}
      </div>

      <div className="hm-two">
        {dash.sales7d && (
          <div className="card"><h2>ยอดขาย 7 วันล่าสุด (บาท รวม VAT)</h2><Chart rows={dash.sales7d} /></div>
        )}
        {dash.month && (
          <div className="card" data-testid="month-summary">
            <h2>สรุปเดือน {monthTh(dash.today.slice(0, 7))} (ถึงวันนี้)</h2>
            <div className="tw"><table><tbody>
              <tr><td>ยอดขายก่อน VAT (สุทธิหลังรับคืน)</td><td className="n">{fmt(dash.month.sales)}</td></tr>
              {dash.month.cogs != null && dash.month.gp != null ? (
                <>
                  <tr><td>ต้นทุนขาย (FIFO)</td><td className="n">{fmt(dash.month.cogs)}</td></tr>
                  <tr><td><b>กำไรขั้นต้น</b></td><td className="n"><b>{fmt(dash.month.gp)}{d(dash.month.sales).gt(0) ? ` (${d(dash.month.gp).div(d(dash.month.sales)).times(100).toFixed(1)}%)` : ''}</b></td></tr>
                  {dash.month.stockValue != null && <tr><td>มูลค่าสต็อกคงเหลือ (FIFO)</td><td className="n">{fmt(dash.month.stockValue)}</td></tr>}
                </>
              ) : <tr><td colSpan={2} className="small muted">ต้นทุนและกำไรแสดงเฉพาะบทบาทที่มีสิทธิ์ดูต้นทุน</td></tr>}
            </tbody></table></div>
            {!!can('rep.view') && <div style={{ marginTop: 8 }}><Link className="btn sm" to="/reports">ดูรายงานทั้งหมด</Link></div>}
          </div>
        )}
        {dash.lowStock && dash.lowStock.items.length > 0 && (
          <div className="card" data-testid="low-stock-list">
            <h2>ใกล้หมดสต็อก</h2>
            <ul className="hm-list">
              {dash.lowStock.items.map((x) => (
                <li key={x.productId}><span><RouteLink to={`/stock-ledger?productId=${encodeURIComponent(x.productId)}`}>{x.name}</RouteLink>{x.isScg && <span className="pill p-acc" style={{ marginLeft: 6 }}>SCG</span>}</span><span className="n">{fq(x.qty)} / {fq(x.reorderPoint)} {x.unit}</span></li>
              ))}
            </ul>
          </div>
        )}
        {dash.arDue && dash.arDue.items.length > 0 && (
          <div className="card" data-testid="ar-list">
            <h2>ลูกหนี้ที่ต้องตาม</h2>
            <ul className="hm-list">
              {dash.arDue.items.map((x) => (
                <li key={x.no}><span>{x.customer}<div className="small muted mono"><DocLink no={x.no} /> · ครบ {th(x.dueDate)}</div></span><span className="n">฿{fmt(x.balance)}{x.overdueDays > 0 && <div className="small" style={{ color: 'var(--bad)' }}>เกิน {x.overdueDays} วัน</div>}</span></li>
              ))}
            </ul>
          </div>
        )}
        {a && a.items.length > 0 && (
          <div className="card" data-testid="approval-list">
            <h2>รออนุมัติ</h2>
            <ul className="hm-list">
              {a.items.map((x) => <li key={x.no}><Link to={x.path}>{x.label}<div className="small muted mono">{x.no}</div></Link></li>)}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}
