/** M14 SCG Admin accounts: edit, active / disabled, password reset, and the rules around them (super only, no self-lockout). */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '@erp/db';
import { seedAdmin } from '@erp/db/src/seedAdmin';
import { client, setupEnv, type Client, type Env } from '../helpers';
import { admLogin, buildCloud } from './util';

let env: Env;
let cloud: FastifyInstance;
let scg: Client;
let nokId: string;
let selfId: string;

const audit = async () => (await withTenant(env.pool, null, async (tx) => {
  await tx.query(`select set_config('app.platform','on',true)`);
  return tx.query<{ action: string; ref: string; detail: string; admin_name: string }>(`select action, ref, detail, admin_name from platform_audit where object = 'admin' and action not in ('login','login-failed') order by id`);
})).rows;

beforeAll(async () => {
  env = await setupEnv();
  await seedAdmin(env.pool, env.seed.tenantId);
  cloud = await buildCloud(env.pool);
  scg = await admLogin(cloud);
  const list = (await scg.get('/api/adm/admins')).body.items as { id: string; username: string }[];
  nokId = list.find((x) => x.username === 'nok.master')!.id;
  selfId = list.find((x) => x.username === 'scg.admin')!.id;
});
afterAll(async () => { await cloud.close(); await env.close(); });

describe('PATCH /api/adm/admins/:id', () => {
  it('edits name and role; the list shows the change; audited', async () => {
    const r = await scg.patch(`/api/adm/admins/${nokId}`, { name: 'คุณนก (ข้อมูลหลัก)', role: 'support' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: 'nok.master', name: 'คุณนก (ข้อมูลหลัก)', role: 'support', status: 'active' });
    expect((await audit()).at(-1)).toMatchObject({ action: 'update', ref: 'nok.master', admin_name: 'คุณกานต์ (SCG Admin)' });
    await scg.patch(`/api/adm/admins/${nokId}`, { role: 'master' });
  });

  it('only a super may edit; an empty body and an unknown id are refused', async () => {
    const nok = await admLogin(cloud, 'nok.master');
    expect((await nok.patch(`/api/adm/admins/${selfId}`, { name: 'x' })).body.details.reason).toBe('ADM_ROLE');
    expect((await scg.patch(`/api/adm/admins/${nokId}`, {})).body.code).toBe('VALIDATION');
    expect((await scg.patch(`/api/adm/admins/${nokId}`, { password: 'short' })).body.code).toBe('VALIDATION');
    expect((await scg.patch('/api/adm/admins/00000000-0000-4000-8000-000000000000', { name: 'x' })).status).toBe(404);
    expect((await scg.patch('/api/adm/admins/not-a-uuid', { name: 'x' })).status).toBe(404);
  });

  it('a disabled admin cannot sign in and an existing token stops working on the next request; reactivating restores both', async () => {
    const nok = await admLogin(cloud, 'nok.master');
    expect((await nok.get('/api/adm/kpi')).status).toBe(200);
    const off = await scg.patch(`/api/adm/admins/${nokId}`, { status: 'disabled' });
    expect(off.body.status).toBe('disabled');
    const lg = await client(cloud).post('/api/adm/auth/login', { username: 'nok.master', password: '1234' });
    expect(lg.status).toBe(401);
    expect(lg.body.details.reason).toBe('DISABLED');
    const stale = await nok.get('/api/adm/kpi');
    expect(stale.status).toBe(401);
    expect(stale.body.details.reason).toBe('DISABLED');
    expect((await scg.get('/api/adm/admins')).body.items.find((x: { id: string }) => x.id === nokId).status).toBe('disabled');
    const on = await scg.patch(`/api/adm/admins/${nokId}`, { status: 'active' });
    expect(on.body.status).toBe('active');
    expect((await admLogin(cloud, 'nok.master')).get).toBeTruthy();
    expect((await audit()).slice(-2).map((x) => x.action)).toEqual(['deactivate', 'activate']);
  });

  it('a super cannot disable or demote themself, and the last active super always stays', async () => {
    const a = await scg.patch(`/api/adm/admins/${selfId}`, { status: 'disabled' });
    expect(a.status).toBe(409);
    expect(a.body.details.reason).toBe('LAST_SUPER');
    expect((await scg.patch(`/api/adm/admins/${selfId}`, { role: 'support' })).body.details.reason).toBe('LAST_SUPER');
    // with a second active super the self-lockout rule applies instead
    await scg.patch(`/api/adm/admins/${nokId}`, { role: 'super' });
    const s = await scg.patch(`/api/adm/admins/${selfId}`, { status: 'disabled' });
    expect(s.status).toBe(409);
    expect(s.body.details.reason).toBe('ADM_SELF');
    expect((await scg.patch(`/api/adm/admins/${selfId}`, { role: 'master' })).body.details.reason).toBe('ADM_SELF');
    // the other super may demote the first (and edits their own name freely)
    expect((await scg.patch(`/api/adm/admins/${selfId}`, { name: 'คุณกานต์' })).status).toBe(200);
    await scg.patch(`/api/adm/admins/${selfId}`, { name: 'คุณกานต์ (SCG Admin)' });
    await scg.patch(`/api/adm/admins/${nokId}`, { role: 'master' });
  });

  it('reset password: the old one stops working, a locked account is unlocked, audited without the password', async () => {
    for (let i = 0; i < 5; i++) await client(cloud).post('/api/adm/auth/login', { username: 'nok.master', password: 'bad' });
    expect((await client(cloud).post('/api/adm/auth/login', { username: 'nok.master', password: '1234' })).body.details.reason).toBe('LOCKED');
    const r = await scg.patch(`/api/adm/admins/${nokId}`, { password: 'new-secret-9' });
    expect(r.status).toBe(200);
    expect((await client(cloud).post('/api/adm/auth/login', { username: 'nok.master', password: '1234' })).status).toBe(401);
    expect((await client(cloud).post('/api/adm/auth/login', { username: 'nok.master', password: 'new-secret-9' })).status).toBe(200);
    const last = (await audit()).at(-1)!;
    expect(last).toMatchObject({ action: 'reset-password', ref: 'nok.master' });
    expect(JSON.stringify(await audit())).not.toContain('new-secret-9');
  });
});
