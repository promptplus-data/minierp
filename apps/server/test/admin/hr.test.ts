/** M17 HR: employees + users (REQ-M17-01, REQ-M01-10, BR-18), leave (REQ-M17-04/05), payroll (REQ-M17-02/03/06). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAdmin } from '@erp/db/src/seedAdmin';
import { client, login, openShift, saleBody, setupEnv, type Client, type Env } from '../helpers';

let env: Env;
let owner: Client;
let suda: Client;
let prae: Client;
let emp: Record<string, string>;

beforeAll(async () => {
  env = await setupEnv();
  emp = (await seedAdmin(env.pool, env.seed.tenantId)).employees;
  await seedAdmin(env.pool, env.seed.tenantId); // idempotent
  owner = await login(env.app, 'charoen');
  suda = await login(env.app, 'suda');
  prae = await login(env.app, 'prae');
});
afterAll(async () => { await env.close(); });

const newEmp = (over: Record<string, unknown> = {}) => ({
  name: 'นายสมชาย ใจดี', position: 'พนักงานขาย', type: 'monthly', startDate: '2026-10-01', salary: '18000.00', nationalId: '1101700230708',
  bank: 'KBANK', bankAccount: '111-1-11111-1', bankAccountName: 'นายสมชาย ใจดี', user: { username: 'somchai', role: 'sales' }, ...over,
});

describe('employees with their login user (REQ-M17-01, REQ-M01-10)', () => {
  let id: string;
  it('creates the employee and the user together, returns a one-time temporary password and audits it', async () => {
    const r = await owner.post('/api/hr/employees', newEmp());
    expect(r.status).toBe(201);
    expect(r.body.employee.code).toBe('EMP006');
    expect(r.body.employee.user).toMatchObject({ username: 'somchai', role: 'sales', status: 'active' });
    expect(r.body.tempPassword).toMatch(/^.{8}$/);
    id = r.body.employee.id;
    const lg = await client(env.app).post('/api/auth/login', { username: 'somchai', password: r.body.tempPassword });
    expect(lg.status).toBe(200);
    const a = await env.pool.query(`select action, object, ref from audit_log where tenant_id = $1 order by chain_seq desc limit 3`, [env.seed.tenantId]);
    expect(a.rows.some((x) => x.object === 'employee+user' && x.ref === 'EMP006')).toBe(true);
  });

  it('usernames are unique in the shop including resigned staff (ton) and follow a-z 0-9 . _ 3-20', async () => {
    expect((await owner.post('/api/hr/employees', newEmp({ user: { username: 'ton', role: 'wh' } }))).body.details.reason).toBe('USERNAME_TAKEN');
    expect((await owner.post('/api/hr/employees', newEmp({ user: { username: 'Ab', role: 'wh' } }))).status).toBe(400);
    expect((await owner.post('/api/hr/employees', newEmp({ user: { username: 'x', role: 'owner' } }))).status).toBe(400);
  });

  it('salary account: bank from the list, number and account name; an unknown bank code is refused; changes are audited without the number', async () => {
    const e = (await owner.get(`/api/hr/employees/${id}`)).body;
    expect(e).toMatchObject({ bank: 'KBANK', bankAccount: '111-1-11111-1', bankAccountName: 'นายสมชาย ใจดี' });
    expect((await owner.patch(`/api/hr/employees/${id}`, { bank: 'XYZ' })).status).toBe(400);
    const u = await owner.patch(`/api/hr/employees/${id}`, { bank: 'SCB', bankAccount: '404-9-99999-9' });
    expect(u.body).toMatchObject({ bank: 'SCB', bankAccount: '404-9-99999-9' });
    const a = await env.pool.query(`select detail from audit_log where tenant_id = $1 and ref = 'EMP006' order by chain_seq desc limit 1`, [env.seed.tenantId]);
    expect(a.rows[0].detail).toMatch(/ธนาคาร/);
    expect(a.rows[0].detail).not.toMatch(/404-9/);
    await owner.patch(`/api/hr/employees/${id}`, { bank: 'KBANK', bankAccount: '111-1-11111-1' });
  });

  it('rejects a national id with a wrong check digit', async () => {
    expect((await owner.post('/api/hr/employees', newEmp({ nationalId: '1101700230706', user: undefined }))).status).toBe(400);
  });

  it('pay and national id are hidden from a manager (no hr.salary) and a manager cannot set them', async () => {
    const r = await suda.get(`/api/hr/employees/${id}`);
    expect(r.body.salary).toBeNull();
    expect(r.body.nationalId).toBe('x-xxxx-xxxxx-70-8');
    expect((await suda.patch(`/api/hr/employees/${id}`, { salary: '99999.00' })).status).toBe(403);
    expect((await suda.patch(`/api/hr/employees/${id}`, { position: 'หัวหน้าฝ่ายขาย' })).body.position).toBe('หัวหน้าฝ่ายขาย');
    expect((await prae.get('/api/hr/employees')).status).toBe(403);
  });

  it('resign = status + login closed (logged as failed login); never deleted; rehire reopens the same account (BR-18)', async () => {
    const r = await owner.post(`/api/hr/employees/${id}/resign`, { date: '2026-10-26', reason: 'ย้ายงาน' });
    expect(r.body).toMatchObject({ status: 'resigned', resignedAt: '2026-10-26', user: { status: 'resigned' } });
    const lg = await client(env.app).post('/api/auth/login', { username: 'somchai', password: 'whatever' });
    expect(lg.status).toBe(401);
    await expect(env.pool.query(`delete from employees where id = $1`, [id])).rejects.toThrow(/never deleted/);
    const list = await owner.get('/api/hr/employees?status=resigned');
    expect(list.body.items.map((e: { code: string }) => e.code)).toEqual(['EMP005', 'EMP006']);
    const back = await owner.post(`/api/hr/employees/${id}/rehire`, {});
    expect(back.body).toMatchObject({ status: 'active', user: { username: 'somchai', status: 'active' } });
  });

  it('the owner cannot resign; list is cursor-paged with search', async () => {
    expect((await owner.post(`/api/hr/employees/${emp.OWN001}/resign`, { date: '2026-10-26', reason: 'x' })).status).toBe(403);
    const p1 = await owner.get('/api/hr/employees?limit=3');
    expect(p1.body.items).toHaveLength(3);
    const p2 = await owner.get(`/api/hr/employees?limit=3&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].code > p1.body.items[2].code).toBe(true);
    expect((await owner.get('/api/hr/employees?q=คลัง')).body.items.map((e: { code: string }) => e.code)).toEqual(['EMP004', 'EMP005']);
  });
});

describe('leave (REQ-M17-04/05)', () => {
  it('balances use the per-person entitlement (legal defaults) and approved days', async () => {
    const r = await owner.get('/api/hr/leave-balances?year=2026');
    const praeRow = r.body.items.find((x: { code: string }) => x.code === 'EMP002');
    expect(praeRow.balances.find((b: { type: string }) => b.type === 'sick')).toMatchObject({ entitled: 30, used: '2', remaining: '28' });
  });

  it('own request waits for approval; over-entitlement warns and can be deducted; no self-approval', async () => {
    // personal leave entitlement is 3 days; prae asks for 4 working days (Sun excluded)
    const r = await prae.post('/api/hr/leaves', { type: 'personal', fromDate: '2026-11-09', toDate: '2026-11-12', reason: 'ธุระครอบครัว', deduct: true });
    expect(r.status).toBe(201);
    expect(r.body.leave).toMatchObject({ status: 'pending', days: '4', overDays: '1', deduct: true });
    expect(r.body.warning).toContain('เกินสิทธิ์ 1 วัน');
    expect((await prae.post(`/api/hr/leaves/${r.body.leave.id}/approve`, {})).status).toBe(403);
    const ok = await suda.post(`/api/hr/leaves/${r.body.leave.id}/approve`, {});
    expect(ok.body.leave.status).toBe('approved');
    expect((await suda.post(`/api/hr/leaves/${r.body.leave.id}/approve`, {})).status).toBe(409);
  });

  it('a cashier sees only own leave; Sundays do not count; half day = 0.5', async () => {
    const mine = await prae.get('/api/hr/leaves');
    expect(mine.body.items.every((l: { employeeName: string }) => l.employeeName === 'น้องแพร')).toBe(true);
    const sun = await owner.post('/api/hr/leaves', { employeeId: emp.EMP004, type: 'sick', fromDate: '2026-11-01', toDate: '2026-11-01' });
    expect(sun.status).toBe(400);
    const half = await owner.post('/api/hr/leaves', { employeeId: emp.EMP004, type: 'sick', fromDate: '2026-11-03', toDate: '2026-11-03', halfDay: true });
    expect(half.body.leave).toMatchObject({ days: '0.5', status: 'approved' }); // recorded by a manager for someone else
  });
});

describe('payroll (REQ-M17-02/03/06)', () => {
  it('SSO 5% capped at the configurable ceiling 17,500; owner-only (hr.salary)', async () => {
    expect((await suda.post('/api/hr/payroll', { period: '2026-10' })).status).toBe(403);
    const r = await owner.post('/api/hr/payroll', { period: '2026-10' });
    expect(r.status).toBe(201);
    const s = r.body.lines.find((l: { code: string }) => l.code === 'EMP001'); // salary 25,000
    expect(s).toMatchObject({ base: '25000.00', sso: '875.00' });
    expect(r.body.lines.map((l: { code: string }) => l.code)).not.toContain('OWN001');
    expect(r.body.lines.map((l: { code: string }) => l.code)).not.toContain('EMP005');
    expect((await owner.post('/api/hr/payroll', { period: '2026-10' })).status).toBe(409);
    await owner.patch('/api/hr/settings', { ssoCap: '15000.00' });
    // the run keeps the rate it was created with; a new month uses the new ceiling
    const nov = await owner.post('/api/hr/payroll', { period: '2026-11' });
    expect(nov.body.lines.find((l: { code: string }) => l.code === 'EMP001').sso).toBe('750.00');
    await owner.patch('/api/hr/settings', { ssoCap: '17500.00' });
  });

  it('daily pay x days, OT, allowance, advance; commission from own sales; unpaid leave deducted at salary/30', async () => {
    const run = (await owner.get('/api/hr/payroll/2026-10')).body;
    const chai = run.lines.find((l: { code: string }) => l.code === 'EMP004');
    const r = await owner.patch(`/api/hr/payroll/2026-10/lines/${chai.id}`, { days: '24', ot: '600.00', allowance: '300.00', advance: '1000.00' });
    const c2 = r.body.lines.find((l: { code: string }) => l.code === 'EMP004');
    expect(c2).toMatchObject({ base: '10800.00', gross: '11700.00', sso: '585.00' });
    expect(c2.net).toBe((11700 - 585 - Number(c2.tax) - 1000).toFixed(2));

    // boy (1% commission) sells; recalc picks up sales ex VAT
    const boy = await login(env.app, 'boy');
    const shift = await openShift(boy);
    await boy.post('/api/sales/pos', { ...saleBody(env.seed, shift, [{ p: 'p1', qty: '10', price: '145.00' }], '1450.00'), date: '2026-10-26' });
    // prae has 1 deducted over-entitlement day in Nov (daily staff: no salary deduction) — check a monthly one instead
    const unpaid = await owner.post('/api/hr/leaves', { employeeId: emp.EMP001, type: 'unpaid', fromDate: '2026-10-20', toDate: '2026-10-20' });
    expect(unpaid.body.leave.deduct).toBe(true);
    const re = await owner.post('/api/hr/payroll/2026-10/recalc', {});
    const boyLine = re.body.lines.find((l: { code: string }) => l.code === 'EMP003');
    expect(Number(boyLine.commissionBase)).toBeCloseTo(1355.14, 2);
    expect(boyLine.commission).toBe('13.55');
    const suda1 = re.body.lines.find((l: { code: string }) => l.code === 'EMP001');
    expect(suda1).toMatchObject({ unpaidDays: '1', unpaidAmt: '833.33', gross: '24166.67' });
    // inputs survive recalc
    expect(re.body.lines.find((l: { code: string }) => l.code === 'EMP004').ot).toBe('600.00');
  });

  it('draft → approved → paid; locked after paid (API and database)', async () => {
    const run = (await owner.get('/api/hr/payroll/2026-10')).body;
    expect((await owner.post('/api/hr/payroll/2026-10/pay', {})).status).toBe(409); // must approve first
    expect((await owner.post('/api/hr/payroll/2026-10/approve', {})).body.status).toBe('approved');
    expect((await owner.patch(`/api/hr/payroll/2026-10/lines/${run.lines[0].id}`, { ot: '1.00' })).body.details.reason).toBe('PAYROLL_LOCKED');
    expect((await owner.post('/api/hr/payroll/2026-10/reopen', {})).body.status).toBe('draft');
    await owner.post('/api/hr/payroll/2026-10/approve', {});
    const paid = await owner.post('/api/hr/payroll/2026-10/pay', { payDate: '2026-10-31' });
    expect(paid.body).toMatchObject({ status: 'paid', payDate: '2026-10-31' });
    expect((await owner.post('/api/hr/payroll/2026-10/reopen', {})).body.details.reason).toBe('PAYROLL_LOCKED');
    expect((await owner.post('/api/hr/payroll/2026-10/recalc', {})).status).toBe(409);
    await expect(env.pool.query(`update payroll_lines set net = 0 where run_id = $1`, [run.id])).rejects.toThrow(/draft/);
    await expect(env.pool.query(`update payroll_runs set status = 'draft' where id = $1`, [run.id])).rejects.toThrow(/locked/);
    await expect(env.pool.query(`delete from payroll_runs where id = $1`, [run.id])).rejects.toThrow(/never deleted/);
  });

  it('payslips per person or whole month with amount in Thai words; staff see only their own slip of a paid month', async () => {
    const all = await owner.get('/api/hr/payroll/2026-10/slips');
    expect(all.body.items.length).toBe(5); // EMP001-004 + EMP006 (rehired, started 1 Oct)
    const s = all.body.items.find((x: { employee: { code: string } }) => x.employee.code === 'EMP001');
    expect(s).toMatchObject({ periodLabel: 'ต.ค. 2569', payDate: '2026-10-31', employee: { bankAccount: 'ธนาคารกสิกรไทย 012-3-11111-1 (คุณสุดา ศรีสุข)' } });
    expect(s.netText).toMatch(/บาท/);
    const ded = s.deductions.reduce((n: number, x: { amount: string }) => n + Number(x.amount), 0);
    expect((Number(s.gross) - ded).toFixed(2)).toBe(s.net);
    const one = await owner.get(`/api/hr/payroll/2026-10/slips?employeeId=${emp.EMP004}`);
    expect(one.body.items).toHaveLength(1);
    const mine = await prae.get('/api/hr/payroll/2026-10/slips');
    expect(mine.body.items.map((x: { employee: { code: string } }) => x.employee.code)).toEqual(['EMP002']);
    expect((await prae.get(`/api/hr/payroll/2026-10/slips?employeeId=${emp.EMP004}`)).status).toBe(403);
    expect((await prae.get('/api/hr/payroll/2026-11/slips')).status).toBe(403); // November is a draft
  });

  it('labour cost = gross + employer SSO per approved/paid month (REQ-M17-06)', async () => {
    const r = await owner.get('/api/hr/labour-cost');
    expect(r.body.items.map((x: { period: string }) => x.period)).toEqual(['2026-10', '2026-09']);
    const oct = r.body.items[0];
    expect(Number(oct.total)).toBeCloseTo(Number(oct.gross) + Number(oct.employerSso), 2);
    expect((await prae.get('/api/hr/labour-cost')).status).toBe(403);
  });
});
