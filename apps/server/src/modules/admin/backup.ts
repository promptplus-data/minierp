/**
 * REQ-M19-09 optional cloud backup for on-prem shops (OQ-A10): off by default; the shop chooses a destination it owns
 * (S3 / S3-compatible bucket implemented; Google Drive and OneDrive are STUBS — see README "Cloud backup").
 * Every backup is the whole-shop export (transfer.ts) encrypted on this machine with a key derived from the shop's
 * passphrase (box.ts, AES-256-GCM + scrypt) before upload. Only the derived key is kept here, never the passphrase;
 * restoring on a new machine needs the passphrase again. Last success / failure is shown in settings.
 */
import type { z } from 'zod';
import { withTenant, type Pool, type Tx } from '@erp/db';
import type { BackupConfig, BackupConfigSave, BackupRestoreReq, BackupRestoreTarget } from '@erp/contracts';
import { writeAudit } from '../../lib/audit';
import type { Ctx } from '../../lib/context';
import { E } from '../../lib/errors';
import { decodeCursor, pageOf } from '../../lib/paging';
import { deriveKey, openBox, sealBox } from './box';
import { S3Client, type S3Object, type S3Settings } from './s3';
import { exportShop, importShop, type ShopExport } from './transfer';

type In<T extends z.ZodTypeAny> = z.output<T>;
export const BACKUP_KIND = 'shop-backup';

/** What a destination must do. Drive / OneDrive adapters plug in here once their OAuth apps exist. */
export interface BackupAdapter { put(name: string, body: Buffer): Promise<void>; get(name: string): Promise<Buffer>; list(): Promise<S3Object[]> }
export type AdapterFactory = (provider: string, settings: Record<string, unknown>) => BackupAdapter;

export const defaultAdapters: AdapterFactory = (provider, settings) => {
  if (provider === 's3') return new S3Client(settings as unknown as S3Settings);
  // OAuth providers: designed (device-code flow, README) but not wired until SCG registers the OAuth apps.
  throw E.validation(`${provider} backup is not available yet`, { reason: 'OAUTH_NOT_CONFIGURED' });
};

interface CfgRow {
  enabled: boolean; provider: 's3' | 'gdrive' | 'onedrive' | null; settings: Record<string, unknown>; key_salt: string | null; derived_key: string | null;
  schedule: 'off' | 'daily'; last_success_at: Date | null; last_failure_at: Date | null; last_error: string | null; last_file: string | null;
}

async function cfgRow(tx: Tx, lock = false): Promise<CfgRow | null> {
  return (await tx.query<CfgRow>(`select * from backup_config ${lock ? 'for update' : ''}`)).rows[0] ?? null;
}

const oauthClients = (env: NodeJS.ProcessEnv = process.env) => ({ gdrive: !!env.BACKUP_GDRIVE_CLIENT_ID, onedrive: !!env.BACKUP_ONEDRIVE_CLIENT_ID });

export function requireOwner(ctx: Ctx, what: string): void {
  if (ctx.role !== 'owner') throw E.forbidden(`Only the shop owner can ${what}`, { reason: 'OWNER_ONLY' });
}

export async function getBackupConfig(tx: Tx, ctx: Ctx): Promise<BackupConfig> {
  requireOwner(ctx, 'manage backups');
  const r = await cfgRow(tx);
  const s = (r?.settings ?? {}) as Record<string, unknown>;
  return {
    enabled: r?.enabled ?? false, provider: r?.provider ?? null, schedule: r?.schedule ?? 'daily',
    s3: r?.provider === 's3' ? {
      endpoint: (s.endpoint as string | undefined) || undefined, region: String(s.region ?? ''), bucket: String(s.bucket ?? ''), prefix: String(s.prefix ?? ''),
      accessKeyId: String(s.accessKeyId ?? ''), forcePathStyle: s.forcePathStyle !== false, hasSecret: !!s.secretAccessKey,
    } : null,
    oauth: r?.provider === 'gdrive' || r?.provider === 'onedrive' ? { connected: !!s.refreshToken, account: (s.account as string | undefined) ?? null } : null,
    hasPassphrase: !!r?.derived_key, lastSuccessAt: r?.last_success_at?.toISOString() ?? null, lastFailureAt: r?.last_failure_at?.toISOString() ?? null,
    lastError: r?.last_error ?? null, lastFile: r?.last_file ?? null, oauthClientConfigured: oauthClients(),
  };
}

export async function saveBackupConfig(tx: Tx, ctx: Ctx, body: In<typeof BackupConfigSave>): Promise<BackupConfig> {
  requireOwner(ctx, 'manage backups');
  const old = await cfgRow(tx, true);
  let settings: Record<string, unknown> = old?.provider === body.provider ? { ...(old?.settings ?? {}) } : {};
  if (body.provider === 's3') {
    if (!body.s3 && old?.provider !== 's3') throw E.validation('S3 settings are required');
    if (body.s3) settings = { ...settings, ...body.s3, secretAccessKey: body.s3.secretAccessKey ?? settings.secretAccessKey };
    if (!settings.secretAccessKey) throw E.validation('The S3 secret access key is required');
  }
  if ((body.provider === 'gdrive' || body.provider === 'onedrive') && body.enabled && !settings.refreshToken) {
    throw E.validation('Connect the account first', { reason: 'OAUTH_NOT_CONNECTED' });
  }
  let salt = old?.key_salt ?? null;
  let key = old?.derived_key ?? null;
  if (body.passphrase) {
    const k = deriveKey(body.passphrase);
    salt = k.salt;
    key = k.key.toString('base64');
  }
  if (body.enabled && (!body.provider || !key)) throw E.validation('Choose a destination and set a backup passphrase first', { reason: 'BACKUP_INCOMPLETE' });
  await tx.query(
    `insert into backup_config (tenant_id, enabled, provider, settings, key_salt, derived_key, schedule) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id) do update set enabled = excluded.enabled, provider = excluded.provider, settings = excluded.settings,
       key_salt = excluded.key_salt, derived_key = excluded.derived_key, schedule = excluded.schedule, updated_at = now()`,
    [ctx.tenantId, body.enabled, body.provider, JSON.stringify(settings), salt, key, body.schedule]);
  const out = await getBackupConfig(tx, ctx);
  await writeAudit(tx, ctx, [{
    action: 'update', object: 'settings', ref: 'backup',
    detail: `สำรองข้อมูลขึ้น cloud: ${body.enabled ? 'เปิด' : 'ปิด'} · ปลายทาง ${body.provider ?? '-'} · ${body.schedule === 'daily' ? 'ทุกวัน' : 'กดเอง'}${body.passphrase ? ' · ตั้งรหัสเข้ารหัสใหม่' : ''}`,
  }]);
  return out;
}

const fileName = (now: Date, code: string) => `${code}-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.scgbackup`;

/**
 * One backup run. Never throws for destination errors: the failure is recorded (last status + run row) and returned,
 * so the scheduler and the button both show what happened.
 */
export async function runBackup(tx: Tx, who: Ctx | { tenantId: string; userId: null; name: string }, trigger: 'manual' | 'schedule', adapters: AdapterFactory = defaultAdapters) {
  const c = await cfgRow(tx, true);
  if (!c?.provider || !c.derived_key || !c.key_salt) throw E.validation('Backup is not set up', { reason: 'BACKUP_INCOMPLETE' });
  if (trigger === 'schedule' && !c.enabled) throw E.validation('Backup is off');
  const t = (await tx.query<{ code: string; name: string; tax_id: string }>(`select code, name, tax_id from tenants where id = $1`, [who.tenantId])).rows[0]!;
  const now = new Date();
  const name = fileName(now, t.code);
  let bytes: number | null = null;
  let error: string | null = null;
  try {
    const data = await exportShop(tx, who.tenantId);
    const box = Buffer.from(sealBox(BACKUP_KIND, { shopName: t.name, taxId: t.tax_id, createdAt: now.toISOString() }, data, { key: Buffer.from(c.derived_key, 'base64'), salt: c.key_salt }));
    bytes = box.length;
    await adapters(c.provider, c.settings).put(name, box);
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }
  const ok = !error;
  if (ok) await tx.query(`update backup_config set last_success_at = now(), last_file = $2, last_error = null where tenant_id = $1`, [who.tenantId, name]);
  else await tx.query(`update backup_config set last_failure_at = now(), last_error = $2 where tenant_id = $1`, [who.tenantId, error]);
  const r = await tx.query<{ id: string; at: Date }>(
    `insert into backup_runs (tenant_id, provider, trigger, file_name, bytes, status, error, user_id) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, at`,
    [who.tenantId, c.provider, trigger, ok ? name : null, bytes, ok ? 'ok' : 'failed', error, who.userId]);
  await writeAudit(tx, who, [{ action: ok ? 'backup' : 'backup-failed', object: 'backup', ref: ok ? name : null, detail: `${c.provider} · ${trigger}${ok ? ` · ${bytes} bytes` : ` · ${error}`}` }]);
  return { id: r.rows[0]!.id, at: r.rows[0]!.at.toISOString(), provider: c.provider, trigger, fileName: ok ? name : null, bytes, status: ok ? 'ok' as const : 'failed' as const, error };
}

export async function listBackupRuns(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string }) {
  requireOwner(ctx, 'manage backups');
  const cur = decodeCursor(q.cursor, 2);
  const r = await tx.query<{ id: string; at: Date; provider: string; trigger: string; file_name: string | null; bytes: string | null; status: 'ok' | 'failed'; error: string | null }>(
    `select id, at, provider, trigger, file_name, bytes::text, status, error from backup_runs ${cur ? 'where (at, id) < ($2::timestamptz, $3::uuid)' : ''} order by at desc, id desc limit $1`,
    cur ? [q.limit + 1, cur[0], cur[1]] : [q.limit + 1]);
  return pageOf(r.rows, q.limit, (x) => [x.at.toISOString(), x.id], (x) => ({ ...x, at: x.at.toISOString(), fileName: x.file_name, bytes: x.bytes == null ? null : Number(x.bytes) }));
}

export async function listBackupFiles(tx: Tx, ctx: Ctx, adapters: AdapterFactory = defaultAdapters) {
  requireOwner(ctx, 'manage backups');
  const c = await cfgRow(tx);
  if (!c?.provider) throw E.validation('Backup is not set up', { reason: 'BACKUP_INCOMPLETE' });
  try {
    return { items: (await adapters(c.provider, c.settings).list()).filter((f) => f.name.endsWith('.scgbackup')) };
  } catch (err) {
    if (err instanceof Error && err.name === 'AppError') throw err;
    throw E.validation(`Could not list backups: ${err instanceof Error ? err.message : String(err)}`, { reason: 'BACKUP_DEST' });
  }
}

// ---------------------------------------------------------------- restore on a new machine (setup screen)
export async function restoreFiles(target: In<typeof BackupRestoreTarget>, adapters: AdapterFactory = defaultAdapters) {
  try {
    return { items: (await adapters(target.provider, target.s3).list()).filter((f) => f.name.endsWith('.scgbackup')) };
  } catch (err) {
    throw E.validation(`Could not list backups: ${err instanceof Error ? err.message : String(err)}`, { reason: 'BACKUP_DEST' });
  }
}

/** Decrypts a backup with the passphrase and loads it as this machine's shop (only while the database is empty). */
export async function restoreBackup(pool: Pool, body: In<typeof BackupRestoreReq>, adapters: AdapterFactory = defaultAdapters) {
  let text: string;
  try {
    text = (await adapters(body.provider, body.s3).get(body.file)).toString('utf8');
  } catch (err) {
    throw E.validation(`Could not download the backup: ${err instanceof Error ? err.message : String(err)}`, { reason: 'BACKUP_DEST' });
  }
  const { payload, meta } = openBox<ShopExport>(text, body.passphrase, BACKUP_KIND);
  const res = await importShop(pool, payload, {
    code: payload.source.code, edition: 'onprem', who: { userId: null, name: 'ระบบกู้คืนข้อมูล' },
    detail: `กู้คืนจาก backup ${body.file} (สร้าง ${meta.createdAt})`,
    // Keep the destination so backups continue, but the passphrase must be entered again in settings.
    after: async (tx, tenantId) => {
      await tx.query(`insert into backup_config (tenant_id, enabled, provider, settings, schedule) values ($1,false,$2,$3,'daily')`,
        [tenantId, body.provider, JSON.stringify(body.s3)]);
    },
  });
  return { shop: payload.source.name, tables: res.tables, verified: res.verified };
}

/** Daily scheduler (on-prem, deps.backgroundJobs): one backup per enabled shop when the last success is 23 h+ old. */
export function startBackupScheduler(pool: Pool, log: { error: (o: unknown, m: string) => void }, adapters: AdapterFactory = defaultAdapters): () => void {
  const tick = async () => {
    const shops = await withTenant(pool, null, (tx) => tx.query<{ id: string }>(`select id from tenants`), { authLookup: true });
    for (const s of shops.rows) {
      try {
        await withTenant(pool, s.id, async (tx) => {
          const c = await cfgRow(tx);
          if (!c?.enabled || c.schedule !== 'daily' || !c.derived_key) return;
          if (c.last_success_at && Date.now() - c.last_success_at.getTime() < 23 * 3600_000) return;
          if (c.last_failure_at && Date.now() - c.last_failure_at.getTime() < 3600_000) return; // retry hourly at most
          await runBackup(tx, { tenantId: s.id, userId: null, name: 'ระบบสำรองข้อมูลอัตโนมัติ' }, 'schedule', adapters);
        });
      } catch (err) {
        log.error({ err }, 'scheduled cloud backup failed');
      }
    }
  };
  const first = setTimeout(() => void tick(), 60_000);
  const every = setInterval(() => void tick(), 15 * 60_000);
  return () => { clearTimeout(first); clearInterval(every); };
}
