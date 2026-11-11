/** คลังสินค้า: the owner adds a damaged-goods warehouse; a damaged warehouse can't be POS; closing the last POS warehouse shows the error on the field. */
import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('owner creates a damaged-goods warehouse and the last POS warehouse cannot lose its POS flag', async ({ page }) => {
  await login(page, 'charoen');
  await page.goto('/warehouses');
  await page.getByTestId('wh-new').click();
  await page.getByTestId('wh-code').fill(`E2E${Date.now() % 100000}`);
  await page.getByTestId('wh-name').fill('ของเสีย e2e');
  await page.getByTestId('wh-pos').check();
  await page.getByTestId('wh-kind-damaged').check();
  await expect(page.getByTestId('wh-pos')).toBeDisabled();
  await expect(page.getByTestId('wh-pos')).not.toBeChecked();
  await page.getByTestId('wh-save').click();
  await expect(page.getByRole('cell', { name: /ของเสีย e2e/ })).toBeVisible();

  await page.getByTestId('wh-row-WH1').click();
  await page.getByTestId('wh-pos').uncheck();
  await page.getByTestId('wh-save').click();
  await expect(page.getByTestId('wh-pos')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.ferr')).toContainText('คลังหน้าร้าน (POS) ที่เปิดใช้อย่างน้อย 1 คลัง');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('a cashier does not see the warehouse screen in the menu', async ({ page }) => {
  await login(page, 'prae');
  await expect(page.getByRole('link', { name: 'คลังและประเภทคลัง' })).toHaveCount(0);
});
