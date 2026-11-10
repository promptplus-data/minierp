/** POS (M07): totals with discounts, manager override at entry, reasons, below-cost flag, live margin, customer picker, credit sale. */
import { expect, test, type Page } from '@playwright/test';
import { apiToken, approve, login } from './helpers';

const RUN = Date.now().toString(36).slice(-5);

async function openPos(page: Page) {
  await page.goto('/pos');
  const open = page.getByTestId('shift-open');
  const strip = page.getByTestId('shift-strip');
  await expect(open.or(strip)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(strip).toBeVisible();
}
async function pick(page: Page, testId: string, typed: string, option: RegExp) {
  await page.getByTestId(`${testId}-input`).fill(typed);
  await page.getByTestId(`${testId}-list`).getByRole('option', { name: option }).click();
}

test('manager: line discount within the cap shows gross, line discount, struck list price and live margin; reason required', async ({ page }) => {
  await login(page, 'suda');
  await openPos(page);
  await page.getByTestId('tile-PVC-4-85').click();
  await page.getByTestId('qty-0').fill('10');
  await page.getByTestId('lqd-0-10').click(); // 10 % ≤ manager cap 20 %: no PIN
  await expect(page.getByRole('heading', { name: 'ส่วนลดเกินสิทธิ์' })).toHaveCount(0);
  await expect(page.getByTestId('t-gross')).toHaveText('890.00');
  await expect(page.getByTestId('t-linedisc')).toHaveText('−89.00');
  await expect(page.getByTestId('t-billdisc')).toHaveText('−0.00');
  await expect(page.getByTestId('total')).toHaveText('฿801.00');
  await expect(page.getByTestId('was-0')).toHaveText('890.00');
  await expect(page.getByTestId('lnet-0')).toHaveText('801.00');
  // data.cost: FIFO cost and margin per line, bill profit
  await expect(page.getByTestId('lcost-0-margin')).toContainText('กำไร');
  await expect(page.getByTestId('t-profit')).toBeVisible();
  // bill discount quick 5 % on top
  await page.getByTestId('bqd-5').click();
  await expect(page.getByTestId('t-billdisc')).toHaveText('−40.05');
  // a discount needs a reason before paying
  await page.getByTestId('pay').click();
  await expect(page.getByTestId('disc-reason')).toHaveClass(/bad/);
  await page.getByTestId('reason-bulk').click();
  await page.getByTestId('pay').click();
  await page.getByTestId('pay-note').fill(`ส่งของบ่ายนี้ ${RUN}`);
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('sale-no')).toBeVisible();
  await expect(page.getByTestId('slip-note')).toContainText(RUN);
  const no = (await page.getByTestId('sale-no').textContent())!.trim();
  await page.getByTestId('next-bill').click();
  await page.goto(`/sales/${no}`);
  await expect(page.getByTestId('doc-disc-reason')).toHaveText('ซื้อจำนวนมาก');
  await expect(page.getByTestId('doc-note')).toContainText(RUN);
});

test('cashier: a bill discount asks the manager PIN at entry, then the sale goes through', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('tile-PVC-4-85').click();
  await page.getByTestId('bqd-5').click();
  await expect(page.getByRole('heading', { name: 'ส่วนลดเกินสิทธิ์' })).toBeVisible();
  await expect(page.getByTestId('override-what')).toContainText('4.45');
  await approve(page, 'คุณสุดา');
  await expect(page.getByTestId('override-state')).toContainText('อนุมัติแล้ว');
  // lowering the discount stays approved; raising it asks again
  await page.getByTestId('bill-disc').fill('10');
  await page.getByTestId('bill-disc').press('Enter');
  await expect(page.getByRole('heading', { name: 'ส่วนลดเกินสิทธิ์' })).toBeVisible();
  await page.getByRole('dialog', { name: 'ขออนุมัติ' }).getByRole('button', { name: 'ยกเลิก' }).click();
  await expect(page.getByTestId('bill-disc')).toHaveValue('4.45'); // back to the approved discount
  await page.getByTestId('reason-regular').click();
  await page.getByTestId('pay').click();
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('sale-no')).toHaveText(/^ABB/);
  await page.getByTestId('next-bill').click();
});

test('cashier: below-cost line shows a red flag but never cost numbers', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('tile-SCG-AAC-75').click();
  await page.getByTestId('price-0').fill('10');
  await page.getByTestId('price-0').press('Enter');
  await expect(page.getByTestId('override-what')).toContainText('แก้ราคาขาย');
  await approve(page, 'คุณสุดา');
  await expect(page.getByTestId('lcost-0-below')).toHaveText('ต่ำกว่าทุน');
  await expect(page.getByTestId('below-flag')).toBeVisible();
  await expect(page.getByTestId('lcost-0-margin')).toHaveCount(0);
  await expect(page.getByTestId('t-profit')).toHaveCount(0);
  await expect(page.getByTestId('cart')).not.toContainText('ทุน 1');
  await page.getByRole('button', { name: 'ยกเลิกบิล' }).click({ trial: true });
});

test('customer search and quick create from the POS cart', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('pos-cust-input').fill('บ้านนา');
  await expect(page.getByTestId('pos-cust-list').getByRole('option', { name: /ร้านวัสดุบ้านนา/ })).toBeVisible();
  const name = `ลูกค้าหน้าร้าน ${RUN}`;
  await page.getByTestId('pos-cust-input').fill(name);
  await page.getByTestId('pos-cust-create').click();
  await expect(page.getByTestId('quick-customer')).toBeVisible();
  await page.getByTestId('quick-customer-save').click();
  await expect(page.getByTestId('pos-cust-input')).toHaveValue(name);
});

test('credit sale (เงินเชื่อ) appears in AR and not in the shift cash', async ({ page, request }) => {
  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('tile-PVC-4-85').click();
  await page.getByTestId('pay').click();
  await expect(page.getByTestId('pm-0').locator('option[value="credit"]')).toBeDisabled();
  await pick(page, 'pay-cust', 'บ้านนา', /ร้านวัสดุบ้านนา/);
  await page.getByTestId('pm-0').selectOption('credit');
  await expect(page.getByTestId('credit-info')).toContainText('ลูกหนี้');
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('sale-no')).toBeVisible();
  await expect(page.getByTestId('receipt')).toContainText('เงินเชื่อ');
  const no = (await page.getByTestId('sale-no').textContent())!.trim();
  await page.getByTestId('next-bill').click();
  const token = await apiToken(request, 'charoen');
  const ar = await request.get('/api/ar/invoices?limit=100', { headers: { authorization: `Bearer ${token}` } });
  const items = (await ar.json()).items as { no: string; arBalance: string }[];
  expect(items.find((x) => x.no === no)?.arBalance).toBe('89.00');
  await page.goto(`/sales/${no}`);
  await expect(page.getByTestId('doc-ar')).toContainText('89.00');
});
