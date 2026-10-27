import type { Pool, Tx } from '@erp/db';
import { perm, type PermKey, type PermValue, type Role } from '@erp/core';
import { E } from './errors';

export type Edition = 'cloud' | 'onprem';

/** The signed-in user, resolved per request from the JWT and re-checked against the users table. */
export interface Ctx {
  tenantId: string;
  userId: string;
  name: string;
  role: Role;
}

export interface TestHooks {
  /** Called inside a document transaction right before COMMIT (tests use it to simulate a crash). */
  beforeCommit?: (op: string, tx: Tx) => Promise<void> | void;
}

export interface Deps {
  pool: Pool;
  edition: Edition;
  hooks: TestHooks;
  /** Business date 'YYYY-MM-DD' in the shop's time zone (Asia/Bangkok). */
  today: () => string;
  backupScript?: string;
  /** On-prem: API requests from other LAN machines must carry a paired erp_device cookie. */
  requireDevicePairing: boolean;
  /** Whether module timers / schedulers may start (false in tests and on serverless hosts such as Vercel). */
  backgroundJobs: boolean;
}

export const bangkokToday = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const can = (ctx: Ctx, key: PermKey): PermValue => perm(ctx.role, key);

/** Full permission (1) required; 'ro' is accepted when readOnly is true. */
export function requirePerm(ctx: Ctx, key: PermKey, opts: { readOnly?: boolean } = {}): void {
  const v = can(ctx, key);
  if (v === 1 || (opts.readOnly && v === 'ro')) return;
  throw E.forbidden(`Permission ${key} is required`, { perm: key, value: v });
}

export function requireAny(ctx: Ctx, keys: PermKey[], opts: { readOnly?: boolean } = {}): void {
  if (keys.some((k) => { const v = can(ctx, k); return v === 1 || (opts.readOnly && v === 'ro'); })) return;
  throw E.forbidden(`One of ${keys.join(', ')} is required`, { perms: keys });
}
