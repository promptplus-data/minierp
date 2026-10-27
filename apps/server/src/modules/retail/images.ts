/**
 * REQ-M07-11 product images for the shop's own (non-SCG) products, stored in the database (bytea, ≤ 256 KB,
 * PNG / JPEG / WebP checked by magic bytes). SCG products use the central master images and cannot be overridden.
 */
import type { Tx } from '@erp/db';
import { PRODUCT_IMAGE_MAX_BYTES } from '@erp/contracts';
import { writeAudit } from '../../lib/audit';
import { requirePerm, type Ctx } from '../../lib/context';
import { E, isUuid } from '../../lib/errors';
import { decodeCursor, pageOf } from '../../lib/paging';

type Mime = 'image/png' | 'image/jpeg' | 'image/webp';

/** Detects the real format from the first bytes; the declared mime must match. */
export function sniffImage(b: Buffer): Mime | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

async function ownProduct(tx: Tx, productId: string): Promise<{ id: string; sku: string; is_scg: boolean }> {
  if (!isUuid(productId)) throw E.notFound('Product not found');
  const p = (await tx.query<{ id: string; sku: string; is_scg: boolean }>(`select id, sku, is_scg from products where id = $1`, [productId])).rows[0];
  if (!p) throw E.notFound('Product not found');
  return p;
}

export async function putImage(tx: Tx, ctx: Ctx, productId: string, body: { mime: Mime; data: string }) {
  requirePerm(ctx, 'data.master');
  const p = await ownProduct(tx, productId);
  if (p.is_scg) throw E.validation('SCG products use the image from the SCG master and cannot be changed');
  const raw = body.data.replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw E.validation('Image data must be base64');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw E.validation('Empty image');
  if (buf.length > PRODUCT_IMAGE_MAX_BYTES) throw E.validation(`Image is larger than ${PRODUCT_IMAGE_MAX_BYTES / 1024} KB; resize it first`, { max: PRODUCT_IMAGE_MAX_BYTES, bytes: buf.length });
  const real = sniffImage(buf);
  if (!real || real !== body.mime) throw E.validation('File is not a PNG, JPEG or WebP image (or the type does not match)');
  const r = await tx.query<{ version: number }>(
    `insert into retail_product_images (product_id, tenant_id, mime, data, bytes, updated_by) values ($1,$2,$3,$4,$5,$6)
     on conflict (product_id) do update set mime = excluded.mime, data = excluded.data, bytes = excluded.bytes, updated_by = excluded.updated_by,
       updated_at = now(), version = retail_product_images.version + 1
     returning version`,
    [p.id, ctx.tenantId, real, buf, buf.length, ctx.userId],
  );
  await writeAudit(tx, ctx, [{ action: 'update', object: 'product-image', ref: p.sku, detail: `${real} · ${Math.ceil(buf.length / 1024)} KB` }]);
  return { productId: p.id, mime: real, version: r.rows[0]!.version, bytes: buf.length };
}

export async function removeImage(tx: Tx, ctx: Ctx, productId: string) {
  requirePerm(ctx, 'data.master');
  const p = await ownProduct(tx, productId);
  const r = await tx.query(`update retail_product_images set data = null, bytes = 0, version = version + 1, updated_by = $2, updated_at = now() where product_id = $1 and data is not null`, [p.id, ctx.userId]);
  if (!r.rowCount) throw E.notFound('This product has no image');
  await writeAudit(tx, ctx, [{ action: 'remove', object: 'product-image', ref: p.sku, detail: 'ลบรูปสินค้า' }]);
  return { ok: true };
}

export async function getImage(tx: Tx, productId: string) {
  if (!isUuid(productId)) throw E.notFound('Image not found');
  const r = await tx.query<{ product_id: string; mime: Mime; version: number; bytes: number; data: Buffer | null }>(
    `select product_id, mime, version, bytes, data from retail_product_images where product_id = $1`, [productId]);
  const x = r.rows[0];
  if (!x?.data) throw E.notFound('Image not found');
  return { productId: x.product_id, mime: x.mime, version: x.version, bytes: x.bytes, data: x.data.toString('base64') };
}

export async function listImages(tx: Tx, q: { limit: number; cursor?: string }) {
  const cur = decodeCursor(q.cursor, 1);
  const r = await tx.query<{ product_id: string; mime: Mime; version: number; bytes: number }>(
    `select product_id, mime, version, bytes from retail_product_images where data is not null ${cur ? 'and product_id > $2::uuid' : ''} order by product_id limit $1`,
    cur ? [q.limit + 1, cur[0]] : [q.limit + 1],
  );
  return pageOf(r.rows, q.limit, (x) => [x.product_id], (x) => ({ productId: x.product_id, mime: x.mime, version: x.version, bytes: x.bytes }));
}
