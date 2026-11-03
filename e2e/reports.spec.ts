/**
 * Group E (reports): home dashboard, M11 reports with filters + CSV/Excel download, M12 export (PEAK / FlowAccount /
 * Express), GL mapping, history; both editions. Screenshots at 1300 / 390 px into e2e/screenshots/reports-*.png.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITION, PP, login, logout } from './helpers';

test.describe.configure({ mode: 'serial' });
const DIR = path.join(__dirname, 'screenshots');

// The e2e shop starts with the bare demo: add four weeks of sales (ABB, tax invoices, a void, a credit note) to report on.
// Runs after the core / other groups' specs, so their stock expectations are untouched; numbering continues after theirs.
test.beforeAll(() => {
  const r = spawnSync('pnpm', ['--filter', '@erp/db', 'exec', 'tsx', 'src/seedReports.ts'], { encoding: 'utf8', env: process.env });
  if (r.status !== 0) throw new Error(`seedReports failed: ${r.stderr || r.stdout}`);
});

async function noHorizontalScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
}
async function shot(page: Page, name: string, w: number) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(DIR, `reports-${EDITION}-${name}-${w}.png`), fullPage: true });
}
async function sized(page: Page, w: number) { await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 }); }
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
/** Clicks a download button and returns the file name and text (UTF-8, BOM stripped). */
async function download(page: Page, button: ReturnType<Page['getByTestId']>) {
  const [dl] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const text = readFileSync(await dl.path()!, 'utf8').replace(/^﻿/, '');
  return { name: dl.suggestedFilename(), text, raw: readFileSync(await dl.path()!) };
}

test('owner home "/": today, stock, receivables, payables, approvals and the 7-day chart', async ({ page }) => {
  await login(page, 'charoen');
  await page.goto('/');
  await expect(page.getByTestId('card-sales-today')).toContainText('ยอดขายวันนี้');
  await expect(page.getByTestId('card-low-stock')).toBeVisible();
  await expect(page.getByTestId('ar-due-card')).toBeVisible();
  await expect(page.getByTestId('ap-due-card')).toBeVisible();
  await expect(page.getByTestId('card-approvals')).toBeVisible();
  await expect(page.getByTestId('sales-chart')).toBeVisible();
  await expect(page.getByTestId('month-summary')).toContainText('กำไรขั้นต้น');
  await expect(page.getByRole('link', { name: /ภาพรวมร้าน/ })).toBeVisible();
  for (const w of [1300, 390]) {
    await sized(page, w);
    await page.goto('/');
    await expect(page.getByTestId('sales-chart')).toBeVisible();
    await noHorizontalScroll(page);
    await shot(page, 'home', w);
  }
});

test('sales and GP: group by product, download CSV and Excel with the filters', async ({ page }) => {
  await login(page, 'charoen');
  await page.goto('/reports');
  await page.getByLabel('ตั้งแต่วันที่').fill(daysAgo(30)); // the demo bills are spread over the last four weeks
  await expect(page.getByTestId('sales-kpis')).toContainText('กำไรขั้นต้น');
  await expect(page.getByTestId('sales-table').locator('tbody tr').first()).not.toContainText('ไม่มีรายการ');
  await page.getByTestId('sales-by').selectOption('product');
  await expect(page.getByTestId('sales-table')).toContainText('ปูนซีเมนต์');
  const csv = await download(page, page.getByTestId('sales-dl-csv'));
  expect(csv.name).toMatch(/^sales-product-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  expect(csv.text).toContain('ปูนซีเมนต์');
  const xlsx = await download(page, page.getByTestId('sales-dl-xlsx'));
  expect(xlsx.name).toMatch(/\.xlsx$/);
  expect(xlsx.raw.subarray(0, 2).toString()).toBe('PK');
  await page.getByTestId('sales-by').selectOption('saleType');
  await expect(page.getByTestId('sales-table')).toContainText('ขายปลีกหน้าร้าน');
  await page.getByTestId('sales-by').selectOption('day');
  for (const w of [1300, 390]) {
    await sized(page, w);
    await page.goto('/reports');
    await page.getByLabel('ตั้งแต่วันที่').fill(daysAgo(30));
    await expect(page.getByTestId('sales-table').locator('tbody tr').first()).not.toContainText('ไม่มีรายการ');
    await noHorizontalScroll(page);
    await shot(page, 'sales', w);
  }
});

test('stock as of a date, below reorder point, and VAT reports (voided at 0)', async ({ page }) => {
  await login(page, 'charoen');
  await page.goto('/reports');
  await page.getByTestId('tab-stock').click();
  await expect(page.getByTestId('stock-table').locator('tbody tr').first()).toBeVisible();
  await expect(page.getByTestId('stock-kpis')).toContainText('มูลค่าสต็อก FIFO');
  await page.getByTestId('stock-only').selectOption('low');
  await expect(page.getByTestId('stock-table')).toContainText('ต่ำกว่าจุดสั่งซื้อ');
  const csv = await download(page, page.getByTestId('stock-dl-csv'));
  expect(csv.name).toMatch(/^stock-\d{4}-\d{2}-\d{2}\.csv$/);
  for (const w of [1300, 390]) {
    await sized(page, w);
    await expect(page.getByTestId('stock-table')).toBeVisible();
    await noHorizontalScroll(page);
    await shot(page, 'stock', w);
  }
  await sized(page, 1300);
  await page.getByTestId('tab-vat').click();
  await page.getByTestId('vat-month').fill(daysAgo(10).slice(0, 7));
  await expect(page.getByTestId('vat-table').locator('tbody tr').first()).not.toContainText('ไม่มีรายการ');
  await expect(page.getByTestId('vat-table')).toContainText('ใบกำกับภาษีอย่างย่อ');
  await expect(page.getByTestId('vat-table')).toContainText('ยกเลิก');
  const vat = await download(page, page.getByTestId('vat-dl-csv'));
  expect(vat.text).toContain('รายงานภาษีขาย');
  await page.getByTestId('vat-purchase').click();
  await expect(page.getByTestId('vat-table')).toBeVisible();
  const pv = await download(page, page.getByTestId('vat-dl-csv'));
  expect(pv.text).toContain('รายงานภาษีซื้อ');
  for (const w of [1300, 390]) {
    await sized(page, w);
    await page.getByTestId('vat-sales').click();
    await expect(page.getByTestId('vat-table').locator('tbody tr').first()).toBeVisible();
    await noHorizontalScroll(page);
    await shot(page, 'vat', w);
  }
});

test('internal cost, promotions and the edition rule for SCG Family coupons', async ({ page }) => {
  await login(page, 'charoen');
  await page.goto('/reports');
  await page.getByTestId('tab-cost').click();
  await expect(page.getByTestId('cost-table')).toContainText('กำไรหลังหักต้นทุนภายใน');
  await page.getByTestId('tab-promo').click();
  await expect(page.getByTestId('promo-table')).toBeVisible();
  await expect(page.getByTestId('promo-link')).toHaveAttribute('href', '/promos');
  if (EDITION === 'cloud') {
    await page.getByTestId('tab-coupon').click();
    await expect(page.getByTestId('coupon-table')).toBeVisible();
    await expect(page.getByTestId('coupon-table')).toContainText('ยังไม่มีบิลที่ใช้คูปอง');
  } else {
    await expect(page.getByTestId('tab-coupon')).toHaveCount(0);
    expect((await page.request.get('/api/reports/coupons?from=2026-01-01&to=2026-01-31')).status()).toBe(404);
  }
  for (const w of [1300, 390]) {
    await sized(page, w);
    await page.getByTestId('tab-cost').click();
    await expect(page.getByTestId('cost-table')).toBeVisible();
    await noHorizontalScroll(page);
    await shot(page, 'costs', w);
  }
});

test('export: PEAK sales (2 header rows, 21 columns), only-new, FlowAccount, GL codes, history', async ({ page }) => {
  await login(page, 'charoen');
  await page.goto('/export');
  await expect(page.getByTestId('ex-template')).toBeVisible();
  await page.getByTestId('ex-run').click();
  await expect(page.getByTestId('ex-result')).toContainText('สร้างไฟล์แล้ว');
  const peak = await download(page, page.getByTestId('ex-result').getByTestId('file-1'));
  expect(peak.name).toMatch(/^peak-sales-.*\.csv$/);
  const lines = peak.text.trimEnd().split('\r\n');
  expect(lines.length).toBeGreaterThan(3);
  expect(lines[0]!.split(',')).toHaveLength(21);
  expect(lines[1]).toContain('วันที่เอกสาร*');
  await expect(page.getByTestId('ex-history').locator('tbody tr').first()).toContainText('PEAK');

  await page.getByTestId('ex-template').selectOption('flowaccount');
  await page.getByTestId('ex-only-new').check();
  await page.getByTestId('ex-run').click();
  await expect(page.getByTestId('ex-result')).toContainText('FlowAccount');
  await page.getByTestId('ex-run').click(); // second only-new run: nothing left
  await expect(page.getByTestId('ex-result')).toContainText('0 แถว');
  await page.getByTestId('ex-only-new').uncheck();
  await page.getByTestId('ex-template').selectOption('express');
  await page.getByTestId('ex-dataset').selectOption('purchase');
  await page.getByTestId('ex-run').click();
  await expect(page.getByTestId('ex-result')).toContainText('Express');

  await page.getByTestId('ex-template').selectOption('peak');
  await page.getByTestId('ex-dataset').selectOption('contacts');
  await expect(page.getByTestId('ex-from')).toHaveCount(0);
  await page.getByTestId('ex-run').click();
  await expect(page.getByTestId('ex-result')).toContainText('ผู้ติดต่อ');
  await expect(page.getByTestId('ex-result').getByRole('button')).not.toHaveCount(0);
  const contacts = await download(page, page.getByTestId('ex-result').getByTestId('file-1'));
  expect(contacts.text.split('\r\n')[1]!.split(',')).toHaveLength(47);

  await page.getByTestId('gl-sale').fill('410199');
  await page.getByTestId('gl-save').click();
  await expect(page.getByText('บันทึกผังบัญชีสำหรับส่งออกแล้ว')).toBeVisible();
  await page.getByTestId('gl-sale').fill('410101');
  await page.getByTestId('gl-save').click();
  await expect(page.getByTestId('gl-save')).toBeDisabled();
  await expect(page.getByText(PP)).toHaveCount(0);
  for (const w of [1300, 390]) {
    await sized(page, w);
    await page.goto('/export');
    await expect(page.getByTestId('ex-history').locator('tbody tr').first()).toBeVisible();
    await noHorizontalScroll(page);
    await shot(page, 'export', w);
  }
});

test('roles: the cashier sees today only; no reports, export or cost', async ({ page }) => {
  await login(page, 'prae');
  await page.goto('/');
  await expect(page.getByTestId('card-sales-today')).toBeVisible();
  await expect(page.getByTestId('month-summary')).toHaveCount(0);
  await expect(page.getByTestId('ar-due-card')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /รายงาน/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /ส่งออกให้นักบัญชี/ })).toHaveCount(0);
  await page.goto('/export');
  await expect(page.getByTestId('ex-template')).toHaveCount(0); // guard sends the cashier home
  await sized(page, 390);
  await page.goto('/');
  await expect(page.getByTestId('card-sales-today')).toBeVisible();
  await noHorizontalScroll(page);
  await shot(page, 'home-cashier', 390);
  await logout(page);
});
