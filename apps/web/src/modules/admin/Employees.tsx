/** REQ-M17-01 + REQ-M01-10: employees with their login user (created together), resign instead of delete, rehire. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { HrEmployee, HrEmployeeCreated, HrLeaveBalanceRow, Role, THAI_BANKS, type HrEmpType, type HrLeaveEnt } from '@erp/contracts';
import { DEFAULT_LEAVE_ENTITLEMENT, USERNAME_RE, thaiIdValid } from '@erp/core';
import { api } from '../../api';
import { ROLE_TH, useAuth } from '../../auth';
import { Modal, Pill, SkeletonRows, fmt, fq, th, useDebounced, useToast } from '../../ui';
import { LoadMore, useLoadMore } from '../../ui/lists';
import { EMP_TYPE_TH, SlipLink, admErr, periodTH, todayYmd, usePayslipPeriods } from './common';
import { ErrorBanner, checkFields, requiredMsg } from '../../errors';

const ROLES = Role.options.filter((r) => r !== 'owner');
const TYPES: HrEmpType[] = ['monthly', 'daily', 'parttime', 'external'];
const ENT_KEYS: [keyof HrLeaveEnt, string][] = [['sick', 'ลาป่วย'], ['personal', 'ลากิจ'], ['vacation', 'พักร้อน'], ['maternity', 'ลาคลอด'], ['other', 'อื่น ๆ']];
const RESIGN_REASONS = ['ลาออกเอง', 'เลิกจ้าง', 'หมดสัญญาจ้าง'];

export const useLeaveBalances = (year: number) =>
  useQuery({
    queryKey: ['hr-balances', year],
    queryFn: () => api('GET', '/api/hr/leave-balances', { query: { year }, schema: z.object({ year: z.number(), items: z.array(HrLeaveBalanceRow) }) }),
  });

export default function Employees() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can('hr.manage') === 1;
  const sal = can('hr.salary') === 1;
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'active' | 'resigned' | 'all'>('all');
  const dq = useDebounced(q.trim(), 300);
  const list = useLoadMore(['hr-employees'], '/api/hr/employees', HrEmployee, { q: dq, status }, 20);
  // Latest payroll month: each row's slip button opens it once published, disabled ("รอเผยแพร่รอบเงินเดือน") before.
  const slipRuns = usePayslipPeriods(undefined, sal);
  const lastRun = slipRuns.data?.items[0] ?? null;
  const bal = useLeaveBalances(Number(todayYmd().slice(0, 4)));
  const balOf = (id: string) => bal.data?.items.find((b) => b.employeeId === id);
  const [edit, setEdit] = useState<HrEmployee | 'new' | null>(null);
  const [resign, setResign] = useState<HrEmployee | null>(null);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['hr-employees'] });
    void qc.invalidateQueries({ queryKey: ['hr-balances'] });
  };
  const rehire = async (e: HrEmployee) => {
    if (!confirm(`รับ ${e.name} กลับเข้าทำงาน และเปิดบัญชีผู้ใช้เดิม${e.user ? ` (${e.user.username})` : ''}?`)) return;
    try {
      await api('POST', `/api/hr/employees/${e.id}/rehire`, { body: {} });
      toast(`รับ ${e.name} กลับเข้าทำงานแล้ว`);
      refresh();
    } catch (err) {
      toast(admErr(err));
    }
  };
  const loading = list.isLoading;
  const cols = sal ? 9 : 8;

  return (
    <>
      <div className="adm-bar">
        <span className="small muted">สร้างผู้ใช้ได้ตอนเพิ่มพนักงานเท่านั้น · ลบไม่ได้ เมื่อออกให้กด "ลาออก" ระบบปิดบัญชีแต่เก็บประวัติการทำรายการ</span>
        {manage && <button className="btn sm pri" onClick={() => setEdit('new')} data-testid="emp-new">+ เพิ่มพนักงาน</button>}
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" className="grow" style={{ flex: 1, minWidth: 180 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นชื่อ รหัส ตำแหน่ง หรือชื่อผู้ใช้" aria-label="ค้นหาพนักงาน" />
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="สถานะพนักงาน">
          <option value="all">ทุกสถานะ</option><option value="active">ทำงาน</option><option value="resigned">ลาออก</option>
        </select>
      </div>
      {list.isError && <ErrorBanner error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      <div className="tw">
        <table data-testid="emp-table">
          <thead>
            <tr><th>รหัส</th><th>ชื่อ</th><th>ตำแหน่ง / ประเภท</th><th>เริ่มงาน</th>{sal && <th className="n">ค่าจ้าง</th>}<th>ผู้ใช้ · บทบาท</th><th>วันลาคงเหลือ (ป่วย / กิจ / พักร้อน)</th><th>สถานะ</th><th /></tr>
          </thead>
          <tbody>
            {loading ? <SkeletonRows cols={cols} /> : list.rows.map((e) => {
              const b = balOf(e.id);
              return (
                <tr key={e.id} className={e.status === 'resigned' ? 'off' : ''}>
                  <td className="mono small">{e.code}</td>
                  <td>{e.name}<div className="small muted">{e.phone}</div></td>
                  <td>{e.position || '-'}<div className="small muted">{EMP_TYPE_TH[e.type]}</div></td>
                  <td className="small">{th(e.startDate)}</td>
                  {sal && <td className="n">{e.type === 'daily' || e.type === 'parttime' ? `${fmt(e.dailyRate)} /วัน` : e.salary && Number(e.salary) ? fmt(e.salary) : '-'}</td>}
                  <td className="small">{e.user ? <><span className="mono">{e.user.username}</span> · {ROLE_TH[e.user.role]}<div className="muted">{e.user.status === 'active' ? 'เปิดใช้งาน' : 'ปิดบัญชีแล้ว'}</div></> : '-'}</td>
                  <td className="small">{e.type === 'external' || e.type === 'owner' || !b ? '-' : (['sick', 'personal', 'vacation'] as const).map((k) => {
                    const x = b.balances.find((y) => y.type === k);
                    return x ? `${fq(x.remaining)}/${x.entitled}` : '-';
                  }).join(' · ')}</td>
                  <td>{e.status === 'active' ? <Pill k="ok">ทำงาน</Pill> : <Pill k="mut">ลาออก {e.resignedAt ? th(e.resignedAt) : ''}</Pill>}</td>
                  <td>
                    <div className="row">
                    {sal && lastRun && e.type !== 'owner' && e.type !== 'external' && (
                      <SlipLink to={`/payslip/${lastRun.period}?emp=${e.id}`} published={lastRun.published} testId={`emp-slip-${e.code}`}>สลิป {periodTH(lastRun.period)}</SlipLink>
                    )}
                    {manage && (
                      <div className="row">
                        <button className="btn sm" onClick={() => setEdit(e)}>แก้ไข</button>
                        {e.status === 'active'
                          ? e.type !== 'owner' && <button className="btn sm bad" onClick={() => setResign(e)}>ลาออก</button>
                          : <button className="btn sm" onClick={() => void rehire(e)}>รับกลับ</button>}
                      </div>
                    )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && list.data && !list.rows.length && <tr><td colSpan={cols} className="empty">ไม่พบพนักงาน</td></tr>}
          </tbody>
        </table>
      </div>
      <LoadMore hasMore={!!list.hasNextPage} loading={list.isFetchingNextPage} onMore={() => void list.fetchNextPage()} count={list.rows.length} testId="emp-more" />
      {edit && <EmpModal emp={edit === 'new' ? null : edit} sal={sal} onClose={() => setEdit(null)} onSaved={(pw) => { setEdit(null); refresh(); if (pw) setCreated(pw); }} />}
      {resign && <ResignModal emp={resign} onClose={() => setResign(null)} onDone={() => { setResign(null); refresh(); }} />}
      {created && (
        <Modal onClose={() => setCreated(null)} label="รหัสผ่านชั่วคราว">
          <h3>สร้างผู้ใช้ {created.username} แล้ว</h3>
          <p className="small" style={{ margin: 0 }}>รหัสผ่านชั่วคราว (แสดงครั้งเดียว) ให้พนักงานเข้าระบบแล้วเปลี่ยนรหัสเอง</p>
          <div className="adm-code" data-testid="temp-password">{created.password}</div>
          <div className="act"><button className="btn pri" onClick={() => setCreated(null)}>จดแล้ว ปิด</button></div>
        </Modal>
      )}
    </>
  );
}

interface Form {
  code: string; name: string; position: string; type: HrEmpType; startDate: string; phone: string; bank: string; bankAccount: string; bankAccountName: string; nationalId: string;
  salary: string; dailyRate: string; commissionPct: string; sso: boolean; ent: HrLeaveEnt;
  username: string; role: z.infer<typeof Role>; pin: string;
}

function EmpModal({ emp, sal, onClose, onSaved }: { emp: HrEmployee | null; sal: boolean; onClose: () => void; onSaved: (pw: { username: string; password: string } | null) => void }) {
  const toast = useToast();
  const isNew = !emp;
  const [f, setF] = useState<Form>(() => ({
    code: emp?.code ?? '', name: emp?.name ?? '', position: emp?.position ?? '', type: emp?.type ?? 'monthly', startDate: emp?.startDate ?? todayYmd(),
    phone: emp?.phone ?? '', bank: emp?.bank ?? '', bankAccount: emp?.bankAccount ?? '', bankAccountName: emp?.bankAccountName ?? '', nationalId: emp?.nationalId ?? '',
    salary: emp?.salary ?? '0', dailyRate: emp?.dailyRate ?? '0', commissionPct: emp?.commissionPct ?? '0', sso: emp?.sso ?? true,
    ent: emp?.leaveEnt ?? { ...DEFAULT_LEAVE_ENTITLEMENT }, username: emp?.user?.username ?? '', role: emp?.user?.role ?? 'cashier', pin: '',
  }));
  const [withUser, setWithUser] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const owner = emp?.type === 'owner';

  const save = async () => {
    const uname = f.username.trim().toLowerCase();
    if (!checkFields({
      name: requiredMsg(f.name, 'ชื่อพนักงาน'),
      'user.username': isNew && withUser && !USERNAME_RE.test(uname) && 'ชื่อผู้ใช้ 3–20 ตัว ใช้ a–z 0–9 . _',
      bank: !f.bank && !!f.bankAccount.trim() && 'เลือกธนาคารของบัญชีนี้',
      bankAccount: !!f.bankAccount.trim() && !/^\d{10,15}$/.test(f.bankAccount.replace(/[\s-]/g, '')) && 'เลขที่บัญชีเป็นตัวเลข 10–15 หลัก',
      'user.pin': !!f.pin && !/^\d{4,6}$/.test(f.pin) && 'PIN อนุมัติเป็นตัวเลข 4–6 หลัก',
      nationalId: sal && !!f.nationalId.trim() && !thaiIdValid(f.nationalId.trim()) && 'เลขบัตรประชาชนไม่ถูกต้อง (13 หลัก ตรวจเลขท้ายไม่ผ่าน)',
    })) return;
    setBusy(true);
    setErr('');
    const base = {
      name: f.name.trim(), position: f.position.trim(), startDate: f.startDate, phone: f.phone.trim(), bank: f.bank, bankAccount: f.bankAccount.trim(), bankAccountName: f.bankAccountName.trim(), leaveEnt: f.ent,
      ...(owner ? {} : { type: f.type }),
      ...(sal ? { salary: f.salary || '0', dailyRate: f.dailyRate || '0', commissionPct: f.commissionPct || '0', sso: f.sso, nationalId: f.nationalId.trim() } : {}),
    };
    try {
      if (isNew) {
        const r = await api('POST', '/api/hr/employees', {
          body: { ...base, code: f.code.trim() || undefined, ...(withUser ? { user: { username: uname, role: f.role, pin: f.pin || undefined } } : {}) },
          schema: HrEmployeeCreated,
        });
        toast(withUser ? `เพิ่มพนักงานและผู้ใช้ ${uname} แล้ว` : 'เพิ่มพนักงานแล้ว');
        onSaved(r.tempPassword ? { username: uname, password: r.tempPassword } : null);
      } else {
        await api('PATCH', `/api/hr/employees/${emp.id}`, { body: { ...base, ...(emp.user && !owner ? { role: f.role } : {}) }, schema: HrEmployee });
        toast('บันทึกพนักงานแล้ว');
        onSaved(null);
      }
    } catch (e) {
      setErr(admErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} wide label={isNew ? 'เพิ่มพนักงาน' : 'แก้ไขพนักงาน'}>
      <h3>{isNew ? 'เพิ่มพนักงาน' : `แก้ไข · ${emp.name}`}</h3>
      <h4 className="sec">ข้อมูลพนักงาน</h4>
      <div className="fgrid">
        <label className="f">รหัสพนักงาน<input type="text" name="code" value={f.code} readOnly={!isNew} placeholder="เว้นว่าง ระบบตั้งให้" onChange={(e) => set('code', e.target.value)} /></label>
        <label className="f">ชื่อ-สกุล / ชื่อเรียก *<input type="text" name="name" value={f.name} onChange={(e) => set('name', e.target.value)} data-testid="emp-name" /></label>
        <label className="f">ตำแหน่ง<input type="text" value={f.position} placeholder="เช่น แคชเชียร์" onChange={(e) => set('position', e.target.value)} data-testid="emp-position" /></label>
        <label className="f">ประเภทการจ้าง
          <select value={f.type} disabled={owner} onChange={(e) => set('type', e.target.value as HrEmpType)} data-testid="emp-type">
            {(owner ? (['owner'] as HrEmpType[]) : TYPES).map((t) => <option key={t} value={t}>{EMP_TYPE_TH[t]}</option>)}
          </select>
        </label>
        <label className="f">วันเริ่มงาน<input type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></label>
        <label className="f">เบอร์โทร<input type="text" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
      </div>
      <h4 className="sec">บัญชีรับเงินเดือน</h4>
      <div className="fgrid">
        <label className="f">ธนาคาร
          <select name="bank" value={f.bank} onChange={(e) => set('bank', e.target.value)} data-testid="emp-bank">
            <option value="">— เลือกธนาคาร —</option>
            {THAI_BANKS.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>
        </label>
        <label className="f">เลขที่บัญชี<input type="text" name="bankAccount" inputMode="numeric" value={f.bankAccount} placeholder="เช่น 012-3-45678-9" onChange={(e) => set('bankAccount', e.target.value)} data-testid="emp-bank-account" /></label>
        <label className="f" style={{ gridColumn: 'span 2' }}>ชื่อบัญชี<input type="text" name="bankAccountName" value={f.bankAccountName} placeholder="ชื่อตามสมุดบัญชี" onChange={(e) => set('bankAccountName', e.target.value)} data-testid="emp-bank-name" /></label>
      </div>
      {sal ? (
        <>
          <h4 className="sec">ค่าจ้างและข้อมูลส่วนบุคคล (เห็นเฉพาะเจ้าของร้าน)</h4>
          <div className="fgrid">
            <label className="f">เงินเดือน (บาท/เดือน)<input type="number" min="0" name="salary" value={f.salary} onChange={(e) => set('salary', e.target.value)} data-testid="emp-salary" /></label>
            <label className="f">ค่าจ้างรายวัน (บาท/วัน)<input type="number" min="0" name="dailyRate" value={f.dailyRate} onChange={(e) => set('dailyRate', e.target.value)} data-testid="emp-daily" /></label>
            <label className="f">คอมมิชชัน (% ยอดขายก่อน VAT)<input type="number" min="0" step="0.1" value={f.commissionPct} onChange={(e) => set('commissionPct', e.target.value)} /></label>
            <label className="f">เลขบัตรประชาชน<input type="text" inputMode="numeric" maxLength={17} name="nationalId" value={f.nationalId} onChange={(e) => set('nationalId', e.target.value)} /></label>
            <label className="row small"><input type="checkbox" checked={f.sso} onChange={(e) => set('sso', e.target.checked)} /> หักประกันสังคม</label>
          </div>
        </>
      ) : <div className="note small">ค่าจ้างและเลขบัตรประชาชนดูและแก้ได้เฉพาะเจ้าของร้าน</div>}
      <h4 className="sec">สิทธิ์วันลาต่อปี (วัน) · ค่าเริ่มต้นตามกฎหมายแรงงาน</h4>
      <div className="fgrid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))' }}>
        {ENT_KEYS.map(([k, l]) => (
          <label key={k} className="f">{l}<input type="number" min="0" max="366" value={f.ent[k]} onChange={(e) => set('ent', { ...f.ent, [k]: Number(e.target.value) || 0 })} /></label>
        ))}
      </div>
      <h4 className="sec">บัญชีผู้ใช้ (สร้างพร้อมพนักงาน · ลบไม่ได้)</h4>
      {isNew && <label className="row small"><input type="checkbox" checked={withUser} onChange={(e) => setWithUser(e.target.checked)} /> สร้างผู้ใช้เข้าระบบให้พนักงานคนนี้</label>}
      {(isNew ? withUser : !!emp.user) ? (
        <div className="fgrid">
          <label className="f">ชื่อผู้ใช้ *<input type="text" data-field="user.username" value={f.username} readOnly={!isNew} autoComplete="off" placeholder="ภาษาอังกฤษ เช่น prae" onChange={(e) => set('username', e.target.value)} data-testid="emp-username" /></label>
          <label className="f">บทบาท (สิทธิ์)
            <select value={f.role} disabled={owner} onChange={(e) => set('role', e.target.value as Form['role'])} data-testid="emp-role">
              {(owner ? Role.options : ROLES).map((r) => <option key={r} value={r}>{ROLE_TH[r]}</option>)}
            </select>
          </label>
          {isNew && <label className="f">PIN อนุมัติ (ผู้จัดการ · ไม่บังคับ)<input type="password" inputMode="numeric" maxLength={6} data-field="user.pin" value={f.pin} onChange={(e) => set('pin', e.target.value)} /></label>}
          {isNew && <div className="small muted" style={{ alignSelf: 'end' }}>รหัสผ่าน: ระบบตั้งรหัสชั่วคราวให้และแสดงครั้งเดียวหลังบันทึก</div>}
        </div>
      ) : <div className="small muted">{isNew ? 'ไม่สร้างผู้ใช้ (เช่น พนักงานที่ไม่ใช้ระบบ)' : 'พนักงานคนนี้ไม่มีผู้ใช้ · สร้างผู้ใช้ได้ตอนเพิ่มพนักงานเท่านั้น'}</div>}
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn pri" disabled={busy} onClick={() => void save()} data-testid="emp-save">บันทึก</button>
      </div>
    </Modal>
  );
}

function ResignModal({ emp, onClose, onDone }: { emp: HrEmployee; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(todayYmd());
  const [reason, setReason] = useState(RESIGN_REASONS[0]!);
  const [err, setErr] = useState('');
  const ok = async () => {
    try {
      await api('POST', `/api/hr/employees/${emp.id}/resign`, { body: { date, reason }, schema: HrEmployee });
      toast(`บันทึกลาออก ${emp.name} แล้ว · ปิดบัญชีผู้ใช้`);
      onDone();
    } catch (e) {
      setErr(admErr(e));
    }
  };
  return (
    <Modal onClose={onClose} label="บันทึกลาออก">
      <h3>บันทึกลาออก · {emp.name}</h3>
      <div className="fgrid">
        <label className="f">วันที่มีผล<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="f">เหตุผล<select value={reason} onChange={(e) => setReason(e.target.value)} data-testid="resign-reason">{RESIGN_REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
      </div>
      <div className="note small">บัญชีผู้ใช้ <b className="mono">{emp.user?.username ?? '-'}</b> จะถูกปิดทันที เข้าระบบไม่ได้ · ไม่ลบข้อมูล ประวัติการขายและ log ที่ลงชื่อคนนี้ยังอยู่ครบ · รับกลับเข้าทำงานได้ภายหลัง</div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="act">
        <button className="btn" onClick={onClose}>ยกเลิก</button>
        <button className="btn bad" onClick={() => void ok()} data-testid="resign-ok">ยืนยันลาออก</button>
      </div>
    </Modal>
  );
}
