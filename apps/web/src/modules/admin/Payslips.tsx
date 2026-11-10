/**
 * REQ-M17-03 payslips of one month, one per A4 page (all staff, or ?emp=<id>). The owner prints any slip; an employee
 * opens only their own slip of a paid month (the server enforces both). Not under a nav item, so not route-guarded.
 * Before the payroll run is published (paid) the page asks `GET /api/hr/payslip-periods` first and shows
 * "รอเผยแพร่รอบเงินเดือน" with the print button disabled — the slips request (which would fail) is never sent.
 */
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { HrPayslip } from '@erp/contracts';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { PayslipPaper, SLIP_WAIT, admErr, periodTH, usePayslipPeriods, usePrintA4 } from './common';

export default function Payslips() {
  usePrintA4();
  const { period = '' } = useParams();
  const [sp] = useSearchParams();
  const emp = sp.get('emp') ?? undefined;
  const nav = useNavigate();
  const { can } = useAuth();
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  const status = usePayslipPeriods(period, valid);
  const st = status.data?.items.find((x) => x.period === period);
  const published = !!st?.published;
  const slips = useQuery({
    queryKey: ['hr-slips', period, emp],
    enabled: published,
    retry: false,
    queryFn: () => api('GET', `/api/hr/payroll/${period}/slips`, { query: { employeeId: emp }, schema: z.object({ items: z.array(HrPayslip) }) }),
  });
  const items = slips.data?.items ?? [];
  return (
    <div className="card">
      <h2 className="no-print">
        สลิปเงินเดือน · {/^\d{4}-\d{2}$/.test(period) ? periodTH(period) : period}{items.length > 1 ? ` · ${items.length} คน` : ''}
        <span className="row">
          {can('hr.salary') === 1 ? <Link className="btn sm" to="/hr?tab=pay">‹ กลับหน้าเงินเดือน</Link> : <button className="btn sm" onClick={() => nav(-1)}>‹ กลับ</button>}
          <span title={published ? undefined : SLIP_WAIT}><button className="btn sm pri" disabled={!items.length} onClick={() => window.print()} data-testid="slip-print">พิมพ์ / บันทึก PDF</button></span>
        </span>
      </h2>
      {!valid && <div className="note bad small">งวดไม่ถูกต้อง (YYYY-MM)</div>}
      {status.isLoading && valid && <><div className="sk" /><div className="sk" /></>}
      {status.data && !published && (
        <div className="note warn" data-testid="slip-wait">
          <b>{SLIP_WAIT}</b> · {st?.exists ? 'สลิปเปิดได้เมื่อร้านยืนยันจ่ายเงินเดือนงวดนี้แล้ว' : 'งวดนี้ยังไม่ได้ทำเงินเดือน'}
        </div>
      )}
      {status.isError && <div className="note bad small">{admErr(status.error)}</div>}
      {published && slips.isLoading && <><div className="sk" /><div className="sk" /><div className="sk" /></>}
      {slips.isError && <div className="note bad small">{admErr(slips.error)} {can('hr.salary') !== 1 && '· พนักงานดูได้เฉพาะสลิปของตัวเองในงวดที่จ่ายแล้ว'}</div>}
      {slips.data && !items.length && <div className="empty">งวดนี้ไม่มีสลิป</div>}
      <div className="tw"><div className="slips">{items.map((s) => <PayslipPaper key={s.no} s={s} />)}</div></div>
      <p className="small muted no-print">แต่ละสลิปพิมพ์เป็น A4 หนึ่งหน้า · เลือก "บันทึกเป็น PDF" ในหน้าพิมพ์เพื่อส่งให้พนักงาน</p>
    </div>
  );
}
