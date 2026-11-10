/**
 * M17 HR: employees with their login user (REQ-M17-01, REQ-M01-10), leave (REQ-M17-04/05), monthly payroll with
 * core.payRow (REQ-M17-02), payslips (REQ-M17-03) and labour cost (REQ-M17-06). Nothing here is ever deleted (BR-18).
 */
import { searchTokens } from '@erp/core';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { z } from 'zod';
import type { Tx } from '@erp/db';
import type {
  HrEmployee, HrEmployeeCreate, HrEmployeeQuery, HrEmployeeUpdate, HrLeave, HrLeaveCreate, HrLeaveQuery, HrPayrollLine, HrPayrollLineUpdate,
  HrPayrollRun, HrPayslip, HrSettingsUpdate, HrLeaveEnt,
} from '@erp/contracts';
import {
  bahtText, d, deductibleDays, defaultEntitlement, leaveBalances, leaveDays, money, overEntitlement, payRow, periodRange, periodTH,
  sum, thaiIdValid, maskThaiId, type LeaveKind, type LeaveRecord, type PayrollConfig,
} from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { can, requireAny, requirePerm, type Ctx } from '../../lib/context';
import { nextDocNo } from '../../lib/docno';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, likeEscape, pageOf } from '../../lib/paging';

type In<T extends z.ZodTypeAny> = z.output<T>;

const EMP_TH: Record<string, string> = { monthly: 'รายเดือน', daily: 'รายวัน', parttime: 'พาร์ทไทม์', external: 'บุคคลภายนอก', owner: 'เจ้าของกิจการ' };
const isDaily = (t: string) => t === 'daily' || t === 'parttime';
/** Staff on the payroll (mockup payStaff): not outside contractors, not the owner. */
const PAYROLL_TYPES = ['monthly', 'daily', 'parttime'];

// ---------------------------------------------------------------- settings
export async function hrSettings(tx: Tx, tenantId: string): Promise<PayrollConfig & { ssoRate: string; ssoCap: string; ssoFloor: string }> {
  const r = await tx.query<{ sso_rate: string; sso_cap: string; sso_floor: string }>(`select sso_rate::text, sso_cap::text, sso_floor::text from adm_settings where tenant_id = $1`, [tenantId]);
  const s = r.rows[0] ?? { sso_rate: '0.0500', sso_cap: '17500.00', sso_floor: '1650.00' };
  return { ssoRate: d(s.sso_rate).toString(), ssoCap: money(s.sso_cap), ssoFloor: money(s.sso_floor) };
}

export async function updateHrSettings(tx: Tx, ctx: Ctx, body: In<typeof HrSettingsUpdate>) {
  requirePerm(ctx, 'hr.salary');
  const before = await hrSettings(tx, ctx.tenantId);
  const next = { ssoRate: body.ssoRate ?? before.ssoRate, ssoCap: body.ssoCap ?? before.ssoCap, ssoFloor: body.ssoFloor ?? before.ssoFloor };
  if (d(next.ssoRate).gt(1) || d(next.ssoCap).lte(0)) throw E.validation('SSO rate must be 0..1 and the ceiling above 0');
  await tx.query(
    `insert into adm_settings (tenant_id, sso_rate, sso_cap, sso_floor) values ($1,$2,$3,$4)
     on conflict (tenant_id) do update set sso_rate = excluded.sso_rate, sso_cap = excluded.sso_cap, sso_floor = excluded.sso_floor, updated_at = now()`,
    [ctx.tenantId, next.ssoRate, next.ssoCap, next.ssoFloor],
  );
  const after = await hrSettings(tx, ctx.tenantId);
  await writeAudit(tx, ctx, [{ action: 'update', object: 'settings', ref: 'hr', detail: `ประกันสังคม ${before.ssoRate}/${before.ssoCap} → ${after.ssoRate}/${after.ssoCap}` }]);
  return after;
}

// ---------------------------------------------------------------- employees
interface EmpRow {
  id: string; code: string; name: string; position: string; emp_type: HrEmployee['type']; start_date: string; salary: string; daily_rate: string;
  commission_pct: string; sso: boolean; bank_account: string; national_id: string; phone: string; leave_ent: HrLeaveEnt; status: 'active' | 'resigned';
  resigned_at: string | null; resign_reason: string | null; user_id: string | null; u_username: string | null; u_role: HrEmployee['user'] extends infer U ? U extends { role: infer R } ? R : never : never; u_status: string | null;
}
const EMP_SELECT = `select e.id, e.code, e.name, e.position, e.emp_type, e.start_date, e.salary::text, e.daily_rate::text, e.commission_pct::text, e.sso,
  e.bank_account, e.national_id, e.phone, e.leave_ent, e.status, e.resigned_at, e.resign_reason, e.user_id,
  u.username u_username, u.role u_role, u.status u_status
  from employees e left join users u on u.id = e.user_id`;

function toEmployee(r: EmpRow, ctx: Ctx): HrEmployee {
  const pay = can(ctx, 'hr.salary') === 1;
  return {
    id: r.id, code: r.code, name: r.name, position: r.position, type: r.emp_type, startDate: r.start_date,
    salary: pay ? money(r.salary) : null, dailyRate: pay ? money(r.daily_rate) : null, commissionPct: pay ? d(r.commission_pct).toString() : null,
    sso: r.sso, bankAccount: r.bank_account, nationalId: pay ? r.national_id : maskThaiId(r.national_id), phone: r.phone, leaveEnt: r.leave_ent,
    status: r.status, resignedAt: r.resigned_at, resignReason: r.resign_reason,
    user: r.user_id ? { id: r.user_id, username: r.u_username!, role: r.u_role, status: r.u_status! } : null,
  };
}

async function loadEmp(tx: Tx, id: string, lock = false): Promise<EmpRow> {
  if (!isUuid(id)) throw E.notFound('Employee not found');
  const r = await tx.query<EmpRow>(`${EMP_SELECT} where e.id = $1 ${lock ? 'for update of e' : ''}`, [id]);
  if (!r.rows[0]) throw E.notFound('Employee not found');
  return r.rows[0];
}

export async function getEmployee(tx: Tx, ctx: Ctx, id: string): Promise<HrEmployee> {
  const e = await loadEmp(tx, id);
  if (e.user_id !== ctx.userId) requireAny(ctx, ['hr.manage', 'hr.leave'], { readOnly: true });
  return toEmployee(e, ctx);
}

export async function myEmployee(tx: Tx, ctx: Ctx): Promise<HrEmployee | null> {
  const r = await tx.query<EmpRow>(`${EMP_SELECT} where e.user_id = $1`, [ctx.userId]);
  return r.rows[0] ? toEmployee(r.rows[0], ctx) : null;
}

export async function listEmployees(tx: Tx, ctx: Ctx, q: In<typeof HrEmployeeQuery>) {
  requireAny(ctx, ['hr.manage', 'hr.leave', 'hr.salary'], { readOnly: true });
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status !== 'all') {
    params.push(q.status);
    where.push(`e.status = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(e.name ilike $${params.length} or e.code ilike $${params.length} or e.position ilike $${params.length} or coalesce(u.username,'') ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(e.code, e.id) > ($${params.length - 1}, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<EmpRow>(`${EMP_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by e.code, e.id limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (e) => [e.code, e.id], (e) => toEmployee(e, ctx));
}

function checkNationalId(id: string | undefined) {
  if (id && id.trim() && !thaiIdValid(id)) throw E.validation('National ID must be 13 digits with a valid check digit', { field: 'nationalId' });
}

async function nextEmpCode(tx: Tx, type: string): Promise<string> {
  const prefix = type === 'external' ? 'EXT' : 'EMP';
  const r = await tx.query<{ n: number | null }>(`select max(substring(code from '^${prefix}(\\d+)$')::int) n from employees`);
  return prefix + String((r.rows[0]?.n ?? 0) + 1).padStart(3, '0');
}

const tempPassword = () => randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);

export async function createEmployee(tx: Tx, ctx: Ctx, body: In<typeof HrEmployeeCreate>, today: string): Promise<{ employee: HrEmployee; tempPassword: string | null }> {
  requirePerm(ctx, 'hr.manage');
  if (body.type === 'owner') throw E.validation('The owner record is created with the shop');
  checkNationalId(body.nationalId);
  const pay = can(ctx, 'hr.salary') === 1;
  const code = body.code?.trim() || (await nextEmpCode(tx, body.type));
  const ent = body.leaveEnt ?? defaultEntitlement(body.startDate, Number(today.slice(0, 4)));
  let userId: string | null = null;
  let temp: string | null = null;
  if (body.user) {
    const taken = await tx.query(`select 1 from users where username = $1`, [body.user.username]);
    if (taken.rowCount) throw E.conflict(`Username ${body.user.username} is already used in this shop (including resigned staff)`, { reason: 'USERNAME_TAKEN' });
    if (body.user.pin && !['manager'].includes(body.user.role)) {
      // Only owners and managers approve with a PIN; a PIN for other roles is stored but unused.
    }
    temp = body.user.password ? null : tempPassword();
    const hash = await argon2.hash(body.user.password ?? temp!, { type: argon2.argon2id });
    const pin = body.user.pin ? await argon2.hash(body.user.pin, { type: argon2.argon2id }) : null;
    const u = await tx.query<{ id: string }>(
      `insert into users (tenant_id, username, name, role, password_hash, pin_hash, phone) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [ctx.tenantId, body.user.username, body.name, body.user.role, hash, pin, body.phone || null],
    );
    userId = u.rows[0]!.id;
  }
  const r = await tx.query<{ id: string }>(
    `insert into employees (tenant_id, code, name, position, emp_type, start_date, salary, daily_rate, commission_pct, sso, bank_account, national_id, phone, leave_ent, user_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [ctx.tenantId, code, body.name, body.position, body.type, body.startDate, pay ? body.salary : '0', pay ? body.dailyRate : '0', pay ? body.commissionPct : '0',
      body.sso, body.bankAccount, body.nationalId.replace(/[\s-]/g, ''), body.phone, JSON.stringify(ent), userId, ctx.userId],
  );
  const e = await loadEmp(tx, r.rows[0]!.id);
  await writeAudit(tx, ctx, [{
    action: 'create', object: body.user ? 'employee+user' : 'employee', ref: code,
    detail: `${body.name} · ${body.position || EMP_TH[body.type]}${body.user ? ` · ผู้ใช้ ${body.user.username} (${body.user.role})` : ''}`,
  }]);
  return { employee: toEmployee(e, ctx), tempPassword: temp };
}

export async function updateEmployee(tx: Tx, ctx: Ctx, id: string, body: In<typeof HrEmployeeUpdate>): Promise<HrEmployee> {
  requirePerm(ctx, 'hr.manage');
  const e = await loadEmp(tx, id, true);
  const payKeys = (['salary', 'dailyRate', 'commissionPct', 'nationalId'] as const).filter((k) => body[k] !== undefined);
  if (payKeys.length && can(ctx, 'hr.salary') !== 1) throw E.forbidden('Only the owner may change pay or the national ID (hr.salary)', { perm: 'hr.salary' });
  checkNationalId(body.nationalId);
  if (body.type === 'owner' && e.emp_type !== 'owner') throw E.validation('Cannot turn an employee into the owner');
  const set: string[] = [];
  const params: unknown[] = [];
  const changes: string[] = [];
  const col = (c: string, v: unknown, label: string, old: unknown, secret = false) => {
    if (v === undefined || String(v) === String(old)) return;
    params.push(v);
    set.push(`${c} = $${params.length}`);
    changes.push(secret ? label : `${label}: ${String(old)} → ${String(v)}`);
  };
  col('code', body.code, 'รหัส', e.code);
  col('name', body.name, 'ชื่อ', e.name);
  col('position', body.position, 'ตำแหน่ง', e.position);
  col('emp_type', body.type, 'ประเภท', e.emp_type);
  col('start_date', body.startDate, 'วันเริ่มงาน', e.start_date);
  if (body.salary !== undefined && !d(body.salary).eq(e.salary)) col('salary', body.salary, 'แก้เงินเดือน', e.salary, true);
  if (body.dailyRate !== undefined && !d(body.dailyRate).eq(e.daily_rate)) col('daily_rate', body.dailyRate, 'แก้ค่าจ้างรายวัน', e.daily_rate, true);
  if (body.commissionPct !== undefined && !d(body.commissionPct).eq(e.commission_pct)) col('commission_pct', body.commissionPct, 'แก้คอมมิชชัน', e.commission_pct, true);
  col('sso', body.sso, 'ประกันสังคม', e.sso);
  col('bank_account', body.bankAccount, 'บัญชีธนาคาร', e.bank_account, true);
  if (body.nationalId !== undefined) col('national_id', body.nationalId.replace(/[\s-]/g, ''), 'แก้เลขบัตรประชาชน', e.national_id, true);
  col('phone', body.phone, 'โทร', e.phone);
  if (body.leaveEnt && JSON.stringify(body.leaveEnt) !== JSON.stringify(e.leave_ent)) {
    params.push(JSON.stringify(body.leaveEnt));
    set.push(`leave_ent = $${params.length}`);
    changes.push(`สิทธิ์ลา: ${JSON.stringify(e.leave_ent)} → ${JSON.stringify(body.leaveEnt)}`);
  }
  if (set.length) {
    params.push(id);
    await tx.query(`update employees set ${set.join(', ')}, updated_at = now() where id = $${params.length}`, params);
  }
  if (e.user_id && (body.name !== undefined || body.role !== undefined)) {
    if (body.role && e.u_role === 'owner') throw E.forbidden('The owner role cannot be changed here');
    if (body.role && body.role !== e.u_role) changes.push(`บทบาท: ${e.u_role} → ${body.role}`);
    await tx.query(`update users set name = coalesce($2, name), role = coalesce($3, role) where id = $1`, [e.user_id, body.name ?? null, body.role ?? null]);
  } else if (body.role) throw E.validation('This employee has no login user');
  const after = await loadEmp(tx, id);
  await writeAudit(tx, ctx, [{ action: 'update', object: 'employee', ref: after.code, detail: changes.join(' · ') || 'ไม่มีการเปลี่ยนแปลง' }]);
  return toEmployee(after, ctx);
}

/** BR-18: resign = status + the login user is closed; nothing is deleted. */
export async function resignEmployee(tx: Tx, ctx: Ctx, id: string, body: { date: string; reason: string }): Promise<HrEmployee> {
  requirePerm(ctx, 'hr.manage');
  const e = await loadEmp(tx, id, true);
  if (e.status !== 'active') throw E.conflict('Employee has already resigned');
  if (e.u_role === 'owner' || e.emp_type === 'owner') throw E.forbidden('The owner cannot resign');
  if (e.user_id === ctx.userId) throw E.forbidden('You cannot resign yourself');
  await tx.query(`update employees set status = 'resigned', resigned_at = $2, resign_reason = $3, updated_at = now() where id = $1`, [id, body.date, body.reason]);
  if (e.user_id) await tx.query(`update users set status = 'resigned' where id = $1`, [e.user_id]);
  await writeAudit(tx, ctx, [{ action: 'resign', object: 'employee', ref: e.code, detail: `${e.name} · ${body.reason} · มีผล ${body.date}${e.u_username ? ` · ปิดบัญชี ${e.u_username}` : ''}` }]);
  return toEmployee(await loadEmp(tx, id), ctx);
}

export async function rehireEmployee(tx: Tx, ctx: Ctx, id: string): Promise<HrEmployee> {
  requirePerm(ctx, 'hr.manage');
  const e = await loadEmp(tx, id, true);
  if (e.status !== 'resigned') throw E.conflict('Employee is active');
  await tx.query(`update employees set status = 'active', resigned_at = null, resign_reason = null, updated_at = now() where id = $1`, [id]);
  if (e.user_id) await tx.query(`update users set status = 'active', failed_logins = 0, locked_at = null where id = $1`, [e.user_id]);
  await writeAudit(tx, ctx, [{ action: 'rehire', object: 'employee', ref: e.code, detail: `${e.name}${e.u_username ? ` · เปิดบัญชี ${e.u_username}` : ''}` }]);
  return toEmployee(await loadEmp(tx, id), ctx);
}

// ---------------------------------------------------------------- leave
interface LeaveRow {
  id: string; no: string; employee_id: string; emp_name: string; leave_type: LeaveKind; from_date: string; to_date: string; half_day: boolean; days: string;
  reason: string; over_days: string; deduct: boolean; status: HrLeave['status']; req_name: string; dec_name: string | null; decided_at: Date | null; created_at: Date; note: string;
}
const LEAVE_SELECT = `select l.id, l.no, l.employee_id, e.name emp_name, l.leave_type, l.from_date, l.to_date, l.half_day, l.days::text, l.reason, l.over_days::text,
  l.deduct, l.status, ru.name req_name, du.name dec_name, l.decided_at, l.created_at, l.note
  from leave_requests l join employees e on e.id = l.employee_id join users ru on ru.id = l.requested_by left join users du on du.id = l.decided_by`;
const toLeave = (r: LeaveRow): HrLeave => ({
  id: r.id, no: r.no, employeeId: r.employee_id, employeeName: r.emp_name, type: r.leave_type, fromDate: r.from_date, toDate: r.to_date, halfDay: r.half_day,
  days: d(r.days).toString(), reason: r.reason, overDays: d(r.over_days).toString(), deduct: r.deduct, status: r.status, requestedBy: r.req_name,
  decidedBy: r.dec_name, decidedAt: r.decided_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(), note: r.note,
});

async function leaveRecords(tx: Tx, employeeId: string, excludeId?: string): Promise<LeaveRecord[]> {
  const r = await tx.query<{ leave_type: LeaveKind; days: string; status: LeaveRecord['status']; from_date: string }>(
    `select leave_type, days::text, status, from_date from leave_requests where employee_id = $1 and ($2::uuid is null or id <> $2)`, [employeeId, excludeId ?? null]);
  return r.rows.map((x) => ({ type: x.leave_type, days: x.days, status: x.status, fromDate: x.from_date }));
}

export async function listLeaves(tx: Tx, ctx: Ctx, q: In<typeof HrLeaveQuery>) {
  const boss = can(ctx, 'hr.leave') !== 0;
  const cur = decodeCursor(q.cursor, 2);
  const params: unknown[] = [];
  const where: string[] = [];
  if (!boss) {
    params.push(ctx.userId);
    where.push(`e.user_id = $${params.length}`);
  }
  if (q.status) {
    params.push(q.status);
    where.push(`l.status = $${params.length}`);
  }
  if (q.employeeId && isUuid(q.employeeId)) {
    params.push(q.employeeId);
    where.push(`l.employee_id = $${params.length}`);
  }
  for (const w of searchTokens(q.q)) {
    params.push(`%${likeEscape(w)}%`);
    where.push(`(e.name ilike $${params.length} or l.no ilike $${params.length} or l.reason ilike $${params.length})`);
  }
  if (cur) {
    params.push(cur[0], cur[1]);
    where.push(`(l.created_at, l.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(q.limit + 1);
  const r = await tx.query<LeaveRow>(`${LEAVE_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''} order by l.created_at desc, l.id desc limit $${params.length}`, params);
  return pageOf(r.rows, q.limit, (l) => [l.created_at.toISOString(), l.id], toLeave);
}

const overWarning = (over: string, deduct: boolean, type: LeaveKind) =>
  type === 'unpaid' ? `ลาไม่รับค่าจ้าง ${over} วัน หักเงินเดือนตามจำนวนวัน`
    : d(over).gt(0) ? `เกินสิทธิ์ ${over} วัน${deduct ? ' · หักเงินตามวันที่เกิน' : ' · ไม่หักเงิน'}` : null;

export async function createLeave(tx: Tx, ctx: Ctx, body: In<typeof HrLeaveCreate>, today: string): Promise<{ leave: HrLeave; warning: string | null }> {
  const boss = can(ctx, 'hr.leave') === 1;
  let empId = body.employeeId;
  if (!empId) {
    const me = await tx.query<{ id: string }>(`select id from employees where user_id = $1`, [ctx.userId]);
    if (!me.rows[0]) throw E.validation('This user is not linked to an employee', { reason: 'NO_EMPLOYEE' });
    empId = me.rows[0].id;
  }
  const e = await loadEmp(tx, empId, true); // serialises balance checks per employee
  const own = e.user_id === ctx.userId;
  if (!own && !boss) throw E.forbidden('Recording leave for someone else needs hr.leave', { perm: 'hr.leave' });
  if (e.status !== 'active') throw E.conflict('Employee has resigned');
  if (body.toDate < body.fromDate) throw E.validation('The end date is before the start date');
  if (body.halfDay && body.toDate !== body.fromDate) throw E.validation('A half day covers one date only');
  const days = leaveDays(body.fromDate, body.toDate, body.halfDay);
  if (!(days > 0)) throw E.validation('No working days in this range (Sundays are not counted)');
  const year = Number(body.fromDate.slice(0, 4));
  const over = overEntitlement(e.leave_ent, await leaveRecords(tx, e.id), body.type, days, year);
  const deduct = body.type === 'unpaid' ? true : body.deduct;
  // A manager recording someone else's leave approves it at once (mockup); own leave always waits for approval.
  const autoApprove = boss && !own;
  const no = await nextDocNo(tx, ctx.tenantId, 'LV', today);
  const r = await tx.query<{ id: string }>(
    `insert into leave_requests (tenant_id, no, employee_id, leave_type, from_date, to_date, half_day, days, reason, over_days, deduct, status, requested_by, decided_by, decided_at, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [ctx.tenantId, no, e.id, body.type, body.fromDate, body.toDate, body.halfDay, String(days), body.reason, over, deduct,
      autoApprove ? 'approved' : 'pending', ctx.userId, autoApprove ? ctx.userId : null, autoApprove ? new Date() : null, body.note?.trim() ?? ''],
  );
  const leave = toLeave((await tx.query<LeaveRow>(`${LEAVE_SELECT} where l.id = $1`, [r.rows[0]!.id])).rows[0]!);
  const warning = overWarning(over, deduct, body.type);
  await writeAudit(tx, ctx, [{ action: autoApprove ? 'approve' : 'request', object: 'leave', ref: no, detail: `${e.name} · ${body.type} ${days} วัน${warning ? ` · ${warning}` : ''}` }]);
  return { leave, warning };
}

export async function decideLeave(tx: Tx, ctx: Ctx, id: string, approve: boolean, body: { deduct?: boolean; note?: string }): Promise<{ leave: HrLeave; warning: string | null }> {
  requirePerm(ctx, 'hr.leave');
  if (!isUuid(id)) throw E.notFound('Leave not found');
  const l0 = (await tx.query<{ employee_id: string }>(`select employee_id from leave_requests where id = $1`, [id])).rows[0];
  if (!l0) throw E.notFound('Leave not found');
  const e = await loadEmp(tx, l0.employee_id, true);
  const l = (await tx.query<LeaveRow>(`${LEAVE_SELECT} where l.id = $1 for update of l`, [id])).rows[0]!;
  if (l.status !== 'pending') throw E.conflict(`Leave ${l.no} is already ${l.status}`);
  if (e.user_id === ctx.userId && ctx.role !== 'owner') throw E.forbidden('You cannot approve your own leave', { reason: 'SELF_APPROVAL' });
  let over = l.over_days;
  let deduct = l.deduct;
  if (approve) {
    over = overEntitlement(e.leave_ent, await leaveRecords(tx, e.id, id), l.leave_type, l.days, Number(l.from_date.slice(0, 4)));
    deduct = l.leave_type === 'unpaid' ? true : body.deduct ?? l.deduct;
  }
  await tx.query(`update leave_requests set status = $2, decided_by = $3, decided_at = now(), decide_note = $4, over_days = $5, deduct = $6 where id = $1`,
    [id, approve ? 'approved' : 'rejected', ctx.userId, body.note ?? null, over, deduct]);
  const leave = toLeave((await tx.query<LeaveRow>(`${LEAVE_SELECT} where l.id = $1`, [id])).rows[0]!);
  const warning = approve ? overWarning(d(over).toString(), deduct, l.leave_type) : null;
  await writeAudit(tx, ctx, [{ action: approve ? 'approve' : 'reject', object: 'leave', ref: l.no, detail: `${e.name}${warning ? ` · ${warning}` : ''}${body.note ? ` · ${body.note}` : ''}` }]);
  return { leave, warning };
}

export async function leaveBalanceRows(tx: Tx, ctx: Ctx, year: number) {
  const boss = can(ctx, 'hr.leave') !== 0 || can(ctx, 'hr.manage') !== 0;
  const emps = await tx.query<{ id: string; code: string; name: string; position: string; leave_ent: HrLeaveEnt; user_id: string | null }>(
    `select id, code, name, position, leave_ent, user_id from employees where status = 'active' and emp_type <> 'external' ${boss ? '' : 'and user_id = $1'} order by code`,
    boss ? [] : [ctx.userId],
  );
  const recs = await tx.query<{ employee_id: string; leave_type: LeaveKind; days: string; status: LeaveRecord['status']; from_date: string }>(
    `select employee_id, leave_type, days::text, status, from_date from leave_requests where status = 'approved' and from_date between $1 and $2`,
    [`${year}-01-01`, `${year}-12-31`],
  );
  return emps.rows.map((e) => {
    const mine = recs.rows.filter((r) => r.employee_id === e.id).map((r) => ({ type: r.leave_type, days: r.days, status: r.status, fromDate: r.from_date }));
    return {
      employeeId: e.id, code: e.code, name: e.name, position: e.position,
      balances: leaveBalances(e.leave_ent, mine, year).map((b) => ({ ...b, used: d(b.used).toString(), remaining: d(b.remaining).toString() })),
      unpaid: sum(mine.filter((m) => m.type === 'unpaid').map((m) => m.days)).toString(),
    };
  });
}

// ---------------------------------------------------------------- payroll
interface RunRow {
  id: string; period: string; status: HrPayrollRun['status']; sso_rate: string; sso_cap: string; sso_floor: string; created_name: string; created_at: Date;
  approved_name: string | null; approved_at: Date | null; paid_name: string | null; paid_at: Date | null; pay_date: string | null; note: string;
}
const RUN_SELECT = `select r.id, r.period, r.status, r.sso_rate::text, r.sso_cap::text, r.sso_floor::text, cu.name created_name, r.created_at,
  au.name approved_name, r.approved_at, pu.name paid_name, r.paid_at, r.pay_date, r.note
  from payroll_runs r join users cu on cu.id = r.created_by left join users au on au.id = r.approved_by left join users pu on pu.id = r.paid_by`;
interface LineRow {
  id: string; employee_id: string; emp_code: string; emp_name: string; emp_position: string; emp_type: HrEmployee['type']; bank_account: string; pay: 'monthly' | 'daily';
  rate: string; commission_pct: string; sso_enrolled: boolean; days: string; ot: string; allowance: string; advance: string; tax_override: string | null;
  unpaid_days: string; commission_base: string; base: string; commission: string; unpaid_amt: string; gross: string; sso: string; tax: string; net: string;
}
const LINE_COLS = `id, employee_id, emp_code, emp_name, emp_position, emp_type, bank_account, pay, rate::text, commission_pct::text, sso_enrolled, days::text, ot::text,
  allowance::text, advance::text, tax_override::text, unpaid_days::text, commission_base::text, base::text, commission::text, unpaid_amt::text, gross::text, sso::text, tax::text, net::text`;

const toLine = (r: LineRow): HrPayrollLine => ({
  id: r.id, employeeId: r.employee_id, code: r.emp_code, name: r.emp_name, position: r.emp_position, type: r.emp_type, bankAccount: r.bank_account, pay: r.pay,
  rate: money(r.rate), commissionPct: d(r.commission_pct).toString(), ssoEnrolled: r.sso_enrolled, days: d(r.days).toString(), ot: money(r.ot), allowance: money(r.allowance),
  advance: money(r.advance), taxOverride: r.tax_override == null ? null : money(r.tax_override), unpaidDays: d(r.unpaid_days).toString(),
  commissionBase: money(r.commission_base), base: money(r.base), commission: money(r.commission), unpaidAmt: money(r.unpaid_amt), gross: money(r.gross),
  sso: money(r.sso), tax: money(r.tax), net: money(r.net),
});

function calc(l: Pick<LineRow, 'pay' | 'rate' | 'sso_enrolled' | 'commission_pct' | 'days' | 'ot' | 'allowance' | 'advance' | 'tax_override' | 'unpaid_days' | 'commission_base'>, cfg: PayrollConfig) {
  return payRow(
    { pay: l.pay, salary: l.rate, dailyRate: l.rate, sso: l.sso_enrolled, commissionPct: l.commission_pct },
    { days: l.days, ot: l.ot, allowance: l.allowance, advance: l.advance, tax: l.tax_override, unpaidLeaveDays: l.unpaid_days, commissionBase: l.commission_base },
    cfg,
  );
}

const runCfg = (r: Pick<RunRow, 'sso_rate' | 'sso_cap' | 'sso_floor'>): PayrollConfig => ({ ssoRate: r.sso_rate, ssoCap: r.sso_cap, ssoFloor: r.sso_floor });

/** Sales ex VAT the employee's user issued in the period (credit notes subtract; void bills do not count). */
async function commissionBase(tx: Tx, userId: string | null, from: string, to: string): Promise<string> {
  if (!userId) return '0';
  const r = await tx.query<{ s: string }>(
    `select coalesce(sum(case when type = 'CN' then -(base7 + exempt) else base7 + exempt end), 0)::text s
       from docs where created_by = $1 and status = 'active' and type in ('ABB','INV','RC','CN') and date between $2 and $3`,
    [userId, from, to],
  );
  return money(r.rows[0]!.s);
}

/** Approved leave starting in the period: unpaid leave and deducted over-entitlement days. */
async function unpaidDays(tx: Tx, employeeId: string, from: string, to: string): Promise<string> {
  const r = await tx.query<{ leave_type: LeaveKind; days: string; over_days: string; deduct: boolean }>(
    `select leave_type, days::text, over_days::text, deduct from leave_requests where employee_id = $1 and status = 'approved' and from_date between $2 and $3`,
    [employeeId, from, to],
  );
  return sum(r.rows.map((l) => deductibleDays({ type: l.leave_type, days: l.days, overDays: l.over_days, deduct: l.deduct }))).toString();
}

async function loadRun(tx: Tx, period: string, lock = false): Promise<RunRow> {
  const r = await tx.query<RunRow>(`${RUN_SELECT} where r.period = $1 ${lock ? 'for update of r' : ''}`, [period]);
  if (!r.rows[0]) throw E.notFound(`No payroll for ${period}`);
  return r.rows[0];
}

async function runOut(tx: Tx, run: RunRow): Promise<HrPayrollRun> {
  const lines = (await tx.query<LineRow>(`select ${LINE_COLS} from payroll_lines where run_id = $1 order by emp_code`, [run.id])).rows.map(toLine);
  const t = (k: keyof HrPayrollLine) => money(sum(lines.map((l) => l[k] as string)));
  return {
    id: run.id, period: run.period, status: run.status, ssoRate: d(run.sso_rate).toString(), ssoCap: money(run.sso_cap), ssoFloor: money(run.sso_floor),
    createdBy: run.created_name, createdAt: run.created_at.toISOString(), approvedBy: run.approved_name, approvedAt: run.approved_at?.toISOString() ?? null,
    paidBy: run.paid_name, paidAt: run.paid_at?.toISOString() ?? null, payDate: run.pay_date, note: run.note, published: run.status === 'paid',
    totals: { base: t('base'), ot: t('ot'), allowance: t('allowance'), commission: t('commission'), unpaidAmt: t('unpaidAmt'), gross: t('gross'), sso: t('sso'), tax: t('tax'), advance: t('advance'), net: t('net'), employerSso: t('sso') },
    lines,
  };
}

export async function getRun(tx: Tx, ctx: Ctx, period: string): Promise<HrPayrollRun> {
  requirePerm(ctx, 'hr.salary');
  return runOut(tx, await loadRun(tx, period));
}

export async function listRuns(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string }) {
  requirePerm(ctx, 'hr.salary');
  const cur = decodeCursor(q.cursor, 1);
  const r = await tx.query<RunRow & { headcount: number; gross: string; sso: string; tax: string; net: string; base: string; ot: string; allowance: string; commission: string; unpaid_amt: string; advance: string }>(
    `select x.*, (select count(*) from payroll_lines l where l.run_id = x.id)::int headcount,
            (select coalesce(sum(gross),0)::text from payroll_lines l where l.run_id = x.id) gross,
            (select coalesce(sum(sso),0)::text from payroll_lines l where l.run_id = x.id) sso,
            (select coalesce(sum(tax),0)::text from payroll_lines l where l.run_id = x.id) tax,
            (select coalesce(sum(net),0)::text from payroll_lines l where l.run_id = x.id) net,
            (select coalesce(sum(base),0)::text from payroll_lines l where l.run_id = x.id) base,
            (select coalesce(sum(ot),0)::text from payroll_lines l where l.run_id = x.id) ot,
            (select coalesce(sum(allowance),0)::text from payroll_lines l where l.run_id = x.id) allowance,
            (select coalesce(sum(commission),0)::text from payroll_lines l where l.run_id = x.id) commission,
            (select coalesce(sum(unpaid_amt),0)::text from payroll_lines l where l.run_id = x.id) unpaid_amt,
            (select coalesce(sum(advance),0)::text from payroll_lines l where l.run_id = x.id) advance
       from (${RUN_SELECT} ${cur ? 'where r.period < $2' : ''} order by r.period desc limit $1) x order by x.period desc`,
    cur ? [q.limit + 1, cur[0]] : [q.limit + 1],
  );
  return pageOf(r.rows, q.limit, (x) => [x.period], (x) => ({
    id: x.id, period: x.period, status: x.status, ssoRate: d(x.sso_rate).toString(), ssoCap: money(x.sso_cap), ssoFloor: money(x.sso_floor), createdBy: x.created_name,
    createdAt: x.created_at.toISOString(), approvedBy: x.approved_name, approvedAt: x.approved_at?.toISOString() ?? null, paidBy: x.paid_name,
    paidAt: x.paid_at?.toISOString() ?? null, payDate: x.pay_date, headcount: x.headcount, note: x.note, published: x.status === 'paid',
    totals: { base: money(x.base), ot: money(x.ot), allowance: money(x.allowance), commission: money(x.commission), unpaidAmt: money(x.unpaid_amt), gross: money(x.gross), sso: money(x.sso), tax: money(x.tax), advance: money(x.advance), net: money(x.net), employerSso: money(x.sso) },
  }));
}

interface PayEmp { id: string; code: string; name: string; position: string; emp_type: HrEmployee['type']; bank_account: string; salary: string; daily_rate: string; commission_pct: string; sso: boolean; user_id: string | null }

/** Line values that come from the employee record, the leave register and the sales docs (refreshed by recalc). */
async function derived(tx: Tx, e: PayEmp, period: string) {
  const { from, to } = periodRange(period);
  return {
    emp_code: e.code, emp_name: e.name, emp_position: e.position, emp_type: e.emp_type, bank_account: e.bank_account,
    pay: (isDaily(e.emp_type) ? 'daily' : 'monthly') as 'daily' | 'monthly', rate: isDaily(e.emp_type) ? e.daily_rate : e.salary,
    commission_pct: e.commission_pct, sso_enrolled: e.sso,
    unpaid_days: await unpaidDays(tx, e.id, from, to), commission_base: await commissionBase(tx, e.user_id, from, to),
  };
}

async function writeLine(tx: Tx, ctx: Ctx, runId: string, cfg: PayrollConfig, e: PayEmp, period: string, existing?: LineRow) {
  const der = await derived(tx, e, period);
  const inputs = existing
    ? { days: existing.days, ot: existing.ot, allowance: existing.allowance, advance: existing.advance, tax_override: existing.tax_override }
    : { days: '26', ot: '0', allowance: '0', advance: '0', tax_override: null };
  const res = calc({ ...der, ...inputs }, cfg);
  const vals = [der.emp_code, der.emp_name, der.emp_position, der.emp_type, der.bank_account, der.pay, der.rate, der.commission_pct, der.sso_enrolled,
    inputs.days, inputs.ot, inputs.allowance, inputs.advance, inputs.tax_override, der.unpaid_days, der.commission_base,
    res.base, res.commission, res.unpaidAmt, res.gross, res.sso, res.tax, res.net];
  if (existing) {
    await tx.query(
      `update payroll_lines set emp_code=$2, emp_name=$3, emp_position=$4, emp_type=$5, bank_account=$6, pay=$7, rate=$8, commission_pct=$9, sso_enrolled=$10,
         days=$11, ot=$12, allowance=$13, advance=$14, tax_override=$15, unpaid_days=$16, commission_base=$17, base=$18, commission=$19, unpaid_amt=$20,
         gross=$21, sso=$22, tax=$23, net=$24 where id = $1`,
      [existing.id, ...vals],
    );
  } else {
    await tx.query(
      `insert into payroll_lines (tenant_id, run_id, employee_id, emp_code, emp_name, emp_position, emp_type, bank_account, pay, rate, commission_pct, sso_enrolled,
         days, ot, allowance, advance, tax_override, unpaid_days, commission_base, base, commission, unpaid_amt, gross, sso, tax, net)
       values ($1,$2,$3,${vals.map((_, i) => `$${i + 4}`).join(',')})`,
      [ctx.tenantId, runId, e.id, ...vals],
    );
  }
}

const PAY_EMP = `select id, code, name, position, emp_type, bank_account, salary::text, daily_rate::text, commission_pct::text, sso, user_id from employees`;

export async function createRun(tx: Tx, ctx: Ctx, period: string, note = ''): Promise<HrPayrollRun> {
  requirePerm(ctx, 'hr.salary');
  const { to } = periodRange(period);
  const exists = await tx.query(`select 1 from payroll_runs where period = $1`, [period]);
  if (exists.rowCount) throw E.conflict(`Payroll ${period} already exists`);
  const s = await hrSettings(tx, ctx.tenantId);
  const run = await tx.query<{ id: string }>(
    `insert into payroll_runs (tenant_id, period, sso_rate, sso_cap, sso_floor, created_by, note) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, period, s.ssoRate, s.ssoCap, s.ssoFloor, ctx.userId, note.trim()],
  );
  const cfg = { ssoRate: s.ssoRate, ssoCap: s.ssoCap, ssoFloor: s.ssoFloor };
  const emps = await tx.query<PayEmp>(`${PAY_EMP} where status = 'active' and emp_type = any($1) and start_date <= $2 order by code`, [PAYROLL_TYPES, to]);
  for (const e of emps.rows) await writeLine(tx, ctx, run.rows[0]!.id, cfg, e, period);
  const out = await runOut(tx, await loadRun(tx, period));
  await writeAudit(tx, ctx, [{ action: 'create', object: 'payroll', ref: period, detail: `${out.lines.length} คน · สุทธิ ${out.totals.net}` }]);
  return out;
}

export async function recalcRun(tx: Tx, ctx: Ctx, period: string): Promise<HrPayrollRun> {
  requirePerm(ctx, 'hr.salary');
  const run = await loadRun(tx, period, true);
  if (run.status !== 'draft') throw E.conflict('Only a draft payroll can be recalculated', { reason: 'PAYROLL_LOCKED' });
  const { to } = periodRange(period);
  const lines = (await tx.query<LineRow>(`select ${LINE_COLS} from payroll_lines where run_id = $1`, [run.id])).rows;
  const emps = await tx.query<PayEmp>(`${PAY_EMP} where (status = 'active' and emp_type = any($1) and start_date <= $2) or id = any($3::uuid[]) order by code`,
    [PAYROLL_TYPES, to, lines.map((l) => l.employee_id)]);
  for (const e of emps.rows) await writeLine(tx, ctx, run.id, runCfg(run), e, period, lines.find((l) => l.employee_id === e.id));
  const out = await runOut(tx, await loadRun(tx, period));
  await writeAudit(tx, ctx, [{ action: 'update', object: 'payroll', ref: period, detail: `คำนวณใหม่ · สุทธิ ${out.totals.net}` }]);
  return out;
}

export async function updateLine(tx: Tx, ctx: Ctx, period: string, lineId: string, body: In<typeof HrPayrollLineUpdate>): Promise<HrPayrollRun> {
  requirePerm(ctx, 'hr.salary');
  const run = await loadRun(tx, period, true);
  if (run.status !== 'draft') throw E.conflict(`Payroll ${period} is ${run.status}; only a draft can be edited`, { reason: 'PAYROLL_LOCKED' });
  if (!isUuid(lineId)) throw E.notFound('Line not found');
  const l = (await tx.query<LineRow>(`select ${LINE_COLS} from payroll_lines where id = $1 and run_id = $2 for update`, [lineId, run.id])).rows[0];
  if (!l) throw E.notFound('Line not found');
  const next = {
    ...l, days: body.days ?? l.days, ot: body.ot ?? l.ot, allowance: body.allowance ?? l.allowance, advance: body.advance ?? l.advance,
    tax_override: body.tax === undefined ? l.tax_override : body.tax,
  };
  const res = calc(next, runCfg(run));
  await tx.query(
    `update payroll_lines set days=$2, ot=$3, allowance=$4, advance=$5, tax_override=$6, base=$7, commission=$8, unpaid_amt=$9, gross=$10, sso=$11, tax=$12, net=$13 where id = $1`,
    [l.id, next.days, next.ot, next.allowance, next.advance, next.tax_override, res.base, res.commission, res.unpaidAmt, res.gross, res.sso, res.tax, res.net],
  );
  const changed = Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v ?? 'auto'}`).join(', ');
  await writeAudit(tx, ctx, [{ action: 'update', object: 'payroll', ref: `${period}/${l.emp_code}`, detail: `${changed} · สุทธิ ${l.net} → ${res.net}` }]);
  return runOut(tx, await loadRun(tx, period));
}

export async function transitionRun(tx: Tx, ctx: Ctx, period: string, to: 'approved' | 'draft' | 'paid', today: string, payDate?: string): Promise<HrPayrollRun> {
  requirePerm(ctx, 'hr.salary');
  const run = await loadRun(tx, period, true);
  const allowed: Record<typeof to, HrPayrollRun['status']> = { approved: 'draft', draft: 'approved', paid: 'approved' };
  if (run.status !== allowed[to]) {
    throw E.conflict(run.status === 'paid' ? `Payroll ${period} is paid and locked` : `Payroll ${period} is ${run.status}`, { reason: run.status === 'paid' ? 'PAYROLL_LOCKED' : 'PAYROLL_STATE' });
  }
  if (to === 'approved') await tx.query(`update payroll_runs set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [run.id, ctx.userId]);
  if (to === 'draft') await tx.query(`update payroll_runs set status = 'draft', approved_by = null, approved_at = null where id = $1`, [run.id]);
  if (to === 'paid') await tx.query(`update payroll_runs set status = 'paid', paid_by = $2, paid_at = now(), pay_date = $3 where id = $1`, [run.id, ctx.userId, payDate ?? today]);
  const out = await runOut(tx, await loadRun(tx, period));
  const action = { approved: 'approve', draft: 'reopen', paid: 'pay' }[to];
  await writeAudit(tx, ctx, [{ action, object: 'payroll', ref: period, detail: `${out.lines.length} คน · สุทธิ ${out.totals.net}` }]);
  return out;
}

/** หมายเหตุ of a payroll run (editable in any status; the figures stay locked once paid). */
export async function updateRunNote(tx: Tx, ctx: Ctx, period: string, note: string): Promise<HrPayrollRun> {
  requirePerm(ctx, 'hr.salary');
  const run = await loadRun(tx, period, true);
  const next = note.trim();
  if (next !== run.note) {
    await tx.query(`update payroll_runs set note = $2 where id = $1`, [run.id, next]);
    await writeAudit(tx, ctx, [{ action: 'update', object: 'payroll', ref: period, detail: `หมายเหตุ: ${run.note || '-'} → ${next || '-'}` }]);
  }
  return runOut(tx, await loadRun(tx, period));
}

/**
 * Which months have a published payslip (run paid) — never 404, so the UI can show the slip button disabled
 * ("รอเผยแพร่รอบเงินเดือน") without firing a request that fails. HR salary sees every run; an employee sees the runs
 * that include them. `period` narrows to one month (returned with exists=false when there is no run).
 */
export async function payslipPeriods(tx: Tx, ctx: Ctx, q: { period?: string; limit: number }) {
  const full = can(ctx, 'hr.salary') === 1;
  const me = (await tx.query<{ id: string }>(`select id from employees where user_id = $1`, [ctx.userId])).rows[0];
  if (!full && !me) return { employeeId: null, items: [] };
  const params: unknown[] = [];
  const where: string[] = [];
  if (!full) { params.push(me!.id); where.push(`exists (select 1 from payroll_lines l where l.run_id = r.id and l.employee_id = $${params.length})`); }
  if (q.period) { params.push(q.period); where.push(`r.period = $${params.length}`); }
  params.push(q.limit);
  const r = await tx.query<{ period: string; status: HrPayrollRun['status']; pay_date: string | null }>(
    `select r.period, r.status, r.pay_date from payroll_runs r ${where.length ? 'where ' + where.join(' and ') : ''} order by r.period desc limit $${params.length}`, params);
  const items = r.rows.map((x) => ({ period: x.period, exists: true, status: x.status, published: x.status === 'paid', payDate: x.pay_date }));
  if (q.period && !items.length) items.push({ period: q.period, exists: false, status: null as unknown as HrPayrollRun['status'], published: false, payDate: null });
  return { employeeId: me?.id ?? null, items };
}

/** Payslips (REQ-M17-03). HR salary sees every slip; an employee sees only their own slip of a paid month. */
export async function payslips(tx: Tx, ctx: Ctx, period: string, employeeId?: string): Promise<HrPayslip[]> {
  const run = await loadRun(tx, period);
  const full = can(ctx, 'hr.salary') === 1;
  let filter = employeeId && isUuid(employeeId) ? employeeId : null;
  if (!full) {
    const me = (await tx.query<{ id: string }>(`select id from employees where user_id = $1`, [ctx.userId])).rows[0];
    if (!me || run.status !== 'paid' || (filter && filter !== me.id)) throw E.forbidden('Payslips need hr.salary (or your own slip of a paid month)', { perm: 'hr.salary' });
    filter = me.id;
  }
  const shop = (await tx.query<{ name: string; tax_id: string; branch: string; address: string; phone: string }>(`select name, tax_id, branch, address, phone from tenants where id = $1`, [ctx.tenantId])).rows[0]!;
  const lines = (await tx.query<LineRow>(`select ${LINE_COLS} from payroll_lines where run_id = $1 ${filter ? 'and employee_id = $2' : ''} order by emp_code`, filter ? [run.id, filter] : [run.id])).rows.map(toLine);
  return lines.map((r) => {
    const earnings = [
      { label: r.pay === 'daily' ? `ค่าจ้างรายวัน ${r.days} วัน × ${r.rate}` : 'เงินเดือน', amount: r.base },
      ...(d(r.ot).gt(0) ? [{ label: 'ค่าล่วงเวลา (OT)', amount: r.ot }] : []),
      ...(d(r.allowance).gt(0) ? [{ label: 'เบี้ยขยัน / เบี้ยเลี้ยง / อื่น ๆ', amount: r.allowance }] : []),
      ...(d(r.commission).gt(0) ? [{ label: `ค่าคอมมิชชัน (ยอดขาย ${r.commissionBase} × ${r.commissionPct}%)`, amount: r.commission }] : []),
    ];
    const deductions = [
      ...(d(r.unpaidAmt).gt(0) ? [{ label: `หักลาไม่รับค่าจ้าง / ลาเกินสิทธิ์ ${r.unpaidDays} วัน`, amount: r.unpaidAmt }] : []),
      ...(d(r.sso).gt(0) ? [{ label: `หักประกันสังคม ${d(run.sso_rate).times(100).toString()}%`, amount: r.sso }] : []),
      ...(d(r.tax).gt(0) ? [{ label: 'หักภาษี ณ ที่จ่าย (ภ.ง.ด.1)', amount: r.tax }] : []),
      ...(d(r.advance).gt(0) ? [{ label: 'หักเงินเบิกล่วงหน้า', amount: r.advance }] : []),
    ];
    // Gross on the slip is before the unpaid-leave deduction, so earnings − deductions = net.
    const grossBefore = money(d(r.gross).plus(r.unpaidAmt));
    const totalDed = money(sum(deductions.map((x) => x.amount)));
    return {
      no: `PS-${period.replace('-', '')}-${r.code}`, period, periodLabel: periodTH(period), status: run.status, payDate: run.pay_date,
      shop: { name: shop.name, taxId: shop.tax_id, branch: shop.branch, address: shop.address, phone: shop.phone },
      employee: { id: r.employeeId, code: r.code, name: r.name, position: r.position, type: r.type, bankAccount: r.bankAccount },
      earnings, deductions, gross: grossBefore, totalDeductions: totalDed, net: r.net, netText: bahtText(r.net),
    };
  });
}

/** REQ-M17-06: salary + employer SSO per month (approved / paid runs), for M11-06 and export to the accountant. */
export async function labourCostRows(tx: Tx, ctx: Ctx, q: { from?: string; to?: string }) {
  requireAny(ctx, ['hr.salary', 'rep.view'], { readOnly: true });
  const r = await tx.query<{ period: string; status: 'approved' | 'paid'; headcount: number; gross: string; employer_sso: string; total: string }>(
    `select period, status, headcount, gross::text, employer_sso::text, total::text from hr_labour_cost_monthly
      where ($1::text is null or period >= $1) and ($2::text is null or period <= $2) order by period desc`,
    [q.from ?? null, q.to ?? null],
  );
  return { items: r.rows.map((x) => ({ period: x.period, status: x.status, headcount: x.headcount, gross: money(x.gross), employerSso: money(x.employer_sso), total: money(x.total) })) };
}
