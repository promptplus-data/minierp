/**
 * Demo data for the "sales" module group on top of seedDemo(): shop B2B settings (bank accounts, quotation validity,
 * default credit limit), a customer price list for หจก. รุ่งเรืองก่อสร้าง, a wholesale group price list with quantity
 * breaks, and a sent quotation to ร้านวัสดุบ้านนา with a free-text ("นอกระบบ") line.
 * Idempotent: running it again on the same tenant changes nothing. Runs as any client inside the tenant scope
 * (withTenant) or as the superuser; every row carries tenant_id explicitly.
 */
import type pg from 'pg';
import { DEFAULT_DOC_PATTERN, calcDoc, docPeriodKey, formatDocNo, money, type DocLine } from '@erp/core';

type Q = Pick<pg.PoolClient, 'query'>;

export interface SalesSeedResult { priceLists: Record<string, string>; quotes: Record<string, string> }

async function nextNo(c: Q, tenantId: string, type: string, date: string): Promise<string> {
  const t = await c.query<{ doc_patterns: Record<string, string> }>(`select doc_patterns from tenants where id = $1`, [tenantId]);
  const pattern = t.rows[0]?.doc_patterns?.[type] ?? DEFAULT_DOC_PATTERN;
  const r = await c.query<{ seq: number }>(
    `insert into doc_counters (tenant_id, type, period, device, seq) values ($1,$2,$3,'',1)
     on conflict (tenant_id, type, period, device) do update set seq = doc_counters.seq + 1 returning seq`,
    [tenantId, type, docPeriodKey(pattern, date)],
  );
  return formatDocNo(pattern, { type, date, seq: r.rows[0]!.seq });
}

export async function seedSales(c: Q, tenantId: string, opts: { today?: string } = {}): Promise<SalesSeedResult> {
  const today = opts.today ?? '2026-10-26';
  const out: SalesSeedResult = { priceLists: {}, quotes: {} };
  const ids = async (table: string, key: string, vals: string[]) => {
    const r = await c.query<{ id: string; k: string }>(`select id, ${key} k from ${table} where tenant_id = $1 and ${key} = any($2::text[])`, [tenantId, vals]);
    return new Map(r.rows.map((x) => [x.k, x.id]));
  };
  const prod = await ids('products', 'sku', ['SCG-CEM-T50', 'SCG-ROOF-LK', 'SCG-AAC-75', 'SCG-TA-20', 'RB9-10', 'PVC-4-85', 'SV-DLV']);
  const cust = await ids('customers', 'code', ['C00001', 'C00002']);
  const owner = (await c.query<{ id: string }>(`select id from users where tenant_id = $1 and role = 'owner' order by created_at limit 1`, [tenantId])).rows[0]?.id;
  const sales = (await c.query<{ id: string }>(`select id from users where tenant_id = $1 and role = 'sales' and status = 'active' order by created_at limit 1`, [tenantId])).rows[0]?.id ?? owner;
  if (!owner || !prod.size || !cust.size) return out; // not the demo tenant

  await c.query(
    `insert into sales_settings (tenant_id, quote_valid_days, default_credit_limit, bank_accounts) values ($1, 15, 50000, $2) on conflict (tenant_id) do nothing`,
    [tenantId, JSON.stringify([
      { bank: 'ธนาคารกสิกรไทย', branch: 'สาขาท่าศาลา เชียงใหม่', account: '123-4-56789-0', name: 'ร้านวัสดุเจริญชัย' },
      { bank: 'ธนาคารกรุงเทพ', branch: 'สาขาเชียงใหม่', account: '456-7-01234-5', name: 'ร้านวัสดุเจริญชัย' },
    ])],
  );

  const lists = [
    {
      code: 'PL-C00001', name: 'ราคาพิเศษ หจก. รุ่งเรืองก่อสร้าง', kind: 'customer', customer: cust.get('C00001') ?? null, grp: null,
      items: [{ sku: 'SCG-CEM-T50', unitIdx: 0, minQty: '0', price: '138' }, { sku: 'SCG-CEM-T50', unitIdx: 1, minQty: '0', price: '5440' }, { sku: 'RB9-10', unitIdx: 0, minQty: '0', price: '158' }],
    },
    {
      code: 'PL-WHOLE', name: 'ราคาขายส่ง (ร้านค้าส่ง)', kind: 'group', customer: null, grp: 'whole',
      items: [
        { sku: 'SCG-CEM-T50', unitIdx: 0, minQty: '0', price: '140' }, { sku: 'SCG-CEM-T50', unitIdx: 0, minQty: '100', price: '136' },
        { sku: 'SCG-ROOF-LK', unitIdx: 0, minQty: '0', price: '49' }, { sku: 'SCG-ROOF-LK', unitIdx: 0, minQty: '500', price: '47' },
        { sku: 'PVC-4-85', unitIdx: 0, minQty: '0', price: '84' }, { sku: 'PVC-4-85', unitIdx: 0, minQty: '100', price: '80' },
      ],
    },
  ];
  for (const l of lists) {
    const have = await c.query<{ id: string }>(`select id from sales_price_lists where tenant_id = $1 and code = $2`, [tenantId, l.code]);
    if (have.rows[0]) {
      out.priceLists[l.code] = have.rows[0].id;
      continue;
    }
    const items = l.items.filter((i) => prod.has(i.sku)).map((i) => ({ productId: prod.get(i.sku)!, unitIdx: i.unitIdx, minQty: i.minQty, price: money(i.price) }));
    const r = await c.query<{ id: string }>(
      `insert into sales_price_lists (tenant_id, code, name, kind, customer_id, grp, vat_included, items, created_by, search_text)
       values ($1,$2,$3,$4,$5,$6,true,$7,$8,$9) returning id`,
      [tenantId, l.code, l.name, l.kind, l.customer, l.grp, JSON.stringify(items), owner, `${l.code} ${l.name}`.toLowerCase()],
    );
    out.priceLists[l.code] = r.rows[0]!.id;
  }

  // A sent quotation (exc VAT) with a free-text line that must be mapped before it becomes a sales order.
  const marker = 'seed:qt-bannaa';
  const qt = await c.query<{ no: string }>(`select no from sales_quotes where tenant_id = $1 and note like $2`, [tenantId, `%${marker}%`]);
  if (qt.rows[0]) out.quotes.bannaa = qt.rows[0].no;
  else if (cust.get('C00002')) {
    const lines: (DocLine & { productId: string | null; unitIdx: number | null; name: string; unitName: string })[] = [
      { productId: prod.get('SCG-CEM-T50')!, unitIdx: 0, name: 'ปูนซีเมนต์ตราเสือ 50 กก.', unitName: 'ถุง', qty: '100', unitPrice: '127.10', vat: 'v7' },
      { productId: prod.get('SCG-ROOF-LK')!, unitIdx: 0, name: 'กระเบื้องหลังคาลอนคู่ 50×120 ซม. สีเทา', unitName: 'แผ่น', qty: '300', unitPrice: '45.79', vat: 'v7' },
      { productId: null, unitIdx: null, name: 'ประตูไม้สักบานคู่ 160×200 ซม.', unitName: 'ชุด', qty: '1', unitPrice: '8500', vat: 'v7' },
    ];
    const t = calcDoc(lines, 'exc');
    const no = await nextNo(c, tenantId, 'QT', today);
    const valid = new Date(Date.parse(today + 'T00:00:00Z') + 15 * 86_400_000).toISOString().slice(0, 10);
    const qid = (await c.query<{ id: string }>(
      `insert into sales_quotes (tenant_id, no, date, valid_until, customer_id, attn, vat_mode, term, salesperson_id, note, bill_disc, gross, line_disc, base7, exempt, vat, total, status, created_by, search_text)
       values ($1,$2,$3,$4,$5,'คุณวิชัย (เจ้าของร้าน)','exc','{"t":"eom"}',$6,$7,0,$8,$9,$10,$11,$12,$13,'sent',$6,$14) returning id`,
      [tenantId, no, today, valid, cust.get('C00002'), sales, `ราคานี้รวมค่าขนส่งในเขตอำเภอ · ส่งภายใน 3 วันหลังยืนยัน (${marker})`, t.gross, t.lineDisc, t.base7, t.exempt, t.vat, t.total,
        `${no} ร้านวัสดุบ้านนา ${lines.map((l) => l.name).join(' ')} ${t.total}`.toLowerCase()],
    )).rows[0]!.id;
    for (const [i, l] of lines.entries()) {
      await c.query(
        `insert into sales_quote_lines (tenant_id, quote_id, revision, line_no, product_id, unit_idx, name, unit_name, unit_factor, qty, unit_price, discount, disc_amt, net, vat)
         values ($1,$2,1,$3,$4,$5,$6,$7,1,$8,$9,null,0,$10,$11)`,
        [tenantId, qid, i + 1, l.productId, l.unitIdx, l.name, l.unitName, l.qty, l.unitPrice, t.lines[i]!.net, l.vat],
      );
    }
    await c.query(`insert into sales_quote_revisions (tenant_id, quote_id, revision, snapshot, created_by) values ($1,$2,1,$3,$4)`, [tenantId, qid, JSON.stringify({ seed: true, totals: t }), sales]);
    out.quotes.bannaa = no;
  }
  return out;
}
