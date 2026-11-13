/**
 * REQ-M19-10 (on-prem): the owner presses "ส่งสรุปยอดขายให้ SCG" for a date range. Only daily quantity + value per SCG
 * product and one total for all other products leave the shop: no customer, user, price-list or document data.
 * Nothing is sent automatically (OQ-17). The destination is SCG_SHARE_URL; the shop's signed license key
 * identifies it to SCG. Every attempt (sent or failed) is stored and audited.
 */
import type { Tx } from '@erp/db';
import type { SharePayload } from '@erp/contracts';
import { d, money, sum } from '@erp/core';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx } from '../../lib/context';
import { E } from '../../lib/errors';
import { decodeCursor, pageOf } from '../../lib/paging';
import { currentLicense } from './license';

export const MAX_SHARE_DAYS = 92;
export const shareUrl = (env: NodeJS.ProcessEnv = process.env): string | null => env.SCG_SHARE_URL?.trim() || null;

function checkRange(from: string, to: string, today: string) {
  if (to < from) throw E.validation('The end date is before the start date');
  if (to > today) throw E.validation('The range cannot include future dates');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_SHARE_DAYS) throw E.validation(`At most ${MAX_SHARE_DAYS} days per send`);
}

export async function shareConfig(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'sys.settings');
  const lic = await currentLicense(tx, 'onprem');
  return { receiverUrl: shareUrl(), licensed: !!lic, licenseId: lic?.payload.licenseId ?? null };
}

/** Builds exactly what would be sent (also the preview). */
export async function buildSharePayload(tx: Tx, ctx: Ctx, from: string, to: string, today: string): Promise<SharePayload> {
  requirePerm(ctx, 'sys.settings');
  checkRange(from, to, today);
  const shop = (await tx.query<{ name: string; tax_id: string }>(`select name, tax_id from tenants where id = $1`, [ctx.tenantId])).rows[0]!;
  // Sales bills add, credit notes subtract; void documents never count. Quantities in the product's base unit.
  const rows = (await tx.query<{ date: string; scg: boolean; sku: string; name: string; unit: string; qty: string; amount: string }>(
    `select dc.date, p.is_scg scg, p.sku, p.name, p.units->0->>'name' unit,
            sum(case when dc.type = 'CN' then -l.base_qty else l.base_qty end)::text qty,
            sum(case when dc.type = 'CN' then -l.net_after_bill else l.net_after_bill end)::text amount
       from doc_lines l join docs dc on dc.id = l.doc_id join products p on p.id = l.product_id
      where dc.status = 'active' and dc.type in ('ABB','INV','RC','CN') and dc.date between $1 and $2
      group by dc.date, p.is_scg, p.sku, p.name, p.units->0->>'name'
      order by dc.date, p.sku`, [from, to])).rows;
  const dates = [...new Set(rows.map((r) => r.date))];
  const days = dates.map((date) => {
    const mine = rows.filter((r) => r.date === date);
    const scg = mine.filter((r) => r.scg).map((r) => ({ sku: r.sku, name: r.name, unit: r.unit ?? '', qty: d(r.qty).toString(), amount: money(r.amount) }));
    const otherAmount = money(sum(mine.filter((r) => !r.scg).map((r) => r.amount)));
    return { date, scg, otherAmount, total: money(sum([...scg.map((s) => s.amount), otherAmount])) };
  });
  const scgQty = sum(days.flatMap((x) => x.scg.map((s) => s.qty))).toString();
  const scgAmount = money(sum(days.flatMap((x) => x.scg.map((s) => s.amount))));
  const otherAmount = money(sum(days.map((x) => x.otherAmount)));
  return {
    v: 1, shop: { name: shop.name, taxId: shop.tax_id }, from, to, days,
    totals: { scgQty, scgAmount, otherAmount, total: money(d(scgAmount).plus(otherAmount)) },
  };
}

export type Sender = (url: string, body: unknown) => Promise<{ receiptId: string }>;

/** Default sender: HTTPS POST with a 15 s timeout. */
export const httpSender: Sender = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`SCG answered ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text) as { receiptId?: string };
  if (!j.receiptId) throw new Error('SCG did not return a receipt id');
  return { receiptId: j.receiptId };
};

export async function sendShare(tx: Tx, ctx: Ctx, from: string, to: string, today: string, sender: Sender) {
  if (ctx.role !== 'owner') throw E.forbidden('Only the shop owner can send the sales summary', { reason: 'OWNER_ONLY' });
  const url = shareUrl();
  if (!url) throw E.validation('SCG_SHARE_URL is not configured on this machine', { reason: 'SHARE_URL_MISSING' });
  const lic = await currentLicense(tx, 'onprem');
  if (!lic) throw E.validation('A license key is needed to identify the shop to SCG', { reason: 'LICENSE_REQUIRED' });
  const payload = await buildSharePayload(tx, ctx, from, to, today);
  let status: 'sent' | 'failed' = 'sent';
  let error: string | null = null;
  let receiptId: string | null = null;
  try {
    receiptId = (await sender(url, { key: (await tx.query<{ k: string }>(`select license_key k from licenses order by installed_at desc, id desc limit 1`)).rows[0]!.k, payload })).receiptId;
  } catch (err) {
    status = 'failed';
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }
  const r = await tx.query<{ id: string; sent_at: Date }>(
    `insert into sales_shares (tenant_id, from_date, to_date, payload, status, error, receipt_id, sent_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, sent_at`,
    [ctx.tenantId, from, to, JSON.stringify(payload), status, error, receiptId, ctx.userId]);
  await writeAudit(tx, ctx, [{
    action: status === 'sent' ? 'share' : 'share-failed', object: 'sales-summary', ref: `${from}..${to}`,
    detail: `ส่งสรุปยอดขายให้ SCG ${payload.days.length} วัน · สินค้า SCG ${payload.totals.scgAmount} · อื่น ๆ ${payload.totals.otherAmount}${error ? ` · ล้มเหลว: ${error}` : ` · เลขรับ ${receiptId}`}`,
  }]);
  return { id: r.rows[0]!.id, from, to, status, error, receiptId, sentAt: r.rows[0]!.sent_at.toISOString(), sentBy: ctx.name, total: payload.totals.total };
}

export async function shareHistory(tx: Tx, ctx: Ctx, q: { limit: number; cursor?: string }) {
  requirePerm(ctx, 'sys.settings');
  const cur = decodeCursor(q.cursor, 2);
  const r = await tx.query<{ id: string; from_date: string; to_date: string; status: 'sent' | 'failed'; error: string | null; receipt_id: string | null; sent_at: Date; name: string; total: string }>(
    `select s.id, s.from_date, s.to_date, s.status, s.error, s.receipt_id, s.sent_at, u.name, (s.payload->'totals'->>'total') total
       from sales_shares s join users u on u.id = s.sent_by ${cur ? 'where (s.sent_at, s.id) < ($2::timestamptz, $3::uuid)' : ''}
      order by s.sent_at desc, s.id desc limit $1`, cur ? [q.limit + 1, cur[0], cur[1]] : [q.limit + 1]);
  return pageOf(r.rows, q.limit, (x) => [x.sent_at.toISOString(), x.id], (x) => ({
    id: x.id, from: x.from_date, to: x.to_date, status: x.status, error: x.error, receiptId: x.receipt_id, sentAt: x.sent_at.toISOString(), sentBy: x.name, total: money(x.total),
  }));
}
