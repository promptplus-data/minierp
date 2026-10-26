/** Browser flows against a freshly seeded shop. Serial: later tests use bills made by earlier ones. */
import { expect, test } from '@playwright/test';
import { EDITION, PP, apiToken, approve, login } from './helpers';

test.describe.configure({ mode: 'serial' });

let firstAbb = '';
let invNo = '';

test('login: wrong password, resigned user, then success', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('ชื่อผู้ใช้').fill('prae');
  await page.getByLabel('รหัสผ่าน').fill('wrong');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByTestId('login-error')).toHaveText('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');

  await page.getByLabel('ชื่อผู้ใช้').fill('ton');
  await page.getByLabel('รหัสผ่าน').fill('1234');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByTestId('login-error')).toContainText('ลาออก');

  await page.getByLabel('รหัสผ่าน').fill('1234');
  await page.getByLabel('ชื่อผู้ใช้').fill('prae');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByRole('link', { name: /ขายหน้าร้าน/ })).toBeVisible();
  // cashier: no product master, no audit log in the nav (core.perm)
  await expect(page.getByRole('link', { name: /สินค้าและหน่วยนับ/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /ประวัติการทำรายการ/ })).toHaveCount(0);
  await expect(page.getByTestId('edition')).toHaveText(EDITION === 'cloud' ? 'Cloud' : 'On-premise');
});

test(`edition: Prompt Plus UI ${EDITION === 'cloud' ? 'shown on cloud' : 'absent on-prem'}`, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('ชื่อผู้ใช้')).toBeVisible();
  if (EDITION === 'cloud') {
    await expect(page.getByTestId('pp-sso')).toBeVisible();
    await page.getByTestId('pp-sso').click();
    await expect(page.getByText('กำลังจะมาเร็ว ๆ นี้')).toBeVisible();
  } else {
    await expect(page.locator('body')).not.toContainText(PP);
    await expect(page.locator('[data-testid^="pp-"]')).toHaveCount(0);
  }
  await login(page, 'charoen');
  for (const path of ['/stock', '/pos', '/sales', '/products', '/returns', '/audit']) {
    await page.goto(path);
    await expect(page.locator('main.content .card').first()).toBeVisible();
    if (EDITION === 'onprem') {
      await expect(page.locator('body')).not.toContainText(PP);
      await expect(page.locator('[data-testid^="pp-"]')).toHaveCount(0);
    }
  }
  await page.goto('/stock');
  if (EDITION === 'cloud') {
    await expect(page.getByTestId('pp-incoming')).toBeVisible();
    await expect(page.getByTestId('pp-order')).toBeVisible();
  } else {
    await expect(page.getByText('ซื้อเข้าแบบบันทึกเอง').first()).toBeVisible();
  }
});

test('cashier opens a shift and sells 2 items with cash', async ({ page }) => {
  await login(page, 'prae');
  await page.getByRole('link', { name: /ขายหน้าร้าน/ }).click();
  await page.getByTestId('shift-float').fill('2000');
  await page.getByTestId('shift-open').click();
  await expect(page.getByTestId('shift-strip')).toContainText('กะเปิดอยู่');

  await page.getByTestId('tile-SCG-CEM-T50').click();
  await page.getByTestId('tile-SCG-AAC-75').click();
  await expect(page.getByTestId('cart').locator('.cline')).toHaveCount(2);
  await expect(page.getByTestId('total')).toHaveText('฿169.00');
  await page.getByTestId('pay').click();
  await page.getByTestId('pay-confirm').click();
  const no = page.getByTestId('sale-no');
  await expect(no).toHaveText(/^ABB\d{4}-\d{4}$/);
  firstAbb = (await no.textContent())!.trim();
  await expect(page.getByTestId('receipt')).toContainText(firstAbb);
  await expect(page.getByTestId('receipt')).toContainText('เงินสด');
  await page.getByTestId('next-bill').click();
  await expect(page.getByTestId('shift-strip')).toContainText('2,169.00'); // float + cash sale
});

test('selling more than stock shows the shortage table', async ({ page }) => {
  await login(page, 'prae');
  await page.goto('/pos');
  await page.getByTestId('tile-PNT-PR9').click();
  await page.getByTestId('qty-0').fill('20');
  await page.getByTestId('pay').click();
  await page.getByTestId('pay-confirm').click();
  const t = page.getByTestId('shortage-table');
  await expect(t).toBeVisible();
  await expect(t).toContainText('สีรองพื้นปูนใหม่ 9 ลิตร');
  await expect(t).toContainText('หน้าร้าน');
  await expect(t.locator('tbody tr').first().locator('td').nth(2)).toContainText('20');
  await expect(t.locator('tbody tr').first().locator('td').nth(3)).toHaveText('8');
});

test('below-cost sale: manager approves the discount, owner approves below cost', async ({ page }) => {
  await login(page, 'prae');
  await page.goto('/pos');
  await page.getByTestId('tile-SCG-CEM-T50').click();
  await page.getByTestId('ldisc-0').fill('30');
  await expect(page.getByTestId('total')).toHaveText('฿115.00');
  await page.getByTestId('pay').click();
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByRole('heading', { name: 'ส่วนลดเกินสิทธิ์' })).toBeVisible();
  // a wrong PIN stays in the modal
  await approve(page, 'คุณสุดา', '9999');
  await expect(page.getByRole('alert')).toHaveText('PIN ไม่ถูกต้อง');
  await approve(page, 'คุณสุดา');
  await expect(page.getByTestId('below-cost')).toContainText('ปูนซีเมนต์ตราเสือ');
  // below cost is owner-only: the picker lists the owner only
  await expect(page.getByTestId('apv-by').locator('option')).toHaveCount(1);
  await approve(page, 'คุณเจริญ');
  await expect(page.getByTestId('sale-no')).toHaveText(/^ABB\d{4}-\d{4}$/);
  await page.getByTestId('next-bill').click();
});

test('full tax invoice for a customer with a tax ID', async ({ page }) => {
  await login(page, 'prae');
  await page.goto('/pos');
  await page.getByTestId('pos-search').fill('8850001000014'); // barcode of SCG-CEM-T50
  await page.getByTestId('pos-search').press('Enter');
  await page.getByTestId('tile-SCG-AAC-75').click();
  await page.getByTestId('pay').click();
  await page.getByTestId('kind-full').check();
  // split payment: 100 cash + rest transfer
  await page.getByTestId('pa-0').fill('100');
  await page.getByTestId('add-pay').click();
  await expect(page.getByTestId('pa-1')).toHaveValue('69.00');
  await page.getByTestId('pay-confirm').click();
  const no = page.getByTestId('sale-no');
  await expect(no).toHaveText(/^INV\d{4}-\d{4}$/);
  invNo = (await no.textContent())!.trim();
  await expect(page.getByTestId('receipt')).toContainText('รุ่งเรืองก่อสร้าง');
  await expect(page.getByTestId('receipt')).toContainText('โอนเงิน');
});

test('returns: searchable picker by customer name and by bill no, return 1 unit', async ({ page }) => {
  await login(page, 'prae');
  await page.getByRole('link', { name: /รับคืนสินค้า/ }).click();
  await page.getByTestId('new-return').click();
  const search = page.getByTestId('bill-search');
  await expect(search).toBeFocused();
  await expect(page.getByTestId('bill-days')).toHaveValue('30');
  await search.pressSequentially('รุ่งเรือง', { delay: 30 });
  await expect(search).toBeFocused();
  const results = page.getByTestId('bill-results');
  await expect(results.locator('tbody tr')).toHaveCount(1);
  await expect(results).toContainText(invNo);

  await search.fill('');
  await search.pressSequentially(firstAbb.toLowerCase(), { delay: 20 });
  await expect(search).toBeFocused();
  await search.press('Enter');
  await expect(page.getByTestId('bill-selected')).toContainText(firstAbb);

  await page.getByTestId('rq-0').fill('1');
  await page.getByTestId('ret-save').click();
  await approve(page, 'คุณสุดา');
  await expect(page.getByTestId('cn-no')).toHaveText(/^CN\d{4}-\d{4}$/);
  await page.getByRole('button', { name: 'ปิด' }).click();
  await expect(page.getByTestId('cn-table')).toContainText('CN');
});

test('void a sale with a free-text reason; a bill with a CN cannot be voided', async ({ page }) => {
  await login(page, 'prae');
  await page.getByRole('link', { name: /เอกสารขาย/ }).click();
  await page.getByTestId('docs-search').fill(invNo);
  await expect(page.getByTestId('docs-table').locator('tbody tr')).toHaveCount(1);
  await page.getByTestId('docs-table').getByText(invNo).click();
  await expect(page.getByTestId('doc-no')).toHaveText(invNo);
  await page.getByTestId('void').click();
  await page.getByTestId('void-reason').selectOption('__o');
  await page.getByTestId('void-ok').click();
  await expect(page.getByRole('alert')).toContainText('ต้องพิมพ์เหตุผล');
  await page.getByTestId('void-reason-other').fill('ลูกค้าขอเปลี่ยนเป็นบิลใหม่');
  await page.getByTestId('void-ok').click();
  await approve(page, 'คุณสุดา');
  await expect(page.getByTestId('voided')).toContainText('ลูกค้าขอเปลี่ยนเป็นบิลใหม่');

  await page.goto(`/sales/${firstAbb}`);
  await page.getByTestId('void').click();
  await page.getByTestId('void-reason').selectOption({ index: 3 });
  await page.getByTestId('void-ok').click();
  await approve(page, 'คุณสุดา');
  await expect(page.getByTestId('downstream')).toContainText('CN');
});

test('close the shift: a cash difference needs a note, then the Z report', async ({ page }) => {
  await login(page, 'prae');
  await page.goto('/pos');
  await page.getByTestId('shift-close').click();
  await page.getByTestId('den-1000').fill('2');
  await expect(page.getByTestId('counted')).toHaveText('฿2,000.00');
  await page.getByTestId('close-ok').click();
  await expect(page.getByRole('alert')).toContainText('ต้องใส่หมายเหตุ');
  await page.getByTestId('close-note').fill('ทอนเงินผิด');
  await page.getByTestId('close-ok').click();
  const z = page.getByTestId('z-report');
  await expect(z).toContainText('รายงานปิดกะ (Z)');
  await expect(z).toContainText('นับได้จริง');
  await page.getByTestId('z-done').click();
  await expect(page.getByTestId('shift-open')).toBeVisible();
});

test('stock: manual receipt with bill discount, transfer, issue shortage, adjust request approved, FIFO lots', async ({ page }) => {
  await login(page, 'charoen');
  await page.getByRole('link', { name: /คลังสินค้า/ }).click();
  await expect(page.getByTestId('stock-table').locator('tbody tr').first()).toBeVisible();

  await page.getByTestId('btn-gr').click();
  await page.getByTestId('gr-dn').fill('DO-E2E-1');
  await page.getByTestId('gr-inv').fill(`IV-E2E-${EDITION}`);
  await page.getByTestId('gr-p0').selectOption({ label: 'สีรองพื้นปูนใหม่ 9 ลิตร' });
  await page.getByTestId('gr-q0').fill('10');
  await page.getByTestId('gr-c0').fill('1000');
  await page.getByTestId('gr-bd').fill('500');
  await page.getByTestId('gr-save').click();
  await expect(page.getByText(/รับเข้าสต็อก GR\d{4}-\d{4} แล้ว/)).toBeVisible();

  await page.getByTestId('btn-tr').click();
  await page.getByTestId('sf-p0').selectOption({ label: 'สีรองพื้นปูนใหม่ 9 ลิตร' });
  await page.getByTestId('sf-q0').fill('2');
  await page.getByTestId('sf-save').click();
  await expect(page.getByText(/บันทึก TR\d{4}-\d{4} แล้ว/)).toBeVisible();

  await page.getByTestId('btn-iss').click();
  await page.getByTestId('sf-p0').selectOption({ label: 'สีรองพื้นปูนใหม่ 9 ลิตร' });
  await page.getByTestId('sf-q0').fill('500');
  await page.getByTestId('sf-save').click();
  await expect(page.getByTestId('shortage-table')).toContainText('สีรองพื้นปูนใหม่ 9 ลิตร');
  await page.getByRole('button', { name: 'ตกลง' }).click();
  // back on the form to fix the quantity; cancel instead
  await expect(page.getByTestId('sf-q0')).toHaveValue('500');
  await page.getByRole('button', { name: 'ยกเลิก' }).click();

  await page.getByTestId('btn-adj').click();
  await page.getByTestId('sf-p0').selectOption({ label: 'สีรองพื้นปูนใหม่ 9 ลิตร' });
  await page.getByTestId('sf-q0').fill('-1');
  await page.getByTestId('sf-save').click();
  await expect(page.getByText(/ส่งขออนุมัติปรับยอด/)).toBeVisible();
  const adj = page.getByTestId('adjust-table');
  await expect(adj).toContainText('รออนุมัติ');
  await adj.getByRole('button', { name: 'อนุมัติ', exact: true }).first().click();
  await expect(page.getByText(/อนุมัติแล้ว · ปรับสต็อก/)).toBeVisible();

  const row = page.getByTestId('stock-table').locator('tr', { hasText: 'สีรองพื้นปูนใหม่ 9 ลิตร' });
  await row.getByRole('button', { name: 'ล็อต' }).click();
  await expect(page.getByTestId('lots-table')).toContainText('ตัดก่อน');
  await expect(page.getByTestId('lots-table')).toContainText('950.00'); // 1000 − 500/10 bill discount in lot cost
});

test('products: create, search and cursor pagination (20 per page)', async ({ page, request }) => {
  await login(page, 'charoen');
  await page.getByRole('link', { name: /สินค้าและหน่วยนับ/ }).click();
  const rows = page.getByTestId('product-table').locator('tbody tr');
  await expect(rows).toHaveCount(12);
  await page.getByRole('button', { name: '+ เพิ่มสินค้า' }).click();
  await page.getByTestId('pf-sku').fill('E2E-00');
  await page.getByTestId('pf-name').fill('สินค้าทดสอบ e2e');
  await page.getByTestId('pf-price').fill('99');
  await page.getByTestId('pf-save').click();
  await expect(page.getByText('เพิ่มสินค้า E2E-00 แล้ว')).toBeVisible();

  const token = await apiToken(request, 'charoen');
  for (let i = 1; i <= 9; i++) {
    const r = await request.post('/api/products', {
      headers: { authorization: `Bearer ${token}` },
      data: { sku: `E2E-0${i}`, name: `สินค้าทดสอบ ${i}`, category: 'อื่น ๆ', isScg: false, kind: 'stock', vat: 'v7', price: '10.00', units: [{ name: 'ชิ้น', factor: '1' }], reorderPoint: '0' },
    });
    expect(r.status()).toBe(201);
  }
  await page.reload();
  await expect(rows).toHaveCount(20);
  await expect(page.getByText('หน้า 1')).toBeVisible();
  await page.getByRole('button', { name: 'ถัดไป ›' }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByText('หน้า 2')).toBeVisible();
  await expect(page.getByRole('button', { name: 'ถัดไป ›' })).toBeDisabled();
  await page.getByRole('button', { name: '‹ ก่อนหน้า' }).click();
  await expect(rows).toHaveCount(20);

  await page.getByTestId('product-search').fill('E2E-0');
  await expect(rows).toHaveCount(10);
  await expect(page.getByText('หน้า 1')).toBeVisible();
  await page.getByTestId('product-search').fill('ไม่มีสินค้านี้');
  await expect(page.getByTestId('product-table')).toContainText('ไม่พบสินค้า');
});
