/**
 * Demo data for module group C (retail), on top of the mockup tenant from ./seed.ts (docs/mockup.html seeds):
 *   promotions PR000 (สีรองพื้น ลด 10%, ended in September), PR001 (ปูนตราเสือ ลด 5 บาท/ถุง) and the bundle
 *   PR002 (ชุดก่อผนัง: อิฐมวลเบา 100 ก้อน + ปูนตราเสือ 2 ถุง ฿2,550); BOM v1 of the two made-to-stock products;
 *   a contractor-group price list and one customer price list; POS machines POS-01 (POS ID approved) and POS-02 (pending).
 * Idempotent: running it twice adds nothing. Runs inside the tenant's RLS scope (`withTenant`) or as superuser.
 *
 * Note: registering POS machines switches on the REQ-M01-07 rule (ABB only on an approved machine), so callers that
 * sell ABB bills must open their shift on POS-01.
 */
import type pg from 'pg';
import { DEFAULT_DOC_PATTERN, docPeriodKey, formatDocNo } from '@erp/core';

type Q = Pick<pg.PoolClient, 'query'>;

export interface RetailSeed {
  promos: Record<'PR000' | 'PR001' | 'PR002', string>;
  boms: Record<string, string>;
  priceLists: Record<'contr' | 'c2', string>;
  devices: Record<'POS-01' | 'POS-02', string>;
}

async function ids(c: Q, sql: string, key: string, params: unknown[]): Promise<Record<string, string>> {
  const r = await c.query<{ k: string; id: string }>(sql, params);
  return Object.fromEntries(r.rows.map((x) => [x[key as 'k'], x.id]));
}

/** Next number of a document type, kept in step with doc_counters (BR-04) so later API numbering continues after it. */
async function code(c: Q, tenantId: string, type: string, date: string, seq: number): Promise<string> {
  const pattern = DEFAULT_DOC_PATTERN;
  await c.query(
    `insert into doc_counters (tenant_id, type, period, device, seq) values ($1,$2,$3,'',$4)
     on conflict (tenant_id, type, period, device) do update set seq = greatest(doc_counters.seq, excluded.seq)`,
    [tenantId, type, docPeriodKey(pattern, date), seq],
  );
  return formatDocNo(pattern, { type, date, seq });
}

export async function seedRetail(c: Q, tenantId: string): Promise<RetailSeed> {
  const users = await ids(c, `select username k, id from users where tenant_id = $1`, 'k', [tenantId]);
  const products = await ids(c, `select sku k, id from products where tenant_id = $1`, 'k', [tenantId]);
  const customers = await ids(c, `select code k, id from customers where tenant_id = $1`, 'k', [tenantId]);
  const owner = users.charoen ?? Object.values(users)[0]!;
  const manager = users.suda ?? owner;
  const P = (sku: string) => {
    const id = products[sku];
    if (!id) throw new Error(`seedRetail: product ${sku} is missing (run seedDemo first)`);
    return id;
  };

  // ---------- M15 promotions ----------
  const promoDefs = [
    { key: 'PR000' as const, date: '2026-08-30', seq: 1, by: manager, name: 'สีรองพื้น ลด 10%', kind: 'disc', mode: 'pct', value: '10', setPrice: null, sku: null,
      items: [{ productId: P('PNT-PR9') }], start: '2026-09-01', end: '2026-09-30' },
    { key: 'PR001' as const, date: '2026-10-14', seq: 1, by: owner, name: 'ปูนตราเสือ ลด 5 บาท/ถุง ต้อนรับหน้าแล้ง', kind: 'disc', mode: 'amt', value: '5', setPrice: null, sku: null,
      items: [{ productId: P('SCG-CEM-T50') }], start: '2026-10-15', end: '2026-11-15' },
    { key: 'PR002' as const, date: '2026-10-21', seq: 2, by: owner, name: 'ชุดก่อผนัง: อิฐมวลเบา 100 ก้อน + ปูนตราเสือ 2 ถุง', kind: 'bundle', mode: null, value: null, setPrice: '2550.00', sku: 'BD-WALL100',
      items: [{ productId: P('SCG-AAC-75'), qtyPerSet: '100.0000' }, { productId: P('SCG-CEM-T50'), qtyPerSet: '2.0000' }], start: '2026-10-21', end: '2026-12-31' },
  ];
  const promos = {} as RetailSeed['promos'];
  for (const p of promoDefs) {
    const existing = await c.query<{ id: string }>(`select id from retail_promos where tenant_id = $1 and name = $2`, [tenantId, p.name]);
    if (existing.rows[0]) {
      promos[p.key] = existing.rows[0].id;
      continue;
    }
    const no = await code(c, tenantId, 'PR', p.date, p.seq);
    const r = await c.query<{ id: string }>(
      `insert into retail_promos (tenant_id, code, name, kind, mode, value, set_price, sku, items, channels, start_date, end_date, status, created_by, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{pos}',$10,$11,'active',$12,$13) returning id`,
      [tenantId, no, p.name, p.kind, p.mode, p.value, p.setPrice, p.sku, JSON.stringify(p.items), p.start, p.end, p.by, `${p.date}T09:00:00+07:00`],
    );
    promos[p.key] = r.rows[0]!.id;
  }

  // ---------- M16 BOM v1 (mockup p11 / p12 recipes, per 1 unit) ----------
  const bomDefs = [
    { sku: 'MK-POST-15', labour: '25', comps: [['SCG-CEM-T50', '0.5'], ['SAND-C', '0.04'], ['STONE-34', '0.06'], ['RB9-10', '1.2']] },
    { sku: 'MK-RING-80', labour: '20', comps: [['SCG-CEM-T50', '0.6'], ['SAND-C', '0.05'], ['STONE-34', '0.07'], ['RB9-10', '0.6']] },
  ] as const;
  const boms: Record<string, string> = {};
  for (const b of bomDefs) {
    const pid = P(b.sku);
    const existing = await c.query<{ id: string }>(`select id from retail_boms where tenant_id = $1 and product_id = $2 and version = 1`, [tenantId, pid]);
    if (existing.rows[0]) {
      boms[b.sku] = existing.rows[0].id;
      continue;
    }
    const comps = b.comps.map(([sku, q]) => ({ productId: P(sku), qtyPerUnit: Number(q).toFixed(4) }));
    const r = await c.query<{ id: string }>(
      `insert into retail_boms (tenant_id, product_id, version, components, labour_per_unit, overhead_per_unit, note, active, created_by, created_at)
       values ($1,$2,1,$3,$4,0,'สูตรตั้งต้น',true,$5,'2026-10-01T08:00:00+07:00') returning id`,
      [tenantId, pid, JSON.stringify(comps), b.labour, owner],
    );
    boms[b.sku] = r.rows[0]!.id;
  }

  // ---------- BR-05 price lists ----------
  const listDefs = [
    { key: 'contr' as const, name: 'ราคาผู้รับเหมา 2569', customerId: null, group: 'contr', vatIncluded: true, from: '2026-10-01', to: '2026-12-31',
      items: [['SCG-CEM-T50', 0, '10', '140.00'], ['SCG-CEM-T50', 0, '40', '138.00'], ['SCG-AAC-75', 0, '100', '22.50'], ['SCG-CEM-T50', 1, '1', '5500.00']] },
    { key: 'c2' as const, name: 'ราคาพิเศษ ร้านวัสดุบ้านนา', customerId: customers.C00002 ?? null, group: null, vatIncluded: true, from: null, to: null,
      items: [['SCG-ROOF-LK', 0, '0', '49.00'], ['PVC-4-85', 0, '0', '84.00']] },
  ] as const;
  const priceLists = {} as RetailSeed['priceLists'];
  for (const l of listDefs) {
    if (l.key === 'c2' && !l.customerId) continue;
    const existing = await c.query<{ id: string }>(`select id from retail_price_lists where tenant_id = $1 and name = $2`, [tenantId, l.name]);
    let id = existing.rows[0]?.id;
    if (!id) {
      id = (await c.query<{ id: string }>(
        `insert into retail_price_lists (tenant_id, name, customer_id, customer_group, vat_included, valid_from, valid_to, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [tenantId, l.name, l.customerId, l.group, l.vatIncluded, l.from, l.to, owner],
      )).rows[0]!.id;
      for (const [sku, unitIdx, minQty, price] of l.items) {
        await c.query(
          `insert into retail_price_list_items (tenant_id, list_id, product_id, unit_idx, min_qty, price) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
          [tenantId, id, P(sku), unitIdx, minQty, price],
        );
      }
    }
    priceLists[l.key] = id;
  }

  // ---------- REQ-M01-07 POS machines (mockup posDevices) ----------
  const devDefs = [
    { code: 'POS-01' as const, name: 'แท็บเล็ตแคชเชียร์ 1', rd: 'E061234567890123', approvedOn: '2026-01-15', status: 'approved' },
    { code: 'POS-02' as const, name: 'แท็บเล็ตหน้าโกดัง', rd: null, approvedOn: null, status: 'pending' },
  ];
  const devices = {} as RetailSeed['devices'];
  for (const dv of devDefs) {
    const r = await c.query<{ id: string }>(
      `insert into retail_pos_devices (tenant_id, code, name, rd_pos_id, approved_on, status, created_by) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (tenant_id, code) do update set code = excluded.code returning id`,
      [tenantId, dv.code, dv.name, dv.rd, dv.approvedOn, dv.status, owner],
    );
    devices[dv.code] = r.rows[0]!.id;
  }

  return { promos, boms, priceLists, devices };
}
