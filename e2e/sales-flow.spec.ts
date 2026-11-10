/**
 * B2B round 2 (both editions): customer quick-create from the SO form, partial Thai search in the pickers, stock on
 * the SO line, below-cost red line + price / below-cost approvals, notes saved, and QT → SO → DO → INV with the
 * warehouse stock cut by the delivery order (API stock before / after).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiToken, approve, login } from './helpers';
import { pick } from './sales-helpers';

test.describe.configure({ mode: 'serial' });
const RUN = Date.now().toString(36).slice(-4);

async function docNo(page: Page, kind: string): Promise<string> {
  await expect(page).toHaveURL(new RegExp(`/b2b/${kind}/`));
  return (await page.getByTestId('doc-no').textContent())!.trim();
}

async function stockOf(request: APIRequestContext, sku: string, whName = 'โกดังหลังร้าน'): Promise<number> {
  const h = { authorization: `Bearer ${await apiToken(request, 'charoen')}` };
  const p = (await (await request.get(`/api/products?q=${sku}&limit=5`, { headers: h })).json()).items.find((x: { sku: string }) => x.sku === sku);
  const whs = (await (await request.get('/api/warehouses?limit=50', { headers: h })).json()).items as { id: string; name: string; isPos: boolean }[];
  const wh = whs.find((w) => w.name.includes(whName)) ?? whs.find((w) => !w.isPos)!;
  const r = await (await request.get(`/api/stock?productId=${p.id}&warehouseId=${wh.id}&limit=50`, { headers: h })).json();
  return r.items.reduce((a: number, x: { qty: string }) => a + Number(x.qty), 0);
}

test('SO form: quick-create a customer, partial Thai search, stock on the line, note saved', async ({ page }) => {
  await login(page, 'boy');
  await page.goto('/b2b');
  await page.getByTestId('new-so').click();
  // + สร้างลูกค้าใหม่ from the customer picker → saved to the customer master and selected
  const cust = page.getByTestId('doc-customer');
  await cust.locator('input').fill(`ร้านทดสอบ ${RUN}`);
  await page.getByTestId('doc-customer-create').click();
  await expect(page.getByTestId('quick-customer')).toBeVisible();
  await page.locator('[data-testid="quick-customer"] input[name="phone"]').fill('0812345678');
  await page.getByTestId('quick-customer-save').click();
  await expect(cust.locator('input')).toHaveValue(`ร้านทดสอบ ${RUN}`);
  // partial, word-segmented Thai search: "ปูนเสือ" finds "ปูนซีเมนต์ตราเสือ 50 กก."
  await pick(page.getByTestId('line-product-0'), 'ปูนซีเมนต์ตราเสือ', 'ปูนเสือ');
  await expect(page.getByTestId('line-price-0')).not.toHaveValue('');
  await expect(page.getByTestId('line-source-0')).toContainText('ราคาปลีก');
  await expect(page.getByTestId('line-stock-0')).toContainText('คงเหลือ');
  await page.getByTestId('line-qty-0').fill('99999');
  await expect(page.getByTestId('line-stock-0')).toHaveClass(/bad/);
  await page.getByTestId('line-qty-0').fill('2');
  await expect(page.getByTestId('line-stock-0')).not.toHaveClass(/bad/);
  await page.getByTestId('doc-note').fill(`ส่งก่อนเที่ยง ${RUN}`);
  await page.getByTestId('doc-save').click();
  await docNo(page, 'so');
  await expect(page.getByTestId('doc-note-view')).toHaveText(`ส่งก่อนเที่ยง ${RUN}`);
  await expect(page.getByTestId('paper').or(page.locator('body'))).toContainText(`ร้านทดสอบ ${RUN}`);
});

test('below cost: the line turns red, saving needs the manager (price) and the owner (below cost) PINs', async ({ page }) => {
  await login(page, 'boy');
  await page.goto('/b2b');
  await page.getByTestId('new-so').click();
  await pick(page.getByTestId('doc-customer'), 'บ้านนา');
  await pick(page.getByTestId('line-product-0'), 'SCG-CEM-T50');
  await expect(page.getByTestId('line-price-0')).not.toHaveValue('');
  await page.getByTestId('line-price-0').fill('10');
  await expect(page.getByTestId('line-below-0')).toHaveText('ต่ำกว่าทุน'); // sales role: no cost figure
  await expect(page.getByTestId('line-row-0')).toHaveClass(/line-below/);
  await page.getByTestId('doc-save').click();
  await expect(page.getByTestId('price-need')).toBeVisible();
  await page.getByTestId('apv-pin').fill('1234');
  await page.getByTestId('apv-ok').click();
  await expect(page.getByRole('alert')).toContainText('เหตุผล'); // reason is required
  await page.getByTestId('apv-reason').fill('ล้างสต็อกเก่า');
  await approve(page, 'คุณสุดา');
  await expect(page.getByTestId('below-need')).toBeVisible();
  await approve(page, 'คุณเจริญ');
  await docNo(page, 'so');
  await expect(page.getByTestId('price-approval')).toContainText('ล้างสต็อกเก่า');
  await expect(page.getByTestId('below-approval')).toContainText('คุณเจริญ');
});

test('owner sees cost and profit per line and for the document', async ({ page }) => {
  await login(page, 'charoen');
  await page.goto('/b2b');
  await page.getByTestId('new-qt').click();
  await pick(page.getByTestId('doc-customer'), 'รุ่งเรือง');
  await pick(page.getByTestId('line-product-0'), 'SCG-CEM-T50');
  await expect(page.getByTestId('line-price-0')).not.toHaveValue('');
  await expect(page.getByTestId('line-profit-0')).toContainText('ทุน');
  await expect(page.getByTestId('doc-profit')).toContainText('กำไร');
  await page.keyboard.press('Escape');
});

test('QT → SO → DO (partial) → INV: links both ways and the delivery cuts warehouse stock', async ({ page, request }) => {
  await login(page, 'boy');
  await page.goto('/b2b');
  await page.getByTestId('new-qt').click();
  await pick(page.getByTestId('doc-customer'), 'รุ่งเรือง');
  await pick(page.getByTestId('line-product-0'), 'SCG-CEM-T50');
  await expect(page.getByTestId('line-source-0')).toContainText('ราคาลูกค้า');
  await page.getByTestId('line-qty-0').fill('5');
  await page.getByTestId('doc-note').fill(`QT note ${RUN}`);
  await page.getByTestId('doc-save').click();
  const qt = await docNo(page, 'qt');
  await expect(page.getByTestId('doc-note-view')).toHaveText(`QT note ${RUN}`);

  await page.getByTestId('qt-convert').click();
  await expect(page.getByTestId('line-source-0')).toContainText(qt);
  await page.getByTestId('doc-save').click();
  const so = await docNo(page, 'so');
  await expect(page.getByRole('link', { name: qt }).first()).toBeVisible();
  await page.goto(`/b2b/qt/${qt}`);
  await expect(page.getByTestId('qt-orders')).toContainText(so);

  const before = await stockOf(request, 'SCG-CEM-T50');
  await page.goto(`/b2b/so/${so}`);
  await page.getByTestId('so-deliver').click();
  await page.getByTestId('dlv-qty-0').fill('3');
  await page.getByTestId('dlv-note').fill(`DO note ${RUN}`);
  await page.getByTestId('dlv-save').click();
  const do1 = await docNo(page, 'do');
  await expect(page.getByTestId('doc-note-view')).toHaveText(`DO note ${RUN}`);
  expect(await stockOf(request, 'SCG-CEM-T50')).toBe(before - 3);
  await page.getByTestId('do-invoice').click();
  await page.getByTestId('inv-note').fill(`INV note ${RUN}`);
  await page.getByTestId('inv-from-do-save').click();
  const inv = await docNo(page, 'inv');
  await expect(page.getByTestId('doc-note-view')).toHaveText(`INV note ${RUN}`);
  await expect(page.getByTestId('paper')).toContainText(do1);
  await page.goto(`/b2b/so/${so}`);
  await expect(page.getByText('ส่งบางส่วน').first()).toBeVisible();
  await expect(page.getByRole('link', { name: inv }).first()).toBeVisible();
});
