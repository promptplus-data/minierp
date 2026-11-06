/**
 * Error UX: the red-header "ทำรายการไม่สำเร็จ" dialog for failed mutations, red fields with text + focus for VALIDATION /
 * client checks / unique values, the red banner with retry for failed list loads, login failures, and the screens that keep
 * their own error flow (shortage table, owner PIN) without a second dialog. Serial.
 * Screenshots: e2e/screenshots/errors-<edition>-<name>-<width>.png
 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITION, approve, login } from './helpers';

test.describe.configure({ mode: 'serial' });

const DIR = path.join(__dirname, 'screenshots');
const dialog = (page: Page) => page.getByTestId('error-dialog');

async function openPos(page: Page) {
  await page.goto('/pos');
  const open = page.getByTestId('shift-open');
  const strip = page.getByTestId('shift-strip');
  await expect(open.or(strip)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(strip).toBeVisible();
}
async function toPay(page: Page) {
  await page.getByTestId('tile-SCG-CEM-T50').click();
  await page.getByTestId('pay').click();
}
async function shot(page: Page, name: string, widths: number[] = [1300, 390]) {
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
    await page.waitForTimeout(250);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
    await page.screenshot({ path: path.join(DIR, `errors-${EDITION}-${name}-${w}.png`) });
  }
  await page.setViewportSize({ width: 1300, height: 900 });
}

test('a failed POS sale opens the red-header dialog with title, message and support code', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  await toPay(page);
  await page.route('**/api/sales/pos', (r) => r.fulfill({
    status: 409, contentType: 'application/json', headers: { 'x-request-id': 'req-e2e-42' },
    body: JSON.stringify({ code: 'CONFLICT', message: 'Concurrent update, please retry' }),
  }));
  await page.getByTestId('pay-confirm').click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute('role', 'alertdialog');
  await expect(page.getByTestId('error-dialog-head')).toContainText('ทำรายการไม่สำเร็จ');
  await expect(page.getByTestId('error-dialog-message')).toHaveText('ข้อมูลขัดแย้งกับรายการที่มีอยู่');
  await expect(page.getByTestId('error-dialog-title')).toHaveCount(0); // the generic header says it all
  await expect(page.getByTestId('error-dialog-rows')).toContainText('Concurrent update');
  await expect(page.getByTestId('error-dialog-code')).toContainText('CONFLICT');
  await expect(page.getByTestId('error-dialog-code')).toContainText('req-e2e-42');
  const bg = await page.getByTestId('error-dialog-head').evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(bg).toBe('rgb(180, 35, 44)');
  await expect(page.getByTestId('error-dialog-ok')).toBeFocused();
  await expect(page.locator('.toast')).toHaveCount(0);
  await shot(page, 'dialog');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'dialog-dark', [1300]);
  await page.emulateMedia({ colorScheme: 'light' });

  // focus stays inside; Esc closes only the dialog, the payment modal underneath stays open
  await page.keyboard.press('Tab');
  await expect(dialog(page).locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'ชำระเงิน' })).toBeVisible();

  // a more specific title per code
  await page.unroute('**/api/sales/pos');
  await page.route('**/api/sales/pos', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'SHIFT_REQUIRED', message: 'shift' }) }));
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('error-dialog-title')).toHaveText('ต้องเปิดกะก่อน');
  await expect(page.getByTestId('error-dialog-message')).toContainText('เปิดกะ');
  await expect(page.locator('.toast')).toHaveCount(0); // not both a toast and the dialog
  await page.getByTestId('error-dialog-ok').click();
  await expect(dialog(page)).toHaveCount(0);
  await page.unroute('**/api/sales/pos');
});

test('the shortage modal and the owner PIN flow do not double up with the generic dialog', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('tile-PNT-PR9').click();
  await page.getByTestId('qty-0').fill('20');
  await page.getByTestId('pay').click();
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('shortage-table')).toBeVisible();
  await page.waitForTimeout(400); // the dialog would open one task after the failure
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'ตกลง' }).click();
  await page.reload();

  // discount over the cap: PIN modal; a wrong PIN is red in the modal and opens no dialog
  await openPos(page);
  await page.getByTestId('tile-SCG-CEM-T50').click();
  await page.getByTestId('ldisc-0').fill('30');
  await page.getByTestId('pay').click();
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByRole('heading', { name: 'ส่วนลดเกินสิทธิ์' })).toBeVisible();
  await expect(page.getByTestId('apv-by').locator('option').first()).toBeAttached();
  await page.getByTestId('apv-pin').fill('9999');
  await page.getByTestId('apv-ok').click();
  await expect(page.getByRole('dialog', { name: 'ขออนุมัติ' }).getByRole('alert')).toHaveText('PIN ไม่ถูกต้อง');
  await expect(page.getByTestId('apv-pin')).toHaveAttribute('aria-invalid', 'true');
  await page.waitForTimeout(400);
  await expect(dialog(page)).toHaveCount(0);
  await page.getByTestId('apv-pin').fill('1');
  await expect(page.getByTestId('apv-pin')).not.toHaveAttribute('aria-invalid', 'true'); // editing clears the mark
});

test.describe('fields', () => {
  test('product form: client check, server VALIDATION and a duplicate SKU mark the field red, show text and focus it', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/products');
    await page.getByRole('button', { name: /เพิ่มสินค้า/ }).click();

    // client-side: empty SKU
    await page.getByTestId('pf-save').click();
    const sku = page.getByTestId('pf-sku');
    await expect(sku).toHaveAttribute('aria-invalid', 'true');
    await expect(sku).toBeFocused();
    await expect(page.locator('.ferr').first()).toHaveText('กรุณากรอกรหัสสินค้า');
    await expect(page.getByTestId('pf-name')).toHaveAttribute('aria-invalid', 'true');
    expect(await sku.evaluate((e) => getComputedStyle(e).borderColor)).toBe('rgb(180, 35, 44)');
    await expect(dialog(page)).toHaveCount(0);
    await shot(page, 'field');
    await sku.fill('E2E-ERR-1');
    await expect(sku).not.toHaveAttribute('aria-invalid', 'true'); // editing clears it
    await expect(page.locator('.ferr')).toHaveCount(1); // only the name box is left

    // server VALIDATION (zod issue with a path): the name input is marked, nothing opens
    await page.getByTestId('pf-name').fill('ทดสอบ');
    await page.route('**/api/products', (r) => (r.request().method() === 'POST'
      ? r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'VALIDATION', message: 'Invalid request', details: [{ code: 'too_small', minimum: 1, type: 'string', inclusive: true, exact: false, message: 'String must contain at least 1 character(s)', path: ['name'] }] }) })
      : r.fallback()));
    await page.getByTestId('pf-save').click();
    await expect(page.getByTestId('pf-name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('pf-name')).toBeFocused();
    await expect(page.locator('.ferr')).toHaveText('ต้องกรอก');
    await page.waitForTimeout(400);
    await expect(dialog(page)).toHaveCount(0);
    await page.unroute('**/api/products');

    // a unique value that already exists (real server answer): the SKU field
    await page.getByTestId('pf-sku').fill('SCG-CEM-T50');
    await page.getByTestId('pf-save').click();
    await expect(page.getByTestId('pf-sku')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.ferr')).toContainText('มีอยู่แล้ว');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('a VALIDATION problem with no input on screen lists the issues in the dialog', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/products');
    await page.getByRole('button', { name: /เพิ่มสินค้า/ }).click();
    await page.getByTestId('pf-sku').fill('E2E-ERR-2');
    await page.getByTestId('pf-name').fill('ทดสอบ');
    await page.route('**/api/products', (r) => (r.request().method() === 'POST'
      ? r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'VALIDATION', message: 'Invalid request', details: [{ code: 'invalid_type', expected: 'string', received: 'undefined', path: ['vendorId'], message: 'Required' }] }) })
      : r.fallback()));
    await page.getByTestId('pf-save').click();
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId('error-dialog-title')).toHaveText('ข้อมูลไม่ครบหรือไม่ถูกต้อง');
    await expect(page.getByTestId('error-dialog-rows')).toContainText('vendorId: ต้องกรอก');
    await page.getByTestId('error-dialog-ok').click();
    await page.unroute('**/api/products');
  });

  test('return quantity over the maximum marks that line red (server answer with the line id)', async ({ page }) => {
    await login(page, 'prae');
    await openPos(page);
    await toPay(page);
    await page.getByTestId('pay-confirm').click();
    const no = ((await page.getByTestId('sale-no').textContent()) ?? '').trim();
    await page.getByTestId('next-bill').click();
    await page.goto('/returns');
    await page.getByTestId('new-return').click();
    const search = page.getByTestId('bill-search');
    await search.fill(no.toLowerCase());
    await search.press('Enter');
    await expect(page.getByTestId('bill-selected')).toContainText(no);
    await expect(page.getByTestId('rq-0')).toBeVisible();
    // client check: not a number
    await page.getByTestId('rq-0').fill('abc');
    await page.getByTestId('ret-save').click();
    await expect(page.getByTestId('rq-0')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.ferr').first()).toContainText('ตัวเลขมากกว่า 0');
    await expect(dialog(page)).toHaveCount(0);
    // server says the line is over its maximum
    await page.getByTestId('rq-0').fill('1');
    const lineId = await page.getByTestId('rq-0').getAttribute('data-line');
    await page.route('**/api/returns', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'CONFLICT', message: 'Return qty 1 is more than sold', details: { lineId, max: '0.5' } }) }));
    await page.getByTestId('ret-save').click();
    await approve(page, 'คุณสุดา'); // a cashier's return needs a manager PIN; the mocked answer comes after it
    await expect(page.getByTestId('rq-0')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('rq-0')).toBeFocused();
    await expect(page.locator('.ferr').first()).toContainText('สูงสุด 0.5');
    await expect(dialog(page)).toHaveCount(0);
    await page.unroute('**/api/returns');
  });
});

test('a failed list load shows a red banner with retry instead of an empty table', async ({ page }) => {
  await login(page, 'charoen');
  await page.route(/\/api\/products\?/, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL', message: 'boom' }) }));
  await page.goto('/products');
  const banner = page.getByTestId('error-banner');
  await expect(banner.first()).toBeVisible({ timeout: 20_000 });
  await expect(banner.first()).toContainText('โหลดข้อมูลไม่สำเร็จ');
  await expect(banner.first()).toContainText('ระบบขัดข้อง');
  await expect(page.getByTestId('error-retry').first()).toBeVisible();
  await shot(page, 'banner');
  await page.unroute(/\/api\/products\?/);
  await page.getByTestId('error-retry').first().click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'SCG-CEM-T50' }).first()).toBeVisible();
});

test('login failure: red fields and a clear message box, no dialog', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByLabel('ชื่อผู้ใช้')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('login-error')).toHaveText('กรอกชื่อผู้ใช้และรหัสผ่าน');
  await page.getByLabel('ชื่อผู้ใช้').fill('prae');
  await page.getByLabel('รหัสผ่าน').fill('wrong');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByTestId('login-error')).toHaveText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  await expect(page.getByLabel('ชื่อผู้ใช้')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('รหัสผ่าน')).toHaveAttribute('aria-invalid', 'true');
  await page.waitForTimeout(400);
  await expect(dialog(page)).toHaveCount(0);
  await shot(page, 'login');
  await page.getByLabel('รหัสผ่าน').fill('1234');
  await expect(page.getByTestId('login-error')).toHaveCount(0);
  await expect(page.getByLabel('รหัสผ่าน')).not.toHaveAttribute('aria-invalid', 'true');
});

test.describe('touch mode', () => {
  test.use({ hasTouch: true });
  test('the dialog sits above the on-screen keyboard', async ({ page }) => {
    await page.addInitScript(() => { try { localStorage.setItem('erp-touch-mode', 'on'); } catch { /* ignore */ } });
    await login(page, 'charoen');
    await page.goto('/products');
    await page.getByRole('button', { name: /เพิ่มสินค้า/ }).click();
    await page.getByTestId('pf-sku').fill('E2E-ERR-3');
    await page.getByTestId('pf-name').fill('ทดสอบ');
    await page.getByTestId('pf-name').tap(); // keyboard sheet up
    await expect(page.locator('.tk-sheet')).toBeVisible();
    await page.route('**/api/products', (r) => (r.request().method() === 'POST'
      ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'INTERNAL', message: 'boom' }) })
      : r.fallback()));
    await page.getByTestId('pf-save').dispatchEvent('click');
    await expect(dialog(page)).toBeVisible();
    await expect(page.getByTestId('error-dialog-title')).toHaveText('ระบบขัดข้อง');
    const box = (await page.getByTestId('error-dialog-ok').boundingBox())!;
    const top = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-testid="error-dialog"]') !== null, [box.x + box.width / 2, box.y + box.height / 2]);
    expect(top).toBe(true);
    await shot(page, 'dialog-touch');
    await page.getByTestId('error-dialog-ok').tap();
    await expect(dialog(page)).toHaveCount(0);
    await page.unroute('**/api/products');
  });
});
