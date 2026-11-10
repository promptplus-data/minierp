/**
 * REQ-M17-04/05 leave (mockup VIEWS.leave): balances per person, leave records with approval, the shop's leave
 * calendar, and the employee's own payslips. Staff see only their own rows (server-side).
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HrLeave, HrLeaveCreated, page, type HrLeaveType } from '@erp/contracts';
import { addDays, d, dayOfWeek, leaveDays } from '@erp/core';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { Modal, Pill, SkeletonRows, fq, th, thTime, useDebounced, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { NoteField } from '../../ui/NoteField';
import { SearchSelect } from '../../ui/SearchSelect';
import { LEAVE_LABEL, PAY_STATUS, SlipLink, admErr, periodTH, prevPeriod, thisPeriod, todayYmd, useHrMe, usePayslipPeriods } from './common';
import { useLeaveBalances } from './Employees';
import { ErrorBanner } from '../../errors';

const TYPES: HrLeaveType[] = ['sick', 'personal', 'vacation', 'maternity', 'other', 'unpaid'];
const STATUS: Record<HrLeave['status'], ['ok' | 'bad' | 'warn', string]> = { approved: ['ok', 'อนุมัติ'], rejected: ['bad', 'ไม่อนุมัติ'], pending: ['warn', 'รออนุมัติ'] };

export default function Leave() {
  const { can } = useAuth();
  const me = useHrMe();
  const boss = can('hr.leave') === 1;
  const [year, setYear] = useState(Number(todayYmd().slice(0, 4)));
  const bal = useLeaveBalances(year);
  const [open, setOpen] = useState(false);
  const myEmp = me.data?.employee ?? null;

  return (
    <>
      <div className="card">
        <h2>
          <span className="row">สิทธิ์วันลาปี
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="ปี">
              {[0, 1, 2].map((i) => { const y = Number(todayYmd().slice(0, 4)) - i; return <option key={y} value={y}>{y + 543}</option>; })}
            </select>
            {!boss && <Pill k="acc">เห็นเฉพาะของตัวเอง</Pill>}
          </span>
          <button className="btn sm pri" onClick={() => setOpen(true)} disabled={!boss && !myEmp} data-testid="leave-new">+ บันทึกการลา</button>
        </h2>
        {bal.isError && <ErrorBanner error={bal.error} onRetry={() => void bal.refetch()} retrying={bal.isFetching} />}
        <div className="tw">
          <table data-testid="balance-table">
            <thead>
              <tr><th>พนักงาน</th>{(['sick', 'personal', 'vacation'] as const).map((k) => <th key={k} className="n" colSpan={2}>{LEAVE_LABEL[k]} ใช้ / สิทธิ์ · เหลือ</th>)}<th className="n">ลาคลอด ใช้ / สิทธิ์</th><th className="n">ลาไม่รับค่าจ้าง</th></tr>
            </thead>
            <tbody>
              {bal.isLoading ? <SkeletonRows cols={9} rows={4} /> : (bal.data?.items ?? []).map((e) => (
                <tr key={e.employeeId}>
                  <td>{e.name}<div className="small muted">{e.position}</div></td>
                  {(['sick', 'personal', 'vacation'] as const).map((k) => {
                    const b = e.balances.find((x) => x.type === k)!;
                    return [
                      <td key={`${k}u`} className="n">{fq(b.used)} / {b.entitled}</td>,
                      <td key={`${k}r`} className="n" style={{ color: d(b.remaining).lte(0) ? 'var(--bad)' : undefined }}><b>{fq(b.remaining)}</b></td>,
                    ];
                  })}
                  <td className="n">{(() => { const b = e.balances.find((x) => x.type === 'maternity'); return b ? `${fq(b.used)} / ${b.entitled}` : '-'; })()}</td>
                  <td className="n">{fq(e.unpaid)}</td>
                </tr>
              ))}
              {bal.data && !bal.data.items.length && <tr><td colSpan={9} className="empty">{boss ? 'ยังไม่มีพนักงาน' : 'ผู้ใช้นี้ยังไม่ได้ผูกกับพนักงาน'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted">ตามกฎหมายแรงงาน: ลาป่วยได้รับค่าจ้างไม่เกิน 30 วันทำงานต่อปี · ลากิจธุระอันจำเป็นอย่างน้อย 3 วัน · พักร้อนอย่างน้อย 6 วันเมื่อทำงานครบ 1 ปี · ลาคลอด 98 วัน · ร้านตั้งสิทธิ์รายคนได้มากกว่านี้ในหน้าพนักงาน · ไม่นับวันอาทิตย์</p>
      </div>
      <LeaveList boss={boss} myEmpId={myEmp?.id ?? null} />
      {boss && <LeaveCalendar />}
      {myEmp && can('hr.salary') !== 1 && <MySlips />}
      {open && <LeaveModal boss={boss} myEmpId={myEmp?.id ?? null} year={year} onClose={() => setOpen(false)} />}
    </>
  );
}

function LeaveList({ boss, myEmpId }: { boss: boolean; myEmpId: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [sp] = useSearchParams();
  const [status, setStatus] = useState<'' | HrLeave['status']>('');
  // ?no=LV… (dashboard approvals, audit log) filters the list to that request
  const [q, setQ] = useState(sp.get('no') ?? '');
  const dq = useDebounced(q.trim(), 300);
  const list = useLoadMore(['hr-leaves'], '/api/hr/leaves', HrLeave, { status: status || undefined, q: dq }, 20);
  const decide = async (l: HrLeave, ok: boolean) => {
    let deduct: boolean | undefined;
    if (ok && d(l.overDays).gt(0) && l.type !== 'unpaid') deduct = confirm(`เกินสิทธิ์ ${fq(l.overDays)} วัน · หักเงินเดือนตามวันที่เกินหรือไม่?\nตกลง = หักเงิน · ยกเลิก = ไม่หัก`);
    try {
      const r = await api('POST', `/api/hr/leaves/${l.id}/${ok ? 'approve' : 'reject'}`, { body: deduct === undefined ? {} : { deduct }, schema: HrLeaveCreated });
      toast(`${ok ? 'อนุมัติ' : 'ไม่อนุมัติ'}การลา ${l.no} แล้ว${r.warning ? ` · ${r.warning}` : ''}`);
      void qc.invalidateQueries({ queryKey: ['hr-leaves'] });
      void qc.invalidateQueries({ queryKey: ['hr-balances'] });
      void qc.invalidateQueries({ queryKey: ['hr-cal'] });
    } catch (e) {
      toast(admErr(e));
    }
  };
  const loading = list.isLoading;
  return (
    <div className="card">
      <h2>รายการลา</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" style={{ flex: 1, minWidth: 160 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อ เลขที่ หรือเหตุผล" aria-label="ค้นหาการลา" />
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="สถานะการลา">
          <option value="">ทุกสถานะ</option><option value="pending">รออนุมัติ</option><option value="approved">อนุมัติ</option><option value="rejected">ไม่อนุมัติ</option>
        </select>
      </div>
      <div className="tw">
        <table data-testid="leave-table">
          <thead><tr><th>เลขที่</th><th>พนักงาน</th><th>ประเภท</th><th>วันที่</th><th className="n">วัน</th><th>เหตุผล</th><th>บันทึกโดย</th><th>สถานะ</th><th /></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={9} /> : list.rows.map((l) => (
              <tr key={l.id}>
                <td className="mono small">{l.no}</td>
                <td>{l.employeeName}</td>
                <td>{LEAVE_LABEL[l.type]}{l.halfDay && <div className="small muted">ครึ่งวัน</div>}</td>
                <td className="small">{th(l.fromDate)}{l.toDate !== l.fromDate ? ` – ${th(l.toDate)}` : ''}</td>
                <td className="n">{fq(l.days)}{d(l.overDays).gt(0) && l.type !== 'unpaid' && <div className="small" style={{ color: 'var(--warn)' }}>เกิน {fq(l.overDays)}{l.deduct ? ' · หักเงิน' : ''}</div>}</td>
                <td className="small">{l.reason}{l.note && <div className="muted">หมายเหตุ: {l.note}</div>}</td>
                <td className="small">{l.requestedBy}<div className="muted">{thTime(l.createdAt)}</div></td>
                <td><Pill k={STATUS[l.status][0]}>{STATUS[l.status][1]}{l.decidedBy ? ` · ${l.decidedBy}` : ''}</Pill></td>
                <td>{l.status === 'pending' && boss && l.employeeId !== myEmpId && (
                  <div className="row">
                    <button className="btn sm pri" onClick={() => void decide(l, true)} data-testid={`leave-approve-${l.no}`}>อนุมัติ</button>
                    <button className="btn sm bad" onClick={() => void decide(l, false)}>ไม่อนุมัติ</button>
                  </div>
                )}</td>
              </tr>
            ))}
            {!loading && list.data && !list.rows.length && <tr><td colSpan={9} className="empty">ยังไม่มีรายการลา</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} count={list.rows.length} testId="leave-more" />
    </div>
  );
}

function LeaveModal({ boss, myEmpId, year, onClose }: { boss: boolean; myEmpId: string | null; year: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const bal = useLeaveBalances(year);
  const emps = (bal.data?.items ?? []).filter((e) => boss || e.employeeId === myEmpId);
  const today = todayYmd();
  const [f, setF] = useState({ emp: myEmpId ?? '', type: 'sick' as HrLeaveType, from: today, to: today, half: false, reason: '', deduct: false, note: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const empId = f.emp || emps[0]?.employeeId || '';
  const row = emps.find((e) => e.employeeId === empId);
  const days = leaveDays(f.from, f.to < f.from ? f.from : f.to, f.half && f.from === f.to);
  const left = f.type === 'unpaid' ? null : row?.balances.find((b) => b.type === f.type)?.remaining ?? null;
  const over = left !== null && d(days).gt(left) ? d(days).minus(d(left).gt(0) ? left : 0) : null;
  const ownRequest = empId === myEmpId;

  const save = async () => {
    if (!empId) return setErr('เลือกพนักงาน');
    if (days <= 0) return setErr('ช่วงวันที่ไม่มีวันทำงาน (ไม่นับวันอาทิตย์)');
    setBusy(true);
    setErr('');
    try {
      const r = await api('POST', '/api/hr/leaves', {
        body: { employeeId: empId, type: f.type, fromDate: f.from, toDate: f.to < f.from ? f.from : f.to, halfDay: f.half && f.from === f.to, reason: f.reason.trim(), deduct: f.deduct, note: f.note.trim() || undefined },
        schema: HrLeaveCreated,
      });
      toast(`บันทึกการลา ${r.leave.no} แล้ว · ${r.leave.status === 'approved' ? 'อนุมัติทันที' : 'รออนุมัติ'}${r.warning ? ` · ${r.warning}` : ''}`);
      for (const k of ['hr-leaves', 'hr-balances', 'hr-cal']) void qc.invalidateQueries({ queryKey: [k] });
      onClose();
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="บันทึกการลา">
      <h3>บันทึกการลา</h3>
      {!emps.length && !bal.isLoading ? <div className="note">ผู้ใช้นี้ไม่ได้ผูกกับพนักงาน</div> : (
        <div className="fgrid">
          <label className="f">พนักงาน
            <SearchSelect items={emps} value={empId || null} disabled={!boss} onChange={(id) => setF({ ...f, emp: id ?? '' })} testId="leave-emp" ariaLabel="พนักงาน"
              getId={(e) => e.employeeId} getLabel={(e) => e.name} getSub={(e) => [e.code, e.position].filter(Boolean).join(' · ')} getSearch={(e) => `${e.code} ${e.position}`}
              placeholder="ค้นหาชื่อ / รหัส / ตำแหน่ง" />
          </label>
          <label className="f">ประเภท
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as HrLeaveType })} data-testid="leave-type">
              {TYPES.map((t) => <option key={t} value={t}>{LEAVE_LABEL[t]}</option>)}
            </select>
          </label>
          <label className="f">ตั้งแต่<input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} data-testid="leave-from" /></label>
          <label className="f">ถึง<input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} data-testid="leave-to" /></label>
          <label className="row small"><input type="checkbox" checked={f.half} disabled={f.from !== f.to} onChange={(e) => setF({ ...f, half: e.target.checked })} /> ลาครึ่งวัน</label>
          <label className="f" style={{ gridColumn: '1/-1' }}>เหตุผล<input type="text" value={f.reason} placeholder="เช่น ไปหาหมอ / ธุระที่อำเภอ" onChange={(e) => setF({ ...f, reason: e.target.value })} data-testid="leave-reason" /></label>
          <NoteField value={f.note} onChange={(note) => setF({ ...f, note })} testId="leave-note" placeholder="เช่น ฝากงานไว้กับคุณชัย / มีใบรับรองแพทย์" />
        </div>
      )}
      <div className="tot">
        <span className="muted">จำนวนวันลา (ไม่นับวันอาทิตย์)</span><span data-testid="leave-days">{fq(days)} วัน</span>
        <span className="muted">สิทธิ์คงเหลือ</span><span>{left === null ? '-' : `${fq(left)} วัน`}</span>
      </div>
      {over && (
        <div className="note warn small">
          เกินสิทธิ์ {fq(over.toString())} วัน
          <label className="row" style={{ marginTop: 6 }}><input type="checkbox" checked={f.deduct} onChange={(e) => setF({ ...f, deduct: e.target.checked })} data-testid="leave-deduct" /> หักเงินเดือนตามวันที่เกินสิทธิ์</label>
        </div>
      )}
      <div className="small muted">{boss && !ownRequest ? 'บันทึกโดยหัวหน้า = อนุมัติทันที' : 'ส่งให้ผู้จัดการหรือเจ้าของร้านอนุมัติ (อนุมัติของตัวเองไม่ได้)'}</div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act"><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn pri" disabled={busy || days <= 0} onClick={() => void save()} data-testid="leave-save">บันทึก</button></div>
    </Modal>
  );
}

/** REQ-M17-05 the shop's leave calendar: approved and pending leave in one month (latest 100 records). */
function LeaveCalendar() {
  const [month, setMonth] = useState(thisPeriod());
  const list = useQuery({
    queryKey: ['hr-cal'],
    queryFn: () => api('GET', '/api/hr/leaves', { query: { limit: 100 }, schema: page(HrLeave) }),
  });
  const first = `${month}-01`;
  const days = useMemo(() => {
    const out: string[] = [];
    for (let x = first; x.startsWith(month); x = addDays(x, 1)) out.push(x);
    return out;
  }, [first, month]);
  const lead = (dayOfWeek(first) + 6) % 7; // weeks start on Monday
  const on = (day: string) => (list.data?.items ?? []).filter((l) => l.status !== 'rejected' && l.fromDate <= day && l.toDate >= day && dayOfWeek(day) !== 0);
  const next = (p: string) => { const [y, m] = p.split('-').map(Number) as [number, number]; return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
  return (
    <div className="card">
      <h2>
        ปฏิทินการลาทั้งร้าน
        <span className="row">
          <button className="btn sm" onClick={() => setMonth(prevPeriod(month))} aria-label="เดือนก่อน">‹</button>
          <b data-testid="cal-month">{periodTH(month)}</b>
          <button className="btn sm" onClick={() => setMonth(next(month))} aria-label="เดือนถัดไป">›</button>
        </span>
      </h2>
      <div className="tw">
        <div className="adm-cal" role="grid" aria-label="ปฏิทินการลา">
          {['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'].map((w) => <div key={w} className="h">{w}</div>)}
          {Array.from({ length: lead }, (_, i) => <div key={`e${i}`} className="d off" />)}
          {days.map((day) => {
            const ls = on(day);
            return (
              <div key={day} className={`d${dayOfWeek(day) === 0 ? ' off' : ''}${day === todayYmd() ? ' today' : ''}`}>
                <span className="n">{Number(day.slice(8))}</span>
                {ls.map((l) => <span key={l.id} className={`ev ${l.status}`} title={`${l.employeeName} · ${LEAVE_LABEL[l.type]}`}>{l.employeeName} · {LEAVE_LABEL[l.type]}</span>)}
              </div>
            );
          })}
        </div>
      </div>
      <p className="small muted">สีเขียว = อนุมัติแล้ว · สีเหลือง = รออนุมัติ · วันอาทิตย์ไม่นับเป็นวันลา</p>
    </div>
  );
}

/**
 * Employee self-service: the payroll months that include me. A month's slip opens once the run is published (paid);
 * before that the button is disabled with "รอเผยแพร่รอบเงินเดือน" and no request is sent.
 */
function MySlips() {
  const runs = usePayslipPeriods();
  const items = runs.data?.items ?? [];
  return (
    <div className="card">
      <h2>สลิปเงินเดือนของฉัน</h2>
      {runs.isLoading && <div className="sk" />}
      <div className="tw">
        <table data-testid="my-slips">
          <tbody>
            {items.map((x) => (
              <tr key={x.period}>
                <td>{periodTH(x.period)}</td>
                <td>{x.status && <Pill k={PAY_STATUS[x.status][1]}>{x.published ? `จ่ายแล้ว${x.payDate ? ` · ${th(x.payDate)}` : ''}` : 'ยังไม่เผยแพร่'}</Pill>}</td>
                <td><SlipLink to={`/payslip/${x.period}`} published={x.published} pri testId={`my-slip-${x.period}`}>เปิดสลิป</SlipLink></td>
              </tr>
            ))}
            {runs.data && !items.length && <tr><td className="empty">ยังไม่มีงวดเงินเดือนของคุณ</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="small muted">ดูและพิมพ์ได้เฉพาะงวดที่ร้านจ่ายแล้ว · งวดที่ยังไม่จ่ายแสดงเป็น "รอเผยแพร่รอบเงินเดือน"</p>
    </div>
  );
}
