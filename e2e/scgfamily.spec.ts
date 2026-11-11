/** Round 4 ข้อ 7: SCG Family coupon slot on the POS (cloud only; the cloud e2e server runs with SCGF_DEMO=1). */
import { expect, test, type Page } from '@playwright/test';
import { EDITION, login } from './helpers';

async function openPos(page: Page) {
  await page.goto('/pos');
  const open = page.getByTestId('shift-open');
  const strip = page.getByTestId('shift-strip');
  await expect(open.or(strip)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(strip).toBeVisible();
}
const baht = async (page: Page) => Number((await page.getByTestId('total').textContent())!.replace(/[^\d.]/g, ''));

test.describe('cloud', () => {
  test.skip(EDITION !== 'cloud', 'SCG Family is cloud only (OQ-A2)');

  test('cashier links a member, picks a coupon, the total drops by the coupon and the bill is paid', async ({ page }) => {
    await login(page, 'prae');
    await openPos(page);
    await page.getByTestId('tile-SCG-CEM-T50').click();
    await page.getByTestId('qty-0').fill('10');
    await page.getByTestId('pos-cust-input').fill('สมศรี');
    await page.getByTestId('pos-cust-list').getByRole('option', { name: /คุณสมศรี ทองดี/ }).click();
    const before = await baht(page);

    await page.getByTestId('scgf-open').click();
    await expect(page.getByRole('dialog', { name: 'เพิ่มส่วนลด' })).toBeVisible();
    // before a search: the search button and the footer buttons must not overlap
    const box = async (id: string) => (await page.getByTestId(id).boundingBox())!;
    const find = await box('scgf-member-find');
    const use = await box('scgf-member-use');
    expect(use.y).toBeGreaterThanOrEqual(find.y + find.height);
    await page.getByRole('dialog', { name: 'เพิ่มส่วนลด' }).screenshot({ path: 'e2e/screenshots/scgf-cloud-member-step.png' });
    await page.getByTestId('scgf-member-input').fill('SF22018834');
    await page.getByTestId('scgf-member-find').click();
    await expect(page.getByTestId('scgf-member-found')).toContainText('Gold');
    await page.getByTestId('scgf-member-use').click();
    // promotion tab: eligible and under-minimum coupons side by side
    await expect(page.getByTestId('scgf-card-SFC-300-15K')).toContainText('ยังไม่ถึงขั้นต่ำ');
    await expect(page.getByTestId('scgf-radio-SFC-300-15K')).toBeDisabled();
    await expect(page.getByTestId('scgf-card-SFC-100-1K')).toContainText('ใช้ไปแล้ว 8/100');
    await expect(page.getByTestId('scgf-card-SFC-300-15K')).toContainText('ไม่จำกัดสิทธิ');
    await page.getByTestId('scgf-tab-cash_card').click();
    await expect(page.getByTestId('scgf-card-SCC-50')).toBeVisible();
    await page.getByTestId('scgf-code').fill('sfc-100-1k');
    await page.getByTestId('scgf-code-add').click();
    await expect(page.getByTestId('scgf-radio-SFC-100-1K')).toBeChecked();
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.screenshot({ path: 'e2e/screenshots/scgf-cloud-picker-1300.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'e2e/screenshots/scgf-cloud-picker-390.png' });
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.getByTestId('scgf-confirm').click();

    await expect(page.getByTestId('scgf-applied')).toContainText('SFC-100-1K');
    await expect(page.getByTestId('t-coupon')).toHaveText('−100.00');
    await page.getByTestId('cart').screenshot({ path: 'e2e/screenshots/scgf-cloud-cart-1300.png' });
    await expect(page.getByTestId('t-billdisc')).toHaveText('−0.00'); // not a shop discount
    expect(await baht(page)).toBeCloseTo(before - 100, 2);
    await page.getByTestId('pay').click(); // no manager PIN, no discount reason
    await page.getByTestId('pay-confirm').click();
    await expect(page.getByTestId('sale-no')).toBeVisible();
  });

  test('a member without usable coupons sees the empty state', async ({ page }) => {
    await login(page, 'prae');
    await openPos(page);
    await page.getByTestId('tile-SCG-CEM-T50').click();
    await page.getByTestId('scgf-open').click();
    await page.getByTestId('scgf-member-input').fill('SF10000001');
    await page.getByTestId('scgf-member-find').click();
    await page.getByTestId('scgf-member-use').click();
    await expect(page.getByTestId('scgf-empty')).toHaveText('ยังไม่มีคูปองที่ใช้ได้');
    await page.getByTestId('scgf-close').click();
    await expect(page.getByTestId('scgf-applied')).toHaveCount(0);
  });
});

test('on-prem: no SCG Family slot on the POS', async ({ page }) => {
  test.skip(EDITION !== 'onprem', 'on-prem check');
  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('tile-SCG-CEM-T50').click();
  await expect(page.getByTestId('cline-0')).toBeVisible();
  await expect(page.getByTestId('scgf-slot')).toHaveCount(0);
  await expect(page.getByTestId('cart')).not.toContainText('SCG Family');
});
