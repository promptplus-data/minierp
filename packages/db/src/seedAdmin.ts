/**
 * Demo data for the "admin" module group (idempotent): employees linked to the demo users (mockup VIEWS.hr), leave
 * requests, a paid September payroll, the central SCG product master with recommended prices and two SCG Admin
 * accounts (scg.admin / 1234 super, nok.master / 1234 master data — DEMO ONLY, never on a production database).
 *
 * seedAdmin(pool, tenantId) — tests, e2e and the demo. CLI: DATABASE_URL=... tsx src/seedAdmin.ts [shop code=charoen]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import argon2 from 'argon2';
import pg from 'pg';
import { DEFAULT_LEAVE_ENTITLEMENT, payRow } from '@erp/core';
import { withTenant } from './tx';

const BANK_TH: Record<string, string> = { KBANK: 'ธนาคารกสิกรไทย', SCB: 'ธนาคารไทยพาณิชย์', BBL: 'ธนาคารกรุงเทพ', KTB: 'ธนาคารกรุงไทย' };

interface EmpSeed {
  user: string | null; code: string; name: string; position: string; type: 'monthly' | 'daily' | 'parttime' | 'owner' | 'external';
  start: string; salary: number; daily: number; comm: number; sso: boolean; bank: string; acct: string; nid: string; phone: string; resigned?: string;
}

/** Valid Thai national id from a 12-digit stem (check digit = (11 - Σ d·(13-i) mod 11) mod 10). */
const nid = (stem: string) => {
  let t = 0;
  for (let i = 0; i < 12; i++) t += Number(stem[i]) * (13 - i);
  return stem + String((11 - (t % 11)) % 10);
};

const EMPLOYEES: EmpSeed[] = [
  { user: 'charoen', code: 'OWN001', name: 'คุณเจริญ ศรีสุข', position: 'เจ้าของกิจการ', type: 'owner', start: '2015-03-01', salary: 0, daily: 0, comm: 0, sso: false, bank: 'KBANK', acct: '012-3-45678-9', nid: nid('310050012345'), phone: '081-222-3344' },
  { user: 'suda', code: 'EMP001', name: 'คุณสุดา ศรีสุข', position: 'ผู้จัดการร้าน', type: 'monthly', start: '2018-06-01', salary: 25000, daily: 0, comm: 0, sso: true, bank: 'KBANK', acct: '012-3-11111-1', nid: nid('310050023456'), phone: '086-111-2299' },
  { user: 'prae', code: 'EMP002', name: 'น้องแพร', position: 'แคชเชียร์', type: 'daily', start: '2024-02-15', salary: 0, daily: 420, comm: 0, sso: true, bank: 'SCB', acct: '404-1-22222-2', nid: nid('110370034567'), phone: '092-333-4455' },
  { user: 'boy', code: 'EMP003', name: 'พี่บอย', position: 'พนักงานขาย', type: 'monthly', start: '2021-09-01', salary: 15000, daily: 0, comm: 1, sso: true, bank: 'BBL', acct: '101-4-33333-3', nid: nid('150990045678'), phone: '081-555-0142' },
  { user: 'chai', code: 'EMP004', name: 'พี่ชัย', position: 'พนักงานคลัง', type: 'daily', start: '2022-01-10', salary: 0, daily: 450, comm: 0, sso: true, bank: 'KTB', acct: '678-0-44444-4', nid: nid('340010056789'), phone: '' },
  { user: 'ton', code: 'EMP005', name: 'น้องต้น', position: 'พนักงานคลัง', type: 'daily', start: '2025-04-01', salary: 0, daily: 400, comm: 0, sso: true, bank: '', acct: '', nid: nid('110200067890'), phone: '', resigned: '2026-08-31' },
];

const CENTRAL = [
  { sku: 'SCG-CEM-T50', name: 'ปูนซีเมนต์ตราเสือ 50 กก.', cat: 'ปูนซีเมนต์', units: [['ถุง', '1'], ['พาเลท', '40']], bc: '8850001000014', retail: '145.00', wholesale: '138.00', next: '149.00' },
  { sku: 'SCG-ROOF-LK', name: 'กระเบื้องหลังคาลอนคู่ 50×120 ซม. สีเทา', cat: 'หลังคา', units: [['แผ่น', '1'], ['มัด', '50']], bc: '8850001000212', retail: '52.00', wholesale: '49.00' },
  { sku: 'SCG-AAC-75', name: 'อิฐมวลเบา 7.5 ซม.', cat: 'ผนัง', units: [['ก้อน', '1'], ['พาเลท', '200']], bc: '8850001000519', retail: '24.00', wholesale: '22.50' },
  { sku: 'SCG-TA-20', name: 'กาวซีเมนต์ปูกระเบื้อง 20 กก.', cat: 'กาว/ยาแนว', units: [['ถุง', '1']], bc: '8850001000717', retail: '210.00', wholesale: '198.00' },
  { sku: 'SCG-CEM-W40', name: 'ปูนฉาบสำเร็จรูป ตราเสือ 40 กก.', cat: 'ปูนซีเมนต์', units: [['ถุง', '1'], ['พาเลท', '50']], bc: '8850001000823', retail: '125.00', wholesale: '118.00' },
  { sku: 'SCG-PIPE-PVC4', name: 'ท่อ PVC 4 นิ้ว ชั้น 8.5 ยาว 4 ม.', cat: 'ประปา', units: [['เส้น', '1']], bc: '8850001000920', retail: '395.00', wholesale: '372.00' },
];

export interface SeedAdminResult { employees: Record<string, string>; admins: string[] }

export async function seedAdmin(pool: pg.Pool, tenantId: string): Promise<SeedAdminResult> {
  const out: SeedAdminResult = { employees: {}, admins: [] };
  await withTenant(pool, tenantId, async (c) => {
    await c.query(`insert into adm_settings (tenant_id) values ($1) on conflict do nothing`, [tenantId]);
    const users = new Map((await c.query<{ id: string; username: string }>(`select id, username from users`)).rows.map((u) => [u.username, u.id]));
    const owner = users.get('charoen') ?? [...users.values()][0]!;
    if (!(await c.query(`select 1 from employees limit 1`)).rowCount) {
      for (const e of EMPLOYEES) {
        const uid = e.user ? users.get(e.user) ?? null : null;
        const ent = e.type === 'owner' ? { sick: 0, personal: 0, vacation: 0, maternity: 0, other: 0 } : DEFAULT_LEAVE_ENTITLEMENT;
        const r = await c.query<{ id: string }>(
          `insert into employees (tenant_id, code, name, position, emp_type, start_date, salary, daily_rate, commission_pct, sso, bank_account, national_id, phone,
             leave_ent, status, resigned_at, resign_reason, user_id, created_by, bank, bank_account_name)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`,
          [tenantId, e.code, e.name, e.position, e.type, e.start, e.salary, e.daily, e.comm, e.sso, e.acct, e.nid, e.phone, JSON.stringify(ent),
            e.resigned ? 'resigned' : 'active', e.resigned ?? null, e.resigned ? 'ลาออกเอง' : null, uid, owner, e.bank, e.acct ? e.name : ''],
        );
        out.employees[e.code] = r.rows[0]!.id;
      }
      const leave = async (no: string, code: string, type: string, from: string, to: string, days: string, reason: string, status: string) => {
        await c.query(
          `insert into leave_requests (tenant_id, no, employee_id, leave_type, from_date, to_date, days, reason, status, requested_by, decided_by, decided_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [tenantId, no, out.employees[code], type, from, to, days, reason, status, owner, status === 'pending' ? null : owner, status === 'pending' ? null : `${from}T09:00:00+07:00`]);
      };
      await leave('LV2610-0001', 'EMP002', 'sick', '2026-10-06', '2026-10-07', '2', 'ไข้หวัด มีใบรับรองแพทย์', 'approved');
      await leave('LV2610-0002', 'EMP004', 'personal', '2026-10-15', '2026-10-15', '1', 'ไปทำบัตรประชาชน', 'approved');
      await leave('LV2610-0003', 'EMP003', 'vacation', '2026-11-02', '2026-11-04', '3', 'กลับบ้านต่างจังหวัด', 'pending');
      await c.query(`insert into doc_counters (tenant_id, type, period, device, seq) values ($1,'LV','2026-10','',3) on conflict do nothing`, [tenantId]);

      // September payroll, paid (lines are written while the run is a draft; the paid run is then locked).
      const run = await c.query<{ id: string }>(
        `insert into payroll_runs (tenant_id, period, status, sso_rate, sso_cap, sso_floor, created_by) values ($1,'2026-09','draft',0.05,17500,1650,$2) returning id`,
        [tenantId, owner]);
      for (const e of EMPLOYEES.filter((x) => !x.resigned && x.type !== 'owner')) {
        const daily = e.type === 'daily';
        const inp = { days: daily ? '26' : '26', ot: e.code === 'EMP004' ? '900' : '0', allowance: e.code === 'EMP002' ? '500' : '0', commissionBase: e.comm ? '186500' : '0' };
        const r = payRow({ pay: daily ? 'daily' : 'monthly', salary: e.salary, dailyRate: e.daily, sso: e.sso, commissionPct: e.comm }, inp);
        await c.query(
          `insert into payroll_lines (tenant_id, run_id, employee_id, emp_code, emp_name, emp_position, emp_type, bank_account, pay, rate, commission_pct, sso_enrolled,
             days, ot, allowance, advance, unpaid_days, commission_base, base, commission, unpaid_amt, gross, sso, tax, net)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,0,$16,$17,$18,$19,$20,$21,$22,$23)`,
          [tenantId, run.rows[0]!.id, out.employees[e.code], e.code, e.name, e.position, e.type, e.acct ? `${BANK_TH[e.bank]} ${e.acct} (${e.name})` : '', daily ? 'daily' : 'monthly', daily ? e.daily : e.salary, e.comm, e.sso,
            inp.days, inp.ot, inp.allowance, inp.commissionBase, r.base, r.commission, r.unpaidAmt, r.gross, r.sso, r.tax, r.net]);
      }
      await c.query(`update payroll_runs set status = 'approved', approved_by = $2, approved_at = '2026-09-29T10:00:00+07:00' where id = $1`, [run.rows[0]!.id, owner]);
      await c.query(`update payroll_runs set status = 'paid', paid_by = $2, paid_at = '2026-09-30T10:00:00+07:00', pay_date = '2026-09-30' where id = $1`, [run.rows[0]!.id, owner]);
    } else {
      for (const r of (await c.query<{ id: string; code: string }>(`select id, code from employees`)).rows) out.employees[r.code] = r.id;
    }
  });

  // Global SCG Admin data (platform context).
  await withTenant(pool, null, async (c) => {
    await c.query(`select set_config('app.platform', 'on', true)`);
    const hash = await argon2.hash('1234', { type: argon2.argon2id });
    for (const [username, name, role] of [['scg.admin', 'คุณกานต์ (SCG Admin)', 'super'], ['nok.master', 'คุณนก (Master data)', 'master']] as const) {
      await c.query(`insert into platform_admins (username, name, role, password_hash) values ($1,$2,$3,$4) on conflict (username) do nothing`, [username, name, role, hash]);
      out.admins.push(username);
    }
    for (const p of CENTRAL) {
      const r = await c.query<{ id: string }>(
        `insert into central_products (sku, name, category, units, barcode, created_by) values ($1,$2,$3,$4,$5,'seed') on conflict (sku) do nothing returning id`,
        [p.sku, p.name, p.cat, JSON.stringify(p.units.map(([n, f]) => ({ name: n, factor: f }))), p.bc]);
      if (!r.rows[0]) continue;
      await c.query(`insert into central_prices (product_id, retail, wholesale, effective_from, created_by) values ($1,$2,$3,'2026-10-01','seed')`, [r.rows[0].id, p.retail, p.wholesale]);
      if (p.next) await c.query(`insert into central_prices (product_id, retail, wholesale, effective_from, created_by) values ($1,$2,$3,'2026-12-01','seed')`, [r.rows[0].id, p.next, p.wholesale]);
    }
  });
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url });
  const code = process.argv[2] ?? 'charoen';
  (async () => {
    const t = await withTenant(pool, null, (c) => c.query<{ id: string }>(`select id from tenants where code = $1`, [code]), { authLookup: true });
    if (!t.rows[0]) throw new Error(`shop ${code} not found; run src/seed.ts first`);
    const r = await seedAdmin(pool, t.rows[0].id);
    console.log(`[seedAdmin] ${Object.keys(r.employees).length} employees, admins ${r.admins.join(', ')}`);
  })()
    .catch((err) => {
      console.error('[seedAdmin] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
