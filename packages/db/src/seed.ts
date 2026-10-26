/**
 * Demo tenant matching docs/mockup.html: ร้านวัสดุเจริญชัย (VAT registered), WH1 หน้าร้าน (POS), WH2 โกดังหลังร้าน,
 * products p1..p12 (p9 = delivery service), opening FIFO lots built exactly like the mockup's initState(),
 * customers c0..c3, vendors v1..v3, users (password "1234", PIN "1234") and one resigned user.
 *
 * CLI: DATABASE_URL=... tsx src/seed.ts [--reset]
 *   Skips when the demo tenant already exists; --reset truncates every table first (dev only).
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import argon2 from 'argon2';
import pg from 'pg';
import { money, qty4, d, type Num } from '@erp/core';
import { TENANT_TABLES } from './schema';
import { withTenant } from './tx';

export interface SeedResult {
  tenantId: string;
  users: Record<string, string>;
  products: Record<string, string>;
  warehouses: Record<string, string>;
  customers: Record<string, string>;
  vendors: Record<string, string>;
}

let hash1234: Promise<string> | undefined;
/** argon2id hash of "1234", computed once per process (the salt is inside the hash string). */
const demoHash = () => (hash1234 ??= argon2.hash('1234', { type: argon2.argon2id }));

type Unit = { u: string; f: number; price?: number };
type P = { id: string; sku: string; name: string; scg: boolean; bc: string; cat: string; price: number; cost: number; units: Unit[]; min: number; type?: 'service'; bom?: true };

const PRODUCTS: P[] = [
  { id: 'p1', sku: 'SCG-CEM-T50', name: 'ปูนซีเมนต์ตราเสือ 50 กก.', scg: true, bc: '8850001000014', cat: 'ปูนซีเมนต์', price: 145, cost: 122, units: [{ u: 'ถุง', f: 1 }, { u: 'พาเลท', f: 40 }], min: 80 },
  { id: 'p2', sku: 'SCG-ROOF-LK', name: 'กระเบื้องหลังคาลอนคู่ 50×120 ซม. สีเทา', scg: true, bc: '8850001000212', cat: 'หลังคา', price: 52, cost: 44, units: [{ u: 'แผ่น', f: 1 }, { u: 'มัด', f: 50 }], min: 200 },
  { id: 'p3', sku: 'SCG-AAC-75', name: 'อิฐมวลเบา 7.5 ซม.', scg: true, bc: '8850001000519', cat: 'ผนัง', price: 24, cost: 19.5, units: [{ u: 'ก้อน', f: 1 }, { u: 'พาเลท', f: 200 }], min: 400 },
  { id: 'p4', sku: 'SCG-TA-20', name: 'กาวซีเมนต์ปูกระเบื้อง 20 กก.', scg: true, bc: '8850001000717', cat: 'กาว/ยาแนว', price: 210, cost: 176, units: [{ u: 'ถุง', f: 1 }], min: 30 },
  { id: 'p5', sku: 'RB9-10', name: 'เหล็กเส้นกลม RB9 ยาว 10 ม.', scg: false, bc: '2000000000091', cat: 'เหล็ก', price: 165, cost: 142, units: [{ u: 'เส้น', f: 1 }, { u: 'เมตร (ตัดขาย)', f: 0.1, price: 18 }], min: 100 },
  { id: 'p6', sku: 'PVC-4-85', name: 'ท่อ PVC 4 หุน ชั้น 8.5 ยาว 4 ม.', scg: false, bc: '2000000000107', cat: 'ประปา', price: 89, cost: 71, units: [{ u: 'เส้น', f: 1 }, { u: 'มัด', f: 20 }], min: 40 },
  { id: 'p7', sku: 'PNT-PR9', name: 'สีรองพื้นปูนใหม่ 9 ลิตร', scg: false, bc: '2000000000206', cat: 'สี', price: 1290, cost: 1050, units: [{ u: 'ถัง', f: 1 }], min: 6 },
  { id: 'p8', sku: 'SAND-C', name: 'ทรายหยาบ', scg: false, bc: '', cat: 'วัสดุมวลรวม', price: 650, cost: 520, units: [{ u: 'คิว', f: 1 }], min: 5 },
  { id: 'p10', sku: 'STONE-34', name: 'หิน 3/4', scg: false, bc: '', cat: 'วัสดุมวลรวม', price: 750, cost: 600, units: [{ u: 'คิว', f: 1 }], min: 3 },
  { id: 'p11', sku: 'MK-POST-15', name: 'เสาหล่อคอนกรีต 15×15 ซม. ยาว 3 ม.', scg: false, bc: '', cat: 'งานหล่อคอนกรีต (ผลิตเอง)', price: 450, cost: 333.79, units: [{ u: 'ต้น', f: 1 }], min: 10, bom: true },
  { id: 'p12', sku: 'MK-RING-80', name: 'ท่อคอนกรีต (วงบ่อ) ⌀80 ซม.', scg: false, bc: '', cat: 'งานหล่อคอนกรีต (ผลิตเอง)', price: 380, cost: 246, units: [{ u: 'วง', f: 1 }], min: 8, bom: true },
  { id: 'p9', sku: 'SV-DLV', name: 'ค่าขนส่ง (ในเขตอำเภอ)', scg: false, bc: '', cat: 'อื่น ๆ', price: 300, cost: 0, units: [{ u: 'เที่ยว', f: 1 }], min: 0, type: 'service' },
];

/** Mockup `stock` seed (base units). */
const STOCK: Record<string, { WH1: number; WH2: number }> = {
  p1: { WH1: 62, WH2: 340 }, p2: { WH1: 180, WH2: 900 }, p3: { WH1: 300, WH2: 1600 }, p4: { WH1: 24, WH2: 60 },
  p5: { WH1: 85, WH2: 300 }, p6: { WH1: 55, WH2: 120 }, p7: { WH1: 8, WH2: 4 }, p8: { WH1: 0, WH2: 12 },
  p10: { WH1: 0, WH2: 8 }, p11: { WH1: 6, WH2: 14 }, p12: { WH1: 0, WH2: 12 },
};

const CUSTOMERS = [
  { id: 'c0', code: 'C00000', name: 'ลูกค้าทั่วไป (เงินสด)', grp: 'retail', tax: null, br: null, phone: null, term: { t: 'cash' }, limit: 0 },
  { id: 'c1', code: 'C00001', name: 'หจก. รุ่งเรืองก่อสร้าง', grp: 'contr', tax: '0503558001234', br: '00000', phone: '053-333-444', term: { t: 'days', x: 30 }, limit: 200000 },
  { id: 'c2', code: 'C00002', name: 'ร้านวัสดุบ้านนา', grp: 'whole', tax: '3500700123456', br: null, phone: '089-777-1100', term: { t: 'eom' }, limit: 80000 },
  { id: 'c3', code: 'C00003', name: 'คุณสมศรี ทองดี', grp: 'retail', tax: null, br: null, phone: '086-555-7788', term: { t: 'cash' }, limit: 0 },
];

const VENDORS = [
  { id: 'v1', code: 'V00001', name: 'หจก. ทวีพัฒนาวัสดุ (ผู้แทนจำหน่าย)', tax: '0503549000777', br: '00000', phone: '053-444-555', term: { t: 'days', x: 30 } },
  { id: 'v2', code: 'V00002', name: 'บจก. ท่อไทยค้าส่ง', tax: '0105556012345', br: '00000', phone: null, term: { t: 'nextDay', x: 5 } },
  { id: 'v3', code: 'V00003', name: 'ร้านเหล็กสยามเชียงใหม่', tax: '0503551000999', br: '00000', phone: null, term: { t: 'eom' } },
];

const USERS = [
  { username: 'charoen', name: 'คุณเจริญ ศรีสุข', role: 'owner', status: 'active', phone: '081-222-3344' },
  { username: 'suda', name: 'คุณสุดา ศรีสุข', role: 'manager', status: 'active', phone: '086-111-2299' },
  { username: 'prae', name: 'น้องแพร', role: 'cashier', status: 'active', phone: '092-333-4455' },
  { username: 'boy', name: 'พี่บอย', role: 'sales', status: 'active', phone: '081-555-0142' },
  { username: 'chai', name: 'พี่ชัย', role: 'wh', status: 'active', phone: null },
  { username: 'ton', name: 'น้องต้น', role: 'wh', status: 'resigned', phone: null },
];

const r2 = (x: Num) => money(x);
const pad2 = (n: number) => String(n).padStart(2, '0');
const bkk = (date: string) => `${date}T00:00:00+07:00`;

/** Runs fn as the app role inside the new tenant's RLS scope (so seeding works without superuser too). */
const inTenant = <T>(pool: pg.Pool, tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => withTenant(pool, tenantId, fn);

export async function seedDemo(pool: pg.Pool, opts: { code?: string; name?: string } = {}): Promise<SeedResult> {
  const tenantId = randomUUID();
  const hash = await demoHash();
  const out: SeedResult = { tenantId, users: {}, products: {}, warehouses: {}, customers: {}, vendors: {} };
  await inTenant(pool, tenantId, async (c) => {
    await c.query(
      `insert into tenants (id, code, name, tax_id, branch, address, phone, vat_registered, b2b_vat_mode)
       values ($1,$2,$3,'0505561004321','สำนักงานใหญ่','99 ถ.เชียงใหม่-ลำปาง ต.ท่าศาลา อ.เมือง จ.เชียงใหม่ 50000','053-123-456',true,'exc')`,
      [tenantId, opts.code ?? 'charoen', opts.name ?? 'ร้านวัสดุเจริญชัย'],
    );
    for (const u of USERS) {
      const r = await c.query<{ id: string }>(
        `insert into users (tenant_id, username, name, role, password_hash, pin_hash, status, phone) values ($1,$2,$3,$4,$5,$5,$6,$7) returning id`,
        [tenantId, u.username, u.name, u.role, hash, u.status, u.phone],
      );
      out.users[u.username] = r.rows[0]!.id;
    }
    for (const w of [{ code: 'WH1', name: 'หน้าร้าน', pos: true }, { code: 'WH2', name: 'โกดังหลังร้าน', pos: false }]) {
      const r = await c.query<{ id: string }>(
        `insert into warehouses (tenant_id, code, name, is_pos) values ($1,$2,$3,$4) returning id`,
        [tenantId, w.code, w.name, w.pos],
      );
      out.warehouses[w.code] = r.rows[0]!.id;
    }
    for (const p of PRODUCTS) {
      const units = p.units.map((u) => ({ name: u.u, factor: String(u.f), ...(u.price != null ? { price: r2(u.price) } : {}) }));
      const r = await c.query<{ id: string }>(
        `insert into products (tenant_id, sku, name, barcode, category, is_scg, kind, vat, price, cost, units, reorder_point)
         values ($1,$2,$3,$4,$5,$6,$7,'v7',$8,$9,$10,$11) returning id`,
        [tenantId, p.sku, p.name, p.bc || null, p.cat, p.scg, p.type ?? 'stock', r2(p.price), qty4(p.cost), JSON.stringify(units), String(p.min)],
      );
      out.products[p.id] = r.rows[0]!.id;
    }
    // Opening FIFO lots, same shape as the mockup initState(): two lots (older cheaper) when qty >= 2.
    const stockProducts = PRODUCTS.filter((p) => p.type !== 'service');
    for (const [pi, p] of stockProducts.entries()) {
      for (const wh of ['WH1', 'WH2'] as const) {
        const q = STOCK[p.id]?.[wh] ?? 0;
        if (q <= 0) continue;
        const lots: { date: string; q: number; cost: string; ref: string }[] = [];
        if (p.bom) {
          lots.push({ date: p.id === 'p11' ? '2026-10-10' : '2026-10-01', q, cost: r2(p.cost), ref: p.id === 'p11' ? 'MO2610-0003' : 'MO2610-0001' });
        } else {
          const o = q >= 2 ? Math.round(q * 0.4) : 0;
          if (o) lots.push({ date: `2026-09-${pad2(10 + pi)}`, q: o, cost: r2(d(p.cost).times('0.97')), ref: 'ยอดยกมา' });
          lots.push({ date: `2026-10-${pad2(1 + pi)}`, q: q - o, cost: r2(o ? d(p.cost).times('1.02') : p.cost), ref: o ? `GR2610-000${1 + (pi % 4)}` : 'ยอดยกมา' });
        }
        for (const l of lots) {
          await c.query(
            `insert into stock_lots (tenant_id, product_id, warehouse_id, received_at, qty_in, remaining, unit_cost, ref)
             values ($1,$2,$3,$4,$5,$5,$6,$7)`,
            [tenantId, out.products[p.id], out.warehouses[wh], bkk(l.date), String(l.q), l.cost, l.ref],
          );
        }
      }
    }
    for (const cu of CUSTOMERS) {
      const r = await c.query<{ id: string }>(
        `insert into customers (tenant_id, code, name, tax_id, branch, phone, grp, credit_limit, term) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [tenantId, cu.code, cu.name, cu.tax, cu.br, cu.phone, cu.grp, r2(cu.limit), JSON.stringify(cu.term)],
      );
      out.customers[cu.id] = r.rows[0]!.id;
    }
    for (const v of VENDORS) {
      const r = await c.query<{ id: string }>(
        `insert into vendors (tenant_id, code, name, tax_id, branch, phone, term) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [tenantId, v.code, v.name, v.tax, v.br, v.phone, JSON.stringify(v.term)],
      );
      out.vendors[v.id] = r.rows[0]!.id;
    }
    await c.query(`insert into audit_log (tenant_id, user_name, action, object, detail) values ($1,'system','seed','tenant','demo data')`, [tenantId]);
  });
  return out;
}

/** A second, tiny tenant (used by the tenant-isolation tests). */
export async function seedMinimalTenant(pool: pg.Pool, code: string, name: string): Promise<SeedResult> {
  const tenantId = randomUUID();
  const hash = await demoHash();
  const out: SeedResult = { tenantId, users: {}, products: {}, warehouses: {}, customers: {}, vendors: {} };
  await inTenant(pool, tenantId, async (c) => {
    await c.query(`insert into tenants (id, code, name, tax_id, vat_registered) values ($1,$2,$3,'0105500000001',true)`, [tenantId, code, name]);
    const u = await c.query<{ id: string }>(
      `insert into users (tenant_id, username, name, role, password_hash, pin_hash) values ($1,'owner',$2,'owner',$3,$3) returning id`,
      [tenantId, `เจ้าของ ${name}`, hash],
    );
    out.users.owner = u.rows[0]!.id;
    const w = await c.query<{ id: string }>(`insert into warehouses (tenant_id, code, name, is_pos) values ($1,'WH1','หน้าร้าน',true) returning id`, [tenantId]);
    out.warehouses.WH1 = w.rows[0]!.id;
    const p = await c.query<{ id: string }>(
      `insert into products (tenant_id, sku, name, price, cost, units) values ($1,'B-ONLY','สินค้าของร้าน B',100,80,'[{"name":"ชิ้น","factor":"1"}]') returning id`,
      [tenantId],
    );
    out.products.b1 = p.rows[0]!.id;
    await c.query(
      `insert into stock_lots (tenant_id, product_id, warehouse_id, received_at, qty_in, remaining, unit_cost, ref) values ($1,$2,$3,now(),10,10,80,'ยอดยกมา')`,
      [tenantId, out.products.b1, out.warehouses.WH1],
    );
  });
  return out;
}

/** Dev / test only: empties every table (TRUNCATE needs the table owner; DELETE triggers do not fire). */
export async function resetData(pool: pg.Pool): Promise<void> {
  await pool.query(`TRUNCATE ${['tenants', ...TENANT_TABLES].join(', ')} RESTART IDENTITY CASCADE`);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (/seed\.(ts|mjs|js)$/.test(entry) && import.meta.url === pathToFileURL(entry).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString: url });
  (async () => {
    if (process.argv.includes('--reset')) await resetData(pool);
    const exists = await withTenant(pool, null, (c) => c.query(`select 1 from tenants where code = 'charoen'`), { authLookup: true });
    if (exists.rowCount) {
      console.log('[seed] demo tenant "charoen" already exists; use --reset to recreate');
      return;
    }
    const r = await seedDemo(pool);
    console.log(`[seed] tenant ${r.tenantId} (code charoen) with ${Object.keys(r.products).length} products, ${Object.keys(r.users).length} users`);
  })()
    .catch((err) => {
      console.error('[seed] failed:', err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
