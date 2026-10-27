/**
 * REQ-M19-07 whole-shop export (on-prem) and import into a NEW cloud tenant (SCG Admin), also used to restore a
 * cloud backup on a new on-prem machine (M19-09).
 *
 * Export: every public table with a tenant_id column (read inside the shop's RLS scope), minus machine-local tables.
 * Import: one transaction in the new tenant's RLS scope. Every uuid primary key gets a fresh uuid (so the same file can
 * be imported next to its source) and every reference to it — uuid columns, text columns and values inside jsonb —
 * is rewritten. Identity (bigint) keys get fresh sequence values; FK-declared references and the known stock lot
 * references are rewritten. audit_log rows are replayed in chain order, so the new tenant gets its own valid hash
 * chain with the same entries (who, when, what). Stock lots, AR/AP balances and doc_counters (last document
 * numbers) come across unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, Tx } from '@erp/db';
import { withTenant } from '@erp/db';
import { d, sum } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { E } from '../../lib/errors';

export const EXPORT_FORMAT = 'scg-erp-shop';
export const EXPORT_VERSION = 1;
/** Machine-local or secret tables that never travel with the shop. */
const SKIP = new Set(['tenants', 'devices', 'pairing_codes', 'backup_config', 'licenses', 'support_grants']);
/** References to identity keys that are not declared as foreign keys in the core schema. */
const KNOWN_IDENTITY_REFS: { table: string; column: string; target: string }[] = [
  { table: 'stock_move_lots', column: 'lot_id', target: 'stock_lots' },
  { table: 'stock_lots', column: 'source_lot_id', target: 'stock_lots' },
];
const TENANT_COPY = ['name', 'tax_id', 'branch', 'address', 'phone', 'vat_registered', 'b2b_vat_mode', 'doc_patterns'] as const;

export interface ShopExport {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  source: { tenantId: string; code: string; name: string; taxId: string };
  tenant: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

interface Col { name: string; type: string; identity: boolean; generated: boolean }

/** Base tables of the public schema that have a tenant_id column. */
async function tenantTables(tx: Tx): Promise<string[]> {
  const r = await tx.query<{ t: string }>(
    `select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
      order by c.relname`,
  );
  return r.rows.map((x) => x.t).filter((t) => !SKIP.has(t));
}

async function columnsOf(tx: Tx, table: string): Promise<Col[]> {
  const r = await tx.query<{ name: string; type: string; identity: string; generated: string }>(
    `select a.attname name, format_type(a.atttypid, a.atttypmod) type, a.attidentity identity, a.attgenerated generated
       from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
    [table],
  );
  return r.rows.map((c) => ({ name: c.name, type: c.type, identity: c.identity !== '', generated: c.generated !== '' }));
}

/** Single-column foreign keys among the given tables: child.column -> parent.column. */
async function foreignKeys(tx: Tx): Promise<{ table: string; column: string; target: string; targetColumn: string }[]> {
  const r = await tx.query<{ table: string; column: string; target: string; target_column: string }>(
    `select cl.relname "table", a.attname "column", tl.relname target, ta.attname target_column
       from pg_constraint k
       join pg_class cl on cl.oid = k.conrelid join pg_namespace n on n.oid = cl.relnamespace
       join pg_class tl on tl.oid = k.confrelid
       join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
       join pg_attribute ta on ta.attrelid = k.confrelid and ta.attnum = k.confkey[1]
      where k.contype = 'f' and n.nspname = 'public' and array_length(k.conkey, 1) = 1`,
  );
  return r.rows.map((x) => ({ table: x.table, column: x.column, target: x.target, targetColumn: x.target_column }));
}

export async function exportShop(tx: Tx, tenantId: string): Promise<ShopExport> {
  const t = (await tx.query<Record<string, unknown>>(`select * from tenants where id = $1`, [tenantId])).rows[0];
  if (!t) throw E.notFound('Shop not found');
  const tables: ShopExport['tables'] = {};
  for (const name of await tenantTables(tx)) {
    const order = name === 'audit_log' ? 'order by chain_seq' : '';
    // Timestamps as text keep PostgreSQL's microseconds (a JS Date would round them to milliseconds).
    const list = (await columnsOf(tx, name)).map((c) => (c.type.startsWith('timestamp') ? `${quoteIdent(c.name)}::text as ${quoteIdent(c.name)}` : quoteIdent(c.name))).join(', ');
    tables[name] = (await tx.query<Record<string, unknown>>(`select ${list} from ${quoteIdent(name)} ${order}`)).rows.map(jsonSafe);
  }
  return {
    format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(),
    source: { tenantId, code: String(t.code), name: String(t.name), taxId: String(t.tax_id) },
    tenant: Object.fromEntries(TENANT_COPY.map((k) => [k, t[k]])), tables,
  };
}

export interface ImportOptions {
  code: string; edition: 'cloud' | 'onprem'; region?: string; who: { name: string; userId: string | null }; detail?: string;
  /** Cloud: the owner must accept the SCG terms before using the imported shop (BR-15). */
  termsRequired?: boolean;
  /** Runs inside the import transaction after loading (e.g. extra audit); a throw rolls the whole import back. */
  after?: (tx: Tx, tenantId: string) => Promise<void>;
}
export interface ImportVerification { tables: number; rows: number; numericColumns: number; auditChainOk: boolean }
export interface ImportResult { tenantId: string; tables: Record<string, number>; verified: ImportVerification }

const NUMERIC = /^(numeric|integer|bigint|smallint|double precision|real)/;

/**
 * Creates the new tenant and loads every table in FK order, then proves REQ-M19-07 "100% match" inside the same
 * transaction: for every table the row count and the sum of every numeric column (quantities, stock lot remaining
 * and cost, AR/AP balances, doc counter sequences, ...) equal the file's, and the replayed audit chain verifies.
 * Any mismatch throws and nothing is kept.
 */
export async function importShop(pool: Pool, data: ShopExport, opts: ImportOptions): Promise<ImportResult> {
  if (data?.format !== EXPORT_FORMAT || data.version !== EXPORT_VERSION || typeof data.tables !== 'object') throw E.validation('Not a shop export file', { reason: 'EXPORT_FORMAT' });
  const tenantId = randomUUID();
  const counts: Record<string, number> = {};
  let verified: ImportVerification | undefined;
  await withTenant(pool, tenantId, async (tx) => {
    await tx.query(`select set_config('app.bulk_import', 'on', true)`);
    const tn = data.tenant;
    await tx.query(
      `insert into tenants (id, code, name, tax_id, branch, address, phone, vat_registered, b2b_vat_mode, doc_patterns, adm_edition, adm_region, adm_terms_required)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [tenantId, opts.code, tn.name, tn.tax_id ?? '', tn.branch ?? 'สำนักงานใหญ่', tn.address ?? '', tn.phone ?? '', tn.vat_registered ?? true,
        tn.b2b_vat_mode ?? 'exc', JSON.stringify(tn.doc_patterns ?? {}), opts.edition, opts.region ?? '', opts.termsRequired ?? false],
    );
    const present = new Set(await tenantTables(tx));
    const unknown = Object.keys(data.tables).filter((t) => !present.has(t));
    if (unknown.length) throw E.validation(`The file has tables this server does not know: ${unknown.join(', ')}`, { reason: 'EXPORT_TABLES', tables: unknown });

    const cols = new Map<string, Col[]>();
    for (const t of Object.keys(data.tables)) cols.set(t, await columnsOf(tx, t));

    // 1. fresh uuid for every uuid primary key "id"
    const uuidMap = new Map<string, string>();
    for (const [t, rows] of Object.entries(data.tables)) {
      if (!cols.get(t)!.some((c) => c.name === 'id' && c.type === 'uuid')) continue;
      for (const r of rows) if (typeof r.id === 'string') uuidMap.set(r.id, randomUUID());
    }
    uuidMap.set(data.source.tenantId, tenantId);
    // 2. fresh identity values
    const idMaps = new Map<string, Map<string, string>>(); // "table.column" -> old -> new
    for (const [t, rows] of Object.entries(data.tables)) {
      for (const c of cols.get(t)!.filter((x) => x.identity)) {
        const m = new Map<string, string>();
        if (rows.length) {
          const seq = (await tx.query<{ s: string }>(`select pg_get_serial_sequence($1, $2) s`, [t, c.name])).rows[0]!.s;
          const vals = (await tx.query<{ v: string }>(`select nextval($1)::text v from generate_series(1, $2)`, [seq, rows.length])).rows;
          rows.forEach((r, i) => m.set(String(r[c.name]), vals[i]!.v));
        }
        idMaps.set(`${t}.${c.name}`, m);
      }
    }
    const fks = await foreignKeys(tx);
    const identityRefs = [...KNOWN_IDENTITY_REFS.map((k) => ({ ...k, targetColumn: 'id' })), ...fks].filter((f) => idMaps.has(`${f.target}.${f.targetColumn}`));

    const remapValue = (v: unknown): unknown => {
      if (typeof v === 'string') return uuidMap.get(v) ?? v;
      if (Array.isArray(v)) return v.map(remapValue);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remapValue(x)]));
      return v;
    };

    for (const t of insertOrder(Object.keys(data.tables), fks)) {
      const rows = data.tables[t]!;
      counts[t] = rows.length;
      if (!rows.length) continue;
      const tc = cols.get(t)!.filter((c) => !c.generated && !(t === 'audit_log' && ['chain_seq', 'prev_hash', 'hash'].includes(c.name)));
      const refs = identityRefs.filter((f) => f.table === t);
      const mapped = rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const c of tc) {
          let v = r[c.name];
          if (c.name === 'tenant_id') v = tenantId;
          else if (c.identity) v = v == null ? v : idMaps.get(`${t}.${c.name}`)!.get(String(v));
          else if (refs.some((f) => f.column === c.name)) {
            const f = refs.find((x) => x.column === c.name)!;
            v = v == null ? v : (idMaps.get(`${f.target}.${f.targetColumn}`)!.get(String(v)) ?? v);
          } else v = remapValue(v);
          o[c.name] = v;
        }
        return o;
      });
      const names = tc.map((c) => quoteIdent(c.name)).join(', ');
      const overriding = tc.some((c) => c.identity) ? 'overriding system value' : '';
      for (let i = 0; i < mapped.length; i += 1000) {
        await tx.query(
          `insert into ${quoteIdent(t)} (${names}) ${overriding} select ${names} from json_populate_recordset(null::${quoteIdent(t)}, $1::json)`,
          [JSON.stringify(mapped.slice(i, i + 1000))],
        );
      }
    }
    verified = await verifyImport(tx, data, cols, identityRefs);
    if (opts.after) await opts.after(tx, tenantId);
    await writeAudit(tx, { tenantId, userId: opts.who.userId, name: opts.who.name }, [{
      action: 'import', object: 'tenant', ref: opts.code,
      detail: opts.detail ?? `นำเข้าข้อมูลทั้งร้านจากไฟล์ export ${data.exportedAt} (ร้านเดิม ${data.source.code})`,
    }]);
  });
  return { tenantId, tables: counts, verified: verified! };
}

/** Row counts + numeric column sums of the file vs the loaded tenant; audit chain re-verified. Throws on any difference. */
async function verifyImport(tx: Tx, data: ShopExport, cols: Map<string, Col[]>, identityRefs: { table: string; column: string }[]): Promise<ImportVerification> {
  const diffs: string[] = [];
  let rows = 0;
  let numericColumns = 0;
  for (const [t, fileRows] of Object.entries(data.tables)) {
    const nums = cols.get(t)!.filter((c) => NUMERIC.test(c.type) && !c.identity && !c.generated
      && !identityRefs.some((f) => f.table === t && f.column === c.name) && !(t === 'audit_log' && c.name === 'chain_seq'));
    const sel = ['count(*)::text n', ...nums.map((c, i) => `coalesce(sum(${quoteIdent(c.name)}), 0)::text s${i}`)].join(', ');
    const db = (await tx.query<Record<string, string>>(`select ${sel} from ${quoteIdent(t)}`)).rows[0]!;
    if (Number(db.n) !== fileRows.length) diffs.push(`${t}: ${db.n} rows, file has ${fileRows.length}`);
    nums.forEach((c, i) => {
      const want = sum(fileRows.map((r) => (r[c.name] == null ? 0 : String(r[c.name]))));
      if (!d(db[`s${i}`]!).eq(want)) diffs.push(`${t}.${c.name}: sum ${db[`s${i}`]} vs file ${want.toString()}`);
    });
    rows += fileRows.length;
    numericColumns += nums.length;
  }
  const broken = (await tx.query<{ b: string | null }>(`select erp_audit_verify(erp_current_tenant())::text b`)).rows[0]!.b;
  if (broken) diffs.push(`audit chain broken at ${broken}`);
  if (diffs.length) throw E.conflict('Imported data does not match the file; nothing was imported', { reason: 'IMPORT_MISMATCH', diffs: diffs.slice(0, 20) });
  return { tables: Object.keys(data.tables).length, rows, numericColumns, auditChainOk: true };
}

/** Parents before children (FKs among the imported tables); users first so every created_by resolves. */
function insertOrder(tables: string[], fks: { table: string; target: string }[]): string[] {
  const set = new Set(tables);
  const deps = new Map(tables.map((t) => [t, new Set(fks.filter((f) => f.table === t && f.target !== t && set.has(f.target)).map((f) => f.target))]));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, stack: Set<string>) => {
    if (seen.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const p of deps.get(t) ?? []) visit(p, stack);
    stack.delete(t);
    seen.add(t);
    out.push(t);
  };
  for (const t of ['users', ...tables.filter((x) => x !== 'users').sort()]) if (set.has(t)) visit(t, new Set());
  return out;
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
const jsonSafe = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
