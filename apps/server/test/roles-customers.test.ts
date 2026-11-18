/** Owner-managed shop roles (built-in overrides, a new ฝ่ายบุคคล role, no escalation) and the customer master. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, login, setupEnv, type Client, type Env } from './helpers';

let env: Env;
let owner: Client;
let suda: Client;
let boy: Client;

beforeAll(async () => {
  env = await setupEnv();
  [owner, suda, boy] = await Promise.all([login(env.app, 'charoen'), login(env.app, 'suda'), login(env.app, 'boy')]);
});
afterAll(async () => { await env.close(); });

describe('shop roles', () => {
  it('the owner changes what a built-in role may do; it applies on the next request; reset brings the default back', async () => {
    const list = (await owner.get('/api/roles')).body as { key: string; grants: Record<string, unknown>; customized: boolean }[];
    const sales = list.find((r) => r.key === 'sales')!;
    expect(sales).toMatchObject({ customized: false, grants: { 'rep.view': 'ro' } });
    expect((await suda.patch('/api/roles/sales', { grants: { ...sales.grants, 'rep.view': 1 } })).status).toBe(403);
    const r = await owner.patch('/api/roles/sales', { grants: { ...sales.grants, 'rep.view': 0, 'data.master': 1 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ customized: true, grants: { 'rep.view': 0, 'data.master': 1 } });
    const me = (await boy.get('/api/auth/me')).body;
    expect(me.perms).toMatchObject({ 'rep.view': 0, 'data.master': 1 });
    expect((await boy.get('/api/reports/dashboard')).status).toBeLessThan(500);
    await owner.patch('/api/roles/sales', { reset: true });
    expect((await boy.get('/api/auth/me')).body.perms['rep.view']).toBe('ro');
  });

  it('a new ฝ่ายบุคคล role creates users and sees salaries; a manager cannot hand out more than they have', async () => {
    const created = await owner.post('/api/roles', { name: 'ฝ่ายบุคคล', base: 'acct' });
    expect(created.status).toBe(201);
    const hr = created.body as { id: string; grants: Record<string, unknown> };
    const g = Object.fromEntries(Object.keys(hr.grants).map((k) => [k, 0]));
    const up = await owner.patch(`/api/roles/${hr.id}`, { grants: { ...g, 'hr.manage': 1, 'hr.salary': 1, 'hr.leave': 1, 'sys.users': 'ro' } });
    expect(up.body).toMatchObject({ name: 'ฝ่ายบุคคล', base: 'acct', grants: { 'hr.salary': 1, 'pos.sell': 0 } });

    // manager (no hr.salary) may not give the HR role to anyone
    const bySuda = await suda.post('/api/hr/employees', { name: 'คุณแนน', startDate: '2026-11-01', user: { username: 'nan.hr', role: 'acct', shopRoleId: hr.id, password: '1234' } });
    expect(bySuda.status).toBe(403);
    const e = await owner.post('/api/hr/employees', { name: 'คุณแนน', startDate: '2026-11-01', salary: '18000', user: { username: 'nan.hr', role: 'cashier', shopRoleId: hr.id, password: '1234' } });
    expect(e.status).toBe(201);
    expect(e.body.employee.user).toMatchObject({ role: 'acct', shopRoleId: hr.id, roleName: 'ฝ่ายบุคคล' });

    const nan = await login(env.app, 'nan.hr');
    const me = (await nan.get('/api/auth/me')).body;
    expect(me).toMatchObject({ role: 'acct', roleName: 'ฝ่ายบุคคล', perms: { 'hr.salary': 1, 'fin.ar': 0, 'data.cost': 0 } });
    const emps = (await nan.get('/api/hr/employees')).body.items as { name: string; salary: string | null }[];
    expect(emps.find((x) => x.name === 'คุณแนน')!.salary).toBe('18000.00');
    expect((await nan.get('/api/ar/aging')).status).toBe(403);
    // the HR role creates a cashier login, but cannot create a manager (more than it has)
    expect((await nan.post('/api/hr/employees', { name: 'น้องเอ', startDate: '2026-11-02', user: { username: 'a.cash', role: 'cashier', password: '1234' } })).status).toBe(403);
    await owner.patch(`/api/roles/${hr.id}`, { grants: { ...up.body.grants, 'pos.sell': 1, 'pos.delLine': 'apv', 'pos.void': 'apv', 'sales.belowCost': 'apv', 'sales.return': 'apv', 'sales.voidDoc': 'apv', 'inv.view': 'ro', 'fin.shift': 1, 'promo.manage': 'ro' } });
    expect((await nan.post('/api/hr/employees', { name: 'น้องเอ', startDate: '2026-11-02', user: { username: 'a.cash', role: 'cashier', password: '1234' } })).status).toBe(201);
    expect((await nan.post('/api/hr/employees', { name: 'น้องบี', startDate: '2026-11-02', user: { username: 'b.mgr', role: 'manager', password: '1234' } })).status).toBe(403);

    // cannot delete a role still in use
    expect((await owner.post(`/api/roles/${hr.id}/delete`)).status).toBe(409);
    expect((await owner.post('/api/roles', { name: 'ฝ่ายบุคคล', base: 'acct' })).status).toBe(409);
    expect((await client(env.app).get('/api/roles')).status).toBe(401);
  });
});

describe('customer master', () => {
  it('create with a customer type, edit, credit limit only by manager / owner, inactive customers leave the picker', async () => {
    const c = await boy.post('/api/customers', { name: 'ช่างเอก ก่อสร้าง', phone: '081-555-0101', type: 'ช่าง' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ type: 'ช่าง', active: true, creditLimit: '0.00' });
    const own = await owner.post('/api/customers', { name: 'หจก. ทดสอบรับเหมา', type: 'งานรีโนเวท' });
    expect(own.body.type).toBe('งานรีโนเวท'); // the shop's own words

    // sales staff have no data.master: cannot edit
    expect((await boy.patch(`/api/customers/${c.body.id}`, { note: 'x' })).status).toBe(403);
    // manager edits and sets the credit limit
    const ed = await suda.patch(`/api/customers/${c.body.id}`, { creditLimit: '30000', term: { t: 'days', x: 30 }, type: 'บริษัทรับเหมา' });
    expect(ed.status).toBe(200);
    expect(ed.body).toMatchObject({ creditLimit: '30000.00', term: { t: 'days', x: 30 }, type: 'บริษัทรับเหมา' });
    const audit = await env.pool.query(`select detail from audit_log where object = 'customer' and ref = $1 order by at desc limit 1`, [c.body.code]);
    expect(audit.rows[0].detail).toContain('วงเงินเครดิต: 0.00 → 30000.00');

    const m = await boy.get(`/api/customers/master?q=${encodeURIComponent('ช่างเอก')}`);
    expect(m.body.items[0]).toMatchObject({ code: c.body.code, arBalance: '0.00', openOrders: '0.00' });
    expect((await boy.get('/api/customers/master?type=' + encodeURIComponent('บริษัทรับเหมา'))).body.items.map((x: { code: string }) => x.code)).toContain(c.body.code);

    await suda.patch(`/api/customers/${c.body.id}`, { active: false });
    expect((await boy.get(`/api/customers?q=${encodeURIComponent('ช่างเอก')}`)).body.items).toHaveLength(0);
    expect((await boy.get(`/api/customers/master?status=inactive`)).body.items.map((x: { code: string }) => x.code)).toContain(c.body.code);
  });

  it('a role without sales.creditApv cannot change the credit limit even with data.master', async () => {
    const sales = ((await owner.get('/api/roles')).body as { key: string; grants: Record<string, unknown> }[]).find((r) => r.key === 'sales')!;
    await owner.patch('/api/roles/sales', { grants: { ...sales.grants, 'data.master': 1 } });
    const c = (await boy.post('/api/customers', { name: 'คุณบ้านสวย', type: 'เจ้าของบ้าน' })).body;
    expect((await boy.patch(`/api/customers/${c.id}`, { phone: '089-000-0000' })).status).toBe(200);
    expect((await boy.patch(`/api/customers/${c.id}`, { creditLimit: '5000' })).status).toBe(403);
    await owner.patch('/api/roles/sales', { reset: true });
  });
});
