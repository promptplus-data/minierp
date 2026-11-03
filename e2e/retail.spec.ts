/**
 * Module C (retail) browser flows: promotions (discount, below-cost confirmation, bundle) applied at the POS, held
 * bills, customer price list at the POS, BOM + manufacturing order, product photo, POS machines; screenshots at
 * 1300 / 390 px. Serial. Leaves no live promo, active price list or POS machine behind for later spec files.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITION, PP, approve, login, logout } from './helpers';

test.describe.configure({ mode: 'serial' });

const DIR = path.join(__dirname, 'screenshots');
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const BUNDLE_SKU = `BD-GLUE-${RUN}`;

async function noHorizontalScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
}
async function shot(page: Page, name: string) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(DIR, `retail-${EDITION}-${name}.png`), fullPage: true });
}
async function openPos(page: Page) {
  await page.goto('/pos');
  const open = page.getByTestId('shift-open');
  const strip = page.getByTestId('shift-strip');
  await expect(open.or(strip)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(strip).toBeVisible();
}
const row = (page: Page, testId: string, text: string) => page.getByTestId(testId).locator('tbody tr', { hasText: text });

test('owner creates a discount promo and a bundle; the manager needs the owner for a below-cost promo', async ({ page }) => {
  await login(page, 'charoen');
  await page.getByRole('link', { name: /โปรโมชั่นของร้าน/ }).click();
  await expect(page.getByTestId('promo-table')).toBeVisible();

  await page.getByTestId('promo-new').click();
  await page.getByTestId('pm-name').fill(`กระเบื้องลด 10% ${RUN}`);
  await page.getByTestId('pm-value').fill('10');
  await page.locator('.rt-pick label', { hasText: 'กระเบื้องหลังคาลอนคู่' }).click();
  await expect(page.locator('.md table')).toContainText('46.80'); // 52 − 10%
  await page.getByTestId('pm-save').click();
  await expect(row(page, 'promo-table', `กระเบื้องลด 10% ${RUN}`)).toContainText('กำลังใช้');

  await page.getByTestId('promo-new').click();
  await page.getByTestId('pm-name').fill(`ชุดปูกระเบื้อง ${RUN}`);
  await page.getByTestId('pm-kind').selectOption('bundle');
  await page.getByLabel('สินค้าในชุด 1').selectOption({ label: 'กาวซีเมนต์ปูกระเบื้อง 20 กก.' });
  await page.getByLabel('จำนวนต่อชุด 1').fill('2');
  await page.getByLabel('สินค้าในชุด 2').selectOption({ label: 'ปูนซีเมนต์ตราเสือ 50 กก.' });
  await page.getByLabel('จำนวนต่อชุด 2').fill('1');
  await page.getByTestId('pm-setprice').fill('520');
  await page.getByLabel('SKU ชุดโปร (ถ้ามี)').fill(BUNDLE_SKU);
  await expect(page.locator('.md')).toContainText('ลูกค้าประหยัด 45.00'); // 2 × 210 + 145 = 565
  await page.getByTestId('pm-save').click();
  await expect(row(page, 'promo-table', `ชุดปูกระเบื้อง ${RUN}`)).toContainText('ชุดโปร');
  await logout(page);

  await login(page, 'suda');
  await page.goto('/promos');
  await page.getByTestId('promo-new').click();
  await page.getByTestId('pm-name').fill(`ท่อ PVC ล้างสต็อก ${RUN}`);
  await page.getByTestId('pm-mode').selectOption('fixed');
  await page.getByTestId('pm-value').fill('70');
  await page.locator('.rt-pick label', { hasText: 'ท่อ PVC 4 หุน' }).click();
  await expect(page.getByTestId('pm-below')).toBeVisible();
  await page.getByTestId('pm-save').click();
  await approve(page, 'คุณเจริญ');
  await expect(row(page, 'promo-table', `ท่อ PVC ล้างสต็อก ${RUN}`)).toContainText('ต่ำกว่าทุน');
});

test('cashier: promo category, promo price and bundle in one bill; receipt shows the promo and the set', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  await page.getByRole('tablist', { name: 'หมวดหมู่' }).getByRole('button', { name: 'โปรโมชั่น' }).click();
  await expect(page.getByTestId('tile-SCG-ROOF-LK')).toContainText('46.80');
  await expect(page.getByTestId('tile-SCG-CEM-T50')).toHaveCount(0); // no discount promo on cement
  await page.getByTestId('tile-SCG-ROOF-LK').click();
  await page.getByTestId(`btile-${BUNDLE_SKU}`).click();
  await expect(page.getByTestId('bline-0')).toContainText('กาวซีเมนต์ปูกระเบื้อง 20 กก. × 2');
  await expect(page.getByTestId('total')).toHaveText('฿566.80');
  await page.getByTestId('pay').click();
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('sale-no')).toHaveText(/^ABB/);
  const slip = page.getByTestId('receipt');
  await expect(slip).toContainText(`ชุดโปร ชุดปูกระเบื้อง ${RUN} × 1`);
  await expect(slip).toContainText(`โปร กระเบื้องลด 10% ${RUN}`);
  await expect(slip).toContainText('566.80');
  await page.getByTestId('next-bill').click();
});

test('cashier holds a bill (no stock cut), starts another, and recalls the held one', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('tile-SCG-AAC-75').click();
  await page.getByTestId('qty-0').fill('10');
  await page.getByTestId('hold').click();
  await expect(page.getByTestId('cart').locator('.cline')).toHaveCount(0);
  await expect(page.getByTestId('held-open')).toContainText('(1)');
  await page.getByTestId('tile-PVC-4-85').click();
  await expect(page.getByTestId('cline-0')).toContainText('ท่อ PVC');
  await page.getByTestId('hold').click();
  await page.getByTestId('held-open').click();
  await expect(page.getByRole('dialog').locator('tbody tr')).toHaveCount(2);
  await page.getByRole('dialog').locator('tbody tr', { hasText: 'บิลพัก 1' }).getByTestId('held-resume').click();
  await expect(page.getByTestId('qty-0')).toHaveValue('10');
  await expect(page.getByTestId('cline-0')).toContainText('อิฐมวลเบา');
  // Discard the other one and the recalled bill.
  await page.getByTestId('held-open').click();
  await page.getByRole('dialog').getByRole('button', { name: 'ทิ้ง' }).click();
  await expect(page.getByRole('dialog')).toContainText('ไม่มีบิลที่พักไว้');
  await page.getByRole('dialog').getByRole('button', { name: 'ปิด' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'ยกเลิกบิล' }).click();
  await expect(page.getByTestId('cart').locator('.cline')).toHaveCount(0);
});

test('price list: the contractor price applies at the POS once the customer is chosen', async ({ page }) => {
  await login(page, 'charoen');
  await page.getByRole('link', { name: /ราคาตามลูกค้า/ }).click();
  await page.getByTestId('pl-new').click();
  await page.getByTestId('pl-name').fill(`ราคาผู้รับเหมา ${RUN}`);
  await page.getByTestId('pl-add').click();
  await page.getByLabel('สินค้าแถว 1').selectOption({ label: 'อิฐมวลเบา 7.5 ซม.' });
  await page.getByLabel('ซื้อตั้งแต่ แถว 1').fill('100');
  await page.getByLabel('ราคา แถว 1').fill('22.50');
  await page.getByTestId('pl-save').click();
  await expect(row(page, 'pl-table', `ราคาผู้รับเหมา ${RUN}`)).toContainText('ผู้รับเหมา');
  await logout(page);

  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('tile-SCG-AAC-75').click();
  await page.getByTestId('qty-0').fill('100');
  await expect(page.getByTestId('total')).toHaveText('฿2,400.00');
  await page.getByTestId('pos-cust').selectOption({ label: 'หจก. รุ่งเรืองก่อสร้าง' });
  await expect(page.getByTestId('cline-0')).toContainText('ราคาลูกค้า');
  await expect(page.getByTestId('total')).toHaveText('฿2,250.00');
  await page.getByTestId('pay').click();
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('sale-no')).toHaveText(/^ABB/);
  await page.getByTestId('next-bill').click();
});

test('production: BOM, open an MO (FIFO issue), record output twice, close into a new lot', async ({ page }) => {
  await login(page, 'charoen');
  await page.getByRole('link', { name: /การผลิต/ }).click();
  await page.getByTestId('tab-bom').click();
  await page.getByTestId('bom-new').click();
  await page.getByTestId('bom-product').selectOption({ label: 'ท่อคอนกรีต (วงบ่อ) ⌀80 ซม.' });
  for (const [i, name, q] of [[1, 'ปูนซีเมนต์ตราเสือ 50 กก.', '0.6'], [2, 'ทรายหยาบ', '0.05'], [3, 'หิน 3/4', '0.07'], [4, 'เหล็กเส้นกลม RB9 ยาว 10 ม.', '0.6']] as const) {
    await page.getByTestId('bom-add').click();
    await page.getByLabel(`วัตถุดิบ ${i}`).selectOption({ label: name });
    await page.getByLabel(`ใช้ต่อหน่วย ${i}`).fill(q);
  }
  await page.getByLabel('ค่าแรง / ค่าใช้จ่ายการผลิตต่อหน่วย (บาท)').fill('20');
  await page.getByTestId('bom-save').click();
  await expect(page.getByTestId('bom-1')).toContainText('ท่อคอนกรีต (วงบ่อ)');

  await page.locator('.tabs').getByRole('button', { name: 'ใบสั่งผลิต', exact: true }).click();
  await page.getByTestId('mo-new').click();
  await page.getByTestId('mo-plan').fill('5');
  const rebar = page.getByRole('dialog').locator('tbody tr', { hasText: 'เหล็กเส้นกลม' });
  await expect(rebar.locator('td').nth(1)).toHaveText('3 เส้น'); // 0.6 × 5
  await page.getByLabel('เบิก เหล็กเส้นกลม RB9 ยาว 10 ม.').fill('3.5');
  await expect(page.getByLabel('เบิก เหล็กเส้นกลม RB9 ยาว 10 ม.')).toHaveValue('3.5');
  await page.getByTestId('mo-issue').click();
  const mo = page.getByTestId('mo-table').locator('tbody tr').first();
  await expect(mo).toContainText('กำลังผลิต');
  const no = (await mo.locator('td').first().textContent())!.trim();

  await page.getByTestId(`mo-out-${no}`).click();
  await page.getByTestId('mo-good').fill('3');
  await page.getByTestId('mo-out-ok').click();
  await page.getByTestId(`mo-out-${no}`).click();
  await page.getByTestId('mo-good').fill('1');
  await page.getByTestId('mo-reject').fill('1');
  await page.getByTestId('mo-out-ok').click();
  await page.getByTestId(`mo-close-${no}`).click();
  await page.getByLabel('คืน เหล็กเส้นกลม RB9 ยาว 10 ม.').fill('0.5');
  await expect(page.getByTestId('mo-unit')).not.toHaveText('฿-');
  await page.getByTestId('mo-close-ok').click();
  await expect(mo).toContainText('ผลิตเสร็จ');
  await expect(mo).toContainText('4 / 1');
  await expect(mo).toContainText('80.00%');
  await page.getByTestId('tab-morep').click();
  await expect(row(page, 'morep-table', no)).toContainText('เหล็กเส้นกลม RB9 ยาว 10 ม.: 3 → 3');
});

test('owner uploads a photo for a shop product; SCG products keep the master image', async ({ page }) => {
  await login(page, 'charoen');
  await page.getByRole('link', { name: /รูปสินค้าในหน้าขาย/ }).click();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.getByTestId('img-file-RB9-10').setInputFiles({ name: 'rebar.png', mimeType: 'image/png', buffer: png });
  await expect(row(page, 'img-table', 'RB9-10')).toContainText('รูปของร้าน');
  await expect(row(page, 'img-table', 'SCG-CEM-T50')).toContainText('SCG master');
});

test('POS machines: register, approve with POS ID; a pending machine issues full tax invoices only', async ({ page }) => {
  await login(page, 'charoen');
  await page.getByRole('link', { name: /เครื่อง POS และ ภ.พ.06/ }).click();
  for (const [code, rd] of [[`POS-A${RUN}`, `E06${RUN}123456789`], [`POS-B${RUN}`, '']] as const) {
    await page.getByTestId('dev-new').click();
    await page.getByTestId('dev-code').fill(code);
    await page.getByTestId('dev-name').fill(`แท็บเล็ต ${code}`);
    if (rd) {
      await page.getByTestId('dev-rd').fill(rd);
      await page.getByTestId('dev-on').fill('2026-10-01');
      await page.getByTestId('dev-status').selectOption('approved');
    }
    await page.getByTestId('dev-save').click();
    await expect(row(page, 'dev-table', code)).toContainText(rd ? 'ออกได้' : 'เฉพาะใบเต็มรูป');
  }
  await logout(page);

  // The boy (sales role) opens a shift on the pending machine: ABB is greyed out with the reason.
  await login(page, 'boy');
  await page.goto('/pos');
  await page.getByTestId('shift-device').selectOption(`POS-B${RUN}`);
  await page.getByTestId('shift-open').click();
  await page.getByTestId('tile-PVC-4-85').click();
  await page.getByTestId('pay').click();
  await expect(page.getByTestId('abb-off')).toContainText('ออกได้เฉพาะใบกำกับภาษีเต็มรูป');
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('sale-no')).toHaveText(/^INV/);
  await page.getByTestId('next-bill').click();
});

for (const w of [1300, 390] as const) {
  test(`retail screens at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
    await login(page, 'charoen');
    for (const [p, name, ready] of [
      ['/promos', 'promos', 'promo-table'], ['/production', 'production', 'mo-table'], ['/price-lists', 'price-lists', 'pl-table'],
      ['/pos-devices', 'pos-devices', 'dev-table'], ['/product-images', 'product-images', 'img-table'],
    ] as const) {
      await page.goto(p);
      await expect(page.getByTestId(ready).locator('tbody tr').first()).toBeVisible();
      await expect(page.locator('.skrow')).toHaveCount(0);
      await noHorizontalScroll(page);
      if (EDITION === 'onprem') await expect(page.locator('body')).not.toContainText(PP);
      await shot(page, `${name}-${w}`);
    }
    await page.goto('/promos');
    await page.getByTestId('promo-new').click();
    await page.getByTestId('pm-kind').selectOption('bundle');
    await noHorizontalScroll(page);
    await page.screenshot({ path: path.join(DIR, `retail-${EDITION}-promo-modal-${w}.png`) });
    await page.keyboard.press('Escape');
    await page.goto('/production');
    await page.getByTestId('mo-new').click();
    await expect(page.getByRole('dialog').locator('tbody tr')).toHaveCount(4);
    await noHorizontalScroll(page);
    await page.screenshot({ path: path.join(DIR, `retail-${EDITION}-mo-modal-${w}.png`) });
    await page.keyboard.press('Escape');
    await logout(page);

    await login(page, 'prae');
    await openPos(page);
    await page.getByRole('tablist', { name: 'หมวดหมู่' }).getByRole('button', { name: 'โปรโมชั่น' }).click();
    await page.getByTestId('tile-SCG-ROOF-LK').click();
    await page.getByTestId(`btile-${BUNDLE_SKU}`).click();
    await noHorizontalScroll(page);
    await shot(page, `pos-${w}`);
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'ยกเลิกบิล' }).click();
  });
}

test('cleanup: close the promos, deactivate the price list, unregister the test machines', async ({ page }) => {
  await login(page, 'charoen');
  await page.goto('/promos?');
  for (const name of [`กระเบื้องลด 10% ${RUN}`, `ชุดปูกระเบื้อง ${RUN}`, `ท่อ PVC ล้างสต็อก ${RUN}`]) {
    const r = row(page, 'promo-table', name);
    await r.getByRole('button', { name: 'ปิดโปร' }).click();
    await page.getByTestId('promo-close-ok').click();
    await expect(r).toContainText('ปิดแล้ว');
  }
  await page.goto('/price-lists');
  await row(page, 'pl-table', `ราคาผู้รับเหมา ${RUN}`).getByRole('button', { name: 'แก้ไข' }).click();
  await page.getByRole('dialog').getByLabel('ใช้งาน').uncheck();
  await page.getByTestId('pl-save').click();
  await expect(row(page, 'pl-table', `ราคาผู้รับเหมา ${RUN}`)).toContainText('ปิด');
  // Machines cannot be deleted in the app (audit trail); the e2e database is reset here so later spec files
  // (which open shifts on random machine names) keep issuing ABB as in a shop without a registry.
  const url = process.env.DATABASE_URL;
  if (url) {
    const r = spawnSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', `delete from retail_pos_devices where code like '%${RUN}'`], { encoding: 'utf8' });
    if (r.status !== 0) console.warn('[retail e2e] could not remove test POS machines:', r.stderr || r.error);
  }
});
