import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, login, setupEnv, type Env } from './helpers';

let env: Env;
beforeAll(async () => { env = await setupEnv(); });
afterAll(async () => { await env.close(); });

describe('auth (M01, BR-18)', () => {
  it('logs in with argon2id password and returns perms from core.perm', async () => {
    const r = await client(env.app).post('/api/auth/login', { username: 'prae', password: '1234' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ name: 'น้องแพร', role: 'cashier' });
    expect(r.body.user.perms['pos.discCap']).toBe(0);
    expect(r.body.user.perms['data.cost']).toBe(0);
    const hash = await env.pool.query(`select password_hash from users where username = 'prae'`);
    expect(hash.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    const me = await client(env.app, r.body.token).get('/api/auth/me');
    expect(me.body.id).toBe(env.seed.users.prae);
  });

  it('lists active approvers (owner, manager) for PIN approvals', async () => {
    const r = await login(env.app, 'prae');
    const res = await r.get('/api/users/approvers');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { id: env.seed.users.charoen, name: 'คุณเจริญ ศรีสุข', role: 'owner' },
      { id: env.seed.users.suda, name: 'คุณสุดา ศรีสุข', role: 'manager' },
    ]);
    expect((await client(env.app).get('/api/users/approvers')).status).toBe(401);
  });

  it('rejects requests without a token', async () => {
    const r = await client(env.app).get('/api/products');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHORIZED');
  });

  it('locks the account after 5 failed logins, even for the right password afterwards', async () => {
    const c = client(env.app);
    for (let i = 1; i <= 4; i++) {
      const r = await c.post('/api/auth/login', { username: 'boy', password: 'wrong' });
      expect(r.status).toBe(401);
      expect(r.body.details.reason).toBe('BAD_CREDENTIALS');
    }
    const fifth = await c.post('/api/auth/login', { username: 'boy', password: 'wrong' });
    expect(fifth.body.details.reason).toBe('LOCKED');
    const right = await c.post('/api/auth/login', { username: 'boy', password: '1234' });
    expect(right.status).toBe(401);
    expect(right.body.details.reason).toBe('LOCKED');

    // owner unlocks
    const owner = await login(env.app, 'charoen');
    expect((await owner.post(`/api/users/${env.seed.users.boy}/unlock`)).status).toBe(200);
    expect((await c.post('/api/auth/login', { username: 'boy', password: '1234' })).status).toBe(200);
  });

  it('rejects a resigned user and logs the failed attempt', async () => {
    const r = await client(env.app).post('/api/auth/login', { username: 'ton', password: '1234' });
    expect(r.status).toBe(401);
    expect(r.body.details.reason).toBe('RESIGNED');
    const log = await env.pool.query(`select action, detail from audit_log where ref = 'ton' order by chain_seq desc limit 1`);
    expect(log.rows[0]).toMatchObject({ action: 'login-failed' });
  });

  it('rejects an unknown user with the same answer as a wrong password', async () => {
    const r = await client(env.app).post('/api/auth/login', { username: 'nobody', password: 'x' });
    expect(r.status).toBe(401);
    expect(r.body.details.reason).toBe('BAD_CREDENTIALS');
  });

  it('hides product cost without data.cost', async () => {
    const cashier = await login(env.app, 'prae');
    const owner = await login(env.app, 'charoen');
    const a = await cashier.get('/api/products?q=SCG-CEM-T50');
    const b = await owner.get('/api/products?q=SCG-CEM-T50');
    expect(a.body.items[0].cost).toBeNull();
    expect(b.body.items[0].cost).toBe('122');
  });
});
