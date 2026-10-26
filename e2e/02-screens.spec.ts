/** Screenshots of POS, the returns bill picker and stock at desktop and phone widths; fails on horizontal overflow. */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { EDITION, login } from './helpers';

const DIR = path.join(__dirname, 'screenshots');
const WIDTHS = [1300, 390] as const;

async function top(page: Page) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
}

async function noHorizontalScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
}

for (const w of WIDTHS) {
  test(`screens at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
    await login(page, 'prae');
    await page.goto('/pos');
    const open = page.getByTestId('shift-open');
    const strip = page.getByTestId('shift-strip');
    await expect(open.or(strip)).toBeVisible();
    if (await open.isVisible()) await open.click();
    await expect(strip).toBeVisible();
    await page.getByTestId('tile-SCG-CEM-T50').click();
    await page.getByTestId('tile-PVC-4-85').click();
    await page.getByTestId('ldisc-1').fill('5');
    await noHorizontalScroll(page);
    await top(page);
    await page.screenshot({ path: path.join(DIR, `${EDITION}-pos-${w}.png`), fullPage: true });

    await page.goto('/returns');
    await page.getByTestId('new-return').click();
    await expect(page.getByTestId('bill-results').locator('tbody tr').first()).toBeVisible();
    await page.getByTestId('bill-search').pressSequentially('ปูน', { delay: 20 });
    await expect(page.getByTestId('bill-results')).toBeVisible();
    await noHorizontalScroll(page);
    await page.screenshot({ path: path.join(DIR, `${EDITION}-returns-picker-${w}.png`), fullPage: false });

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
    await login(page, 'charoen');
    await page.goto('/stock');
    await expect(page.getByTestId('stock-table').locator('tbody tr').first()).toBeVisible();
    await expect(page.getByTestId('adjust-table')).toBeVisible();
    await noHorizontalScroll(page);
    await top(page);
    await page.screenshot({ path: path.join(DIR, `${EDITION}-stock-${w}.png`), fullPage: true });
  });
}
