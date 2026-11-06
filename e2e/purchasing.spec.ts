/**
 * Group B (purchasing) browser flows on a freshly seeded shop, both editions: delivery-file import → draft → map →
 * confirm (stock + AP), BR-10 banner, payment voucher with WHT, vendor return, stock count → approval request,
 * Import Hub dry run + commit, ledger. Screenshots at 1300 / 390 px into e2e/screenshots/purchasing-*.png.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITION, PP, login, logout } from './helpers';

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
    await page.getByTestId('draft-p-SCG-ROOF-DL-GY').selectOption({ label: 'SCG-ROOF-LK · กระเบื้องหลังคาลอนคู่ 50×120 ซม. สีเทา' });
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
