/**
 * Group B (purchasing) browser flows on a freshly seeded shop, both editions: delivery-file import → draft → map →
 * confirm (stock + AP), BR-10 banner, payment voucher with WHT, vendor return, stock count → approval request,
 * Import Hub dry run + commit, ledger. Screenshots at 1300 / 390 px into e2e/screenshots/purchasing-*.png.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITION, PP, apiToken, login, logout, pick } from './helpers';

const DIR = path.join(__dirname, 'screenshots');
const SAMPLE = path.join(__dirname, '..', 'docs', 'integrations', 'samples', 'delivery-sample.csv');

async function noHorizontalScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
}
async function shot(page: Page, name: string, w: number, fullPage = true) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.waitForTimeout(400); // the nav drawer slides out after a viewport change
  await page.screenshot({ path: path.join(DIR, `purchasing-${EDITION}-${name}-${w}.png`), fullPage });
}
/** Ages the draft receipts by `days` (no UI can do that); skipped when psql is not available. */
function ageDrafts(days: number): boolean {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const r = spawnSync('psql', [url, '-c', `update gr_drafts set received_on = received_on - ${days} where status = 'draft'`], { encoding: 'utf8' });
  return r.status === 0;
}

test.describe.serial('purchasing', () => {
  test('delivery file → drafts → map → confirm creates stock and the AP bill', async ({ page }) => {
    await login(page, 'chai');
    await page.goto('/purchasing');
    await page.getByTestId('btn-delivery-import').click();
    await page.getByTestId('dl-file').setInputFiles(SAMPLE);
    await expect(page.getByTestId('dl-group')).toHaveCount(3);
    await expect(page.getByTestId('dl-rows').locator('tbody tr')).toHaveCount(6);
    await expect(page.getByRole('dialog').getByText(PP)).toHaveCount(0); // no Prompt Plus wording in this feature (both editions)
    await page.getByTestId('dl-commit').click();
    // the first draft opens: DN 8100234561 with two unmapped codes
    await expect(page.getByRole('dialog', { name: 'ตรวจรับของ' })).toBeVisible();
    await expect(page.getByTestId('draft-confirm')).toBeDisabled();
    await pick(page, 'draft-p-SCG-ROOF-DL-GY', 'กระเบื้องหลังคาลอนคู่ 50×120 ซม. สีเทา', 'SCG-ROOF-LK');
    await page.getByTestId('draft-new-SCG-RIDGE-C').click();
    await page.getByTestId('np-save').click();
    await expect(page.getByTestId('draft-confirm')).toBeEnabled();
    await page.getByTestId('draft-inv').fill('IV-E2E-8812');
    await page.getByTestId('draft-confirm').click();
    await expect(page.getByText(/รับเข้าสต็อก GR\d{4}-\d{4} แล้ว · ตั้งเจ้าหนี้ AP\d{4}-\d{4}/)).toBeVisible();
    await expect(page.getByTestId('receipt-table')).toContainText('8100234561');
    await expect(page.getByTestId('draft-table').locator('tbody tr')).toHaveCount(2);
  });

  test('BR-10 banner after 2 days and the screens at 1300 / 390 px', async ({ page }) => {
    const aged = ageDrafts(3);
    for (const w of [1300, 390]) {
      await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
      await login(page, 'charoen');
      await page.goto('/purchasing');
      await expect(page.getByTestId('draft-table').locator('tbody tr').first()).toBeVisible();
      if (aged) await expect(page.getByTestId('gr-alert')).toContainText('ของรอยืนยันรับเกิน 2 วัน 2 ใบ');
      await noHorizontalScroll(page);
      await shot(page, 'receiving', w);
      await page.getByTestId('draft-open-8100234577').click();
      await expect(page.getByTestId('draft-lines')).toBeVisible();
      await shot(page, 'draft', w, false);
      await page.keyboard.press('Escape');
      await page.goto('/stock-ledger');
      await expect(page.getByTestId('ledger-table').locator('tbody tr').first()).toContainText(/GR\d{4}/);
      if (aged) await expect(page.getByTestId('gr-alert')).toBeVisible();
      await noHorizontalScroll(page);
      await shot(page, 'ledger', w);
      await logout(page);
    }
  });

  test('payment voucher for the dealer with WHT, then a vendor return reduces AP', async ({ page }) => {
    await login(page, 'suda');
    await page.goto('/ap');
    await expect(page.getByTestId('ap-bills')).toContainText('IV-E2E-8812');
    for (const w of [390, 1300]) { // outstanding bills on screen, before they are paid
      await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
      await expect(page.getByTestId('ap-bills')).toContainText('IV-E2E-8812');
      await noHorizontalScroll(page);
      await shot(page, 'ap', w);
    }
    await page.getByTestId('pay-หจก. ทวีพัฒนาวัสดุ (ผู้แทนจำหน่าย)').click();
    await page.getByTestId('pay-wht').selectOption('3');
    await page.getByTestId('pay-save').click();
    await expect(page.getByText(/บันทึกจ่าย PV\d{4}-\d{4}/)).toBeVisible();
    await expect(page.getByTestId('ap-payments').locator('tbody tr', { hasText: 'หจก. ทวีพัฒนาวัสดุ' })).toHaveCount(1); // other specs may have paid other vendors
    await page.getByTestId('btn-new-return').click();
    await page.getByTestId('ret-grs').getByRole('button', { name: 'เลือก' }).first().click();
    await page.getByLabel('คืน ปูนซีเมนต์ตราเสือ 50 กก.').fill('2');
    await page.getByTestId('ret-cn').fill('CN-E2E-1');
    await page.getByTestId('ret-save').click();
    await expect(page.getByText(/บันทึกส่งคืน PR\d{4}-\d{4}/)).toBeVisible();
    await expect(page.getByTestId('ap-returns')).toContainText('CN-E2E-1');
  });

  test('stock count hides the system quantity and sends the variance for approval', async ({ page }) => {
    await login(page, 'chai');
    await page.goto('/stock-count');
    await page.getByTestId('btn-open-count').click();
    await page.getByTestId('count-start').click();
    await expect(page.getByTestId('count-sheet')).toBeVisible();
    await expect(page.getByTestId('count-sheet')).not.toContainText('ตามระบบ');
    await page.getByTestId('count-scan').fill('8850001000014');
    await page.getByTestId('count-scan').press('Enter');
    await expect(page.getByText('ปูนซีเมนต์ตราเสือ 50 กก. นับได้ 1')).toBeVisible();
    for (const w of [1300, 390]) {
      await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
      await noHorizontalScroll(page);
      await shot(page, 'count', w);
    }
    await page.setViewportSize({ width: 1300, height: 900 });
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId('count-submit').click();
    await expect(page.getByText(/ส่งผลต่างแล้ว RQ\d{4}-\d{4} รออนุมัติ/)).toBeVisible();
    await logout(page);
    await login(page, 'suda');
    await page.goto('/stock');
    await expect(page.getByTestId('adjust-table')).toContainText('ผลนับสต็อก');
  });

  test('Import Hub: dry run shows row status, commit imports the valid rows', async ({ page }) => {
    await login(page, 'suda');
    await page.goto('/import');
    await page.getByTestId('imp-kind').selectOption('products');
    const csv = '﻿รหัสสินค้า,ชื่อสินค้า,หน่วยหลัก,ราคาขาย\nW-112,ลวดผูกเหล็ก 1 กก.,ม้วน,65\nP-220,ก๊อกน้ำ สนาม,ตัว,\n';
    await page.getByTestId('imp-file').setInputFiles({ name: 'products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByTestId('imp-next1').click();
    await page.getByTestId('imp-next2').click();
    await expect(page.getByTestId('imp-rows').locator('tbody tr')).toHaveCount(2);
    await expect(page.getByTestId('imp-rows')).toContainText('ไม่มีราคาขาย');
    for (const w of [1300, 390]) {
      await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
      await noHorizontalScroll(page);
      await shot(page, 'import', w);
    }
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.getByTestId('imp-commit').click();
    await expect(page.getByTestId('imp-done')).toContainText('สร้าง 1');
    await expect(page.getByTestId('imp-history')).toContainText('products.csv');
    expect(readFileSync(SAMPLE).length).toBeGreaterThan(0);
  });
});

test('purchase order from a sales order: tick lines → save → receive part → over-receive with a note + a free line', async ({ page, request }) => {
  const token = await apiToken(request, 'charoen');
  const get = async (url: string) => (await (await request.get(url, { headers: { authorization: `Bearer ${token}` } })).json());
  const product = async (sku: string) => (await get(`/api/products?q=${sku}&limit=1`)).items[0] as { id: string };
  const paint = await product('PNT-PR9');
  const sand = await product('SAND-C');
  const backWh = ((await get('/api/warehouses')).items as { id: string; isPos: boolean; active: boolean; kind?: string }[]).find((w) => !w.isPos && w.active && w.kind !== 'damaged')!.id;
  const customer = ((await get('/api/customers?limit=20')).items as { id: string; code: string }[]).find((c) => c.code === 'C00001')!.id;
  const availOf = async (id: string) => Number((await get(`/api/stock?productId=${id}&warehouseId=${backWh}`)).items[0]?.available ?? 0);
  const qty = Math.max(await availOf(paint.id), 0) + 5; // 5 short of what the customer ordered
  const sandQty = Math.max(await availOf(sand.id), 0) + 3;
  const so = await request.post('/api/sales/orders', {
    headers: { authorization: `Bearer ${token}` },
    data: { customerId: customer, warehouseId: backWh, lines: [{ productId: paint.id, qty: String(qty), unitPrice: '1290' }, { productId: sand.id, qty: String(sandQty), unitPrice: '650' }] },
  });
  expect(so.ok(), await so.text()).toBeTruthy();
  const soNo = (await so.json()).no as string;

  await login(page, 'charoen');
  await page.goto(`/b2b/so/${soNo}`);
  await page.getByTestId('make-po').click();
  await expect(page.getByTestId('po-from')).toHaveText(soNo);
  const lines = page.getByTestId('po-lines');
  await expect(lines.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByTestId('po-q0')).toHaveValue('5');
  await expect(page.getByTestId('po-q1')).toHaveValue('3');
  await expect(lines.locator('tbody tr').first()).toContainText(String(qty)); // ordered qty shown next to the line
  await expect(page.getByTestId('po-partial-hint')).toBeVisible();
  await expect(page.getByTestId('po-all')).toBeChecked();
  await page.getByTestId('po-on1').uncheck(); // sand goes on another vendor's PO
  await expect(page.getByTestId('po-all')).not.toBeChecked();
  await expect(page.getByTestId('po-count')).toContainText('1 รายการ');
  await pick(page, 'po-vendor', 'ทวีพัฒนาวัสดุ', 'ทวีพัฒนา');
  await page.getByTestId('po-save').click();
  await expect(page).toHaveURL(/\/purchasing\/po\/PO\d{4}-\d{4}$/);
  const poNo = (await page.getByTestId('doc-no').textContent())!;
  await expect(page.getByTestId('po-status-pill')).toHaveText('รอรับของ');
  await expect(page.getByTestId('po-source')).toContainText(soNo);
  await expect(page.getByTestId('po-detail-lines').locator('tbody tr')).toHaveCount(1);

  await page.getByTestId('po-receive').click();
  await expect(page.getByTestId('gr-q0')).toHaveValue('5');
  await page.getByTestId('gr-q0').fill('2');
  await page.getByTestId('gr-dn').fill(`DN-PO-${Date.now()}`);
  await page.getByTestId('gr-inv').fill(`IV-PO-${Date.now()}`);
  await page.getByTestId('gr-save').click();
  await expect(page.getByTestId('po-status-pill')).toHaveText('รับบางส่วน');
  await expect(page.getByTestId('po-detail-lines')).toContainText('3');
  await expect(page.getByTestId('po-receipts')).toContainText('GR');

  // second delivery: one more than still due, plus a free bucket (ของแถม)
  await page.getByTestId('po-receive').click();
  await expect(page.getByTestId('gr-q0')).toHaveValue('3');
  await page.getByTestId('gr-q0').fill('4');
  await page.getByTestId('gr-add-free').click();
  await pick(page, 'gr-p1', 'สีรองพื้นปูนใหม่ 9 ลิตร', 'PNT-PR9');
  await expect(page.getByTestId('gr-free1')).toBeChecked();
  await expect(page.getByTestId('gr-c1')).toBeDisabled();
  await page.getByTestId('gr-dn').fill(`DN-PO2-${Date.now()}`);
  await page.getByTestId('gr-inv').fill(`IV-PO2-${Date.now()}`);
  await page.getByTestId('gr-save').click();
  const over = page.getByRole('dialog', { name: 'รับของเกินใบสั่งซื้อ' });
  await expect(over).toBeVisible();
  await expect(page.getByTestId('over-table')).toContainText('+1');
  await page.getByTestId('over-confirm').click();
  await expect(over.getByRole('alert')).toContainText('ใส่หมายเหตุ');
  await page.getByTestId('over-note').fill('ผู้ขายส่งเกินมา 1 ถัง ตกลงรับไว้');
  await page.getByTestId('over-confirm').click();
  await expect(page.getByTestId('po-status-pill')).toHaveText('รับครบ');
  await expect(page.getByTestId('po-over-pill')).toContainText('รับเกิน +1');
  await expect(page.getByTestId('po-over-note')).toContainText('ผู้ขายส่งเกินมา 1 ถัง');
  await shot(page, 'po-detail', 1300);
  const gr2 = (await page.getByTestId('po-receipts').getByRole('link').last().textContent())!;
  await page.getByTestId('po-receipts').getByRole('link', { name: gr2 }).click();
  await expect(page.getByTestId('gr-lines')).toContainText('ของแถม');
  await expect(page.getByTestId('gr-over-note')).toContainText('ผู้ขายส่งเกินมา');
  await page.getByTestId('gr-print').click();
  const paper = page.getByRole('dialog').getByTestId('paper');
  await expect(paper).toContainText('ใบรับสินค้า');
  await expect(paper).toContainText('(ของแถม)');
  await expect(paper).toContainText('รับเกินใบสั่งซื้อ: ผู้ขายส่งเกินมา');
  await paper.screenshot({ path: 'e2e/screenshots/gr-print.png' });
  await page.keyboard.press('Escape');

  // the next PO from the same order suggests only what is still missing (sand), paint is unticked at 0
  await page.goto(`/b2b/so/${soNo}`);
  await expect(page.getByTestId('doc-pos')).toContainText(poNo);
  await page.getByTestId('make-po').click();
  await expect(page.getByTestId('po-q1')).toHaveValue('3');
  await expect(page.getByTestId('po-on0')).not.toBeChecked();
  await expect(page.getByTestId('po-on1')).toBeChecked();
  await page.goto(`/b2b/so/${soNo}`);
  await page.getByTestId('doc-pos').getByRole('link', { name: poNo }).click();
  await expect(page).toHaveURL(new RegExp(`/purchasing/po/${poNo}$`));
});

test('manual receipt with a free line, costed by market value: lots 112.50 / 75.00, shown on the GR and its print', async ({ page, request }) => {
  const run = `${EDITION}-${Date.now()}`;
  await login(page, 'charoen');
  await page.goto('/purchasing');
  await page.getByRole('button', { name: '+ ซื้อเข้าแบบบันทึกเอง' }).click();
  await pick(page, 'gr-vendor', 'ทวีพัฒนา', 'ทวี');
  await page.getByTestId('gr-dn').fill(`DN-FC-${run}`);
  await page.getByTestId('gr-inv').fill(`IV-FC-${run}`);
  await pick(page, 'gr-p0', 'ปูนซีเมนต์ตราเสือ 50 กก.', 'ปูนเสือ');
  await page.getByTestId('gr-q0').fill('20');
  await page.getByTestId('gr-c0').fill('150');
  await expect(page.getByTestId('gr-fgc')).toHaveCount(0); // the choice appears only with a free line
  await page.getByTestId('gr-add-free').click();
  await pick(page, 'gr-p1', 'กาวซีเมนต์ปูกระเบื้อง 20 กก.', 'กาวซีเมนต์');
  await page.getByTestId('gr-q1').fill('10');
  await expect(page.getByTestId('gr-fgc-zero')).toBeChecked(); // shop default
  await page.getByTestId('gr-fgc-allocate').check();
  await page.getByTestId('gr-m1').fill('100');
  await expect(page.getByTestId('gr-alloc0')).toContainText('112.50');
  await expect(page.getByTestId('gr-alloc1')).toContainText('75.00');
  await page.getByTestId('gr-save').click();
  await expect(page.getByText(/รับเข้าสต็อก GR\d{4}-\d{4} แล้ว/)).toBeVisible();

  const token = await apiToken(request, 'charoen');
  const gr = (await (await request.get(`/api/purchasing/receipts?q=IV-FC-${run}`, { headers: { authorization: `Bearer ${token}` } })).json()).items[0];
  expect(gr.total).toBe('3000.00'); // the AP amount stays what is owed
  await page.goto(`/purchasing/gr/${gr.no}`);
  const rows = page.getByTestId('gr-lines');
  await expect(rows.locator('thead')).toContainText('ต้นทุนหลังเฉลี่ย');
  await expect(rows.locator('tbody tr').nth(0)).toContainText('112.50');
  await expect(rows.locator('tbody tr').nth(1)).toContainText('75.00');
  await expect(page.getByTestId('gr-alloc-note')).toContainText('ต้นทุนเฉลี่ยตามมูลค่าตลาด');
  await page.getByTestId('gr-print').click();
  const paper = page.getByRole('dialog').getByTestId('paper');
  await expect(paper).toContainText('ต้นทุนหลังเฉลี่ย');
  await expect(paper).toContainText('ต้นทุนเฉลี่ยตามมูลค่าตลาด');
  await page.keyboard.press('Escape');
});
