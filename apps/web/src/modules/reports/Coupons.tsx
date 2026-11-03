/** M11-05 SCG Family coupons used, for the claim-back. Cloud only (OQ-A2): loaded only by the cloud build. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReportCoupons } from '@erp/contracts';
import { api, errText } from '../../api';
import { fmt, th } from '../../ui';
import { DownloadButtons, Field, SourceNotes, bkkToday, monthStart } from './shared';

export default function CouponReport() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(bkkToday());
  const r = useQuery({ queryKey: ['rp', 'coupons', from, to], enabled: from <= to, queryFn: () => api('GET', '/api/reports/coupons', { query: { from, to }, schema: ReportCoupons }) });
  const rows = r.data?.rows ?? [];
  return (
    <>
      <div className="rp-filters">
        <Field label="ตั้งแต่วันที่"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="ตั้งแต่วันที่" /></Field>
        <Field label="ถึงวันที่"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="ถึงวันที่" /></Field>
        <span className="sp" />
        <DownloadButtons path="/api/reports/coupons" query={{ from, to }} testId="coupon-dl" />
      </div>
      {r.isError && <div className="note bad small">{errText(r.error)}</div>}
      <div className="tw">
        <table data-testid="coupon-table">
          <thead><tr><th>บิล</th><th>วันที่</th><th>สมาชิก</th><th>คูปอง</th><th className="n">มูลค่า</th><th>เลขอ้างอิงการตัด</th></tr></thead>
          <tbody>
            {rows.map((x) => <tr key={x.billNo + x.couponCode}><td className="mono">{x.billNo}</td><td>{th(x.date)}</td><td className="mono">{x.memberId}</td><td>{x.couponCode}</td><td className="n">{fmt(x.amount)}</td><td className="mono small">{x.redeemRef}</td></tr>)}
            {!r.isLoading && !rows.length && <tr><td colSpan={6} className="empty">ยังไม่มีบิลที่ใช้คูปอง SCG Family ในช่วงนี้</td></tr>}
            {!!rows.length && <tr className="rp-tot"><td colSpan={4}>รวม</td><td className="n">{fmt(r.data!.total)}</td><td /></tr>}
          </tbody>
        </table>
      </div>
      <SourceNotes sources={r.data?.sources} />
      <p className="small muted" style={{ marginTop: 8 }}>ใช้เบิกคืนค่าคูปองจาก SCG Family · วิธีเบิกคืนยังรอตกลง</p>
    </>
  );
}
