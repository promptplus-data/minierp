/**
 * Finance additions, both editions: ปรับปรุงต้นทุน (owner lock, request, approval), มัดจำซื้อ + รับวางบิลซื้อ paid in
 * one voucher, รับเงินมัดจำ / เงินล่วงหน้า (any customer) used on an invoice and returned, ขอลดหนี้ขาย with approval.
 * Setup data through the API, the features through the UI. Screenshots e2e/screenshots/finance-<edition>-*.png.
 */
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { EDITION, apiToken, login, logout, pick } from './helpers';

const DIR = path.join(__dirname, 'screenshots');
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
async function shot(page: Page, name: string, w = 1300) {
  await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(DIR, `finance-${EDITION}-${name}-${w}.png`) });
}
async function call<T = any>(request: APIRequestContext, token: string, method: 'get' | 'post' | 'patch', url: string, data?: unknown): Promise<T> {
  const r = await request[method](url, { headers: { authorization: `Bearer ${token}` }, ...(data !== undefined ? { data } : {}) });
  const body = await r.json();
  expect(r.ok(), `${method.toUpperCase()} ${url} → ${r.status()} ${JSON.stringify(body).slice(0, 300)}`).toBeTruthy();
  return body as T;
}

test.describe.configure({ mode: 'serial' });

test('ปรับปรุงต้นทุน: locked by default, the owner opens it, a manager asks, the owner approves', async ({ page, request }) => {
  const owner = await apiToken(request, 'charoen');
  await call(request, owner, 'patch', '/api/stock/cost-adjustments/settings', { enabled: false });
  await login(page, 'suda');
  await page.goto('/stock-ledger?tab=cost');
  await expect(page.getByTestId('cost-lock')).toContainText('ปิด (ล็อก)');
  await expect(page.getByTestId('btn-cost-adj')).toBeDisabled();
  await logout(page);

  await login(page, 'charoen');
  await page.goto('/stock-ledger?tab=cost');
  await page.getByTestId('cost-toggle').click();
  await expect(page.getByTestId('cost-lock')).toContainText('เปิดให้ปรับปรุงต้นทุน');
  await logout(page);

  await login(page, 'suda');
  await page.goto('/stock-ledger?tab=cost');
  await page.getByTestId('btn-cost-adj').click();
  await pick(page, 'ca-product', 'อิฐมวลเบา', 'อิฐมวลเบา');
  await page.getByTestId('ca-cost').fill('20.25');
  await page.getByTestId('ca-reason').fill(`ราคาทุนจริงจากใบแจ้งหนี้ ${RUN}`);
  await shot(page, 'cost-adj-form');
  await page.getByTestId('ca-save').click();
  await expect(page.getByText(/ส่งคำขอ CA\d{4}-\d{4} รออนุมัติ/)).toBeVisible();
  await logout(page);

  await login(page, 'charoen');
  await page.goto('/');
  await expect(page.getByTestId('card-approvals')).toContainText('ขอปรับปรุงต้นทุน');
  await page.goto('/stock-ledger?tab=cost');
  const row = page.getByTestId('cost-adj-table').locator('tbody tr', { hasText: RUN });
  await row.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  await expect(page.getByText(/อนุมัติ CA\d{4}-\d{4} · มูลค่าสต็อกเปลี่ยน/)).toBeVisible();
  await expect(row).toContainText('อนุมัติแล้ว');
  await shot(page, 'cost-adj');
  await page.getByRole('button', { name: /ความเคลื่อนไหว/ }).click();
  await expect(page.getByTestId('ledger-table').locator('tbody tr').first()).toContainText('ปรับปรุงต้นทุน');
  await page.getByTestId('tab-cost').click();
  await page.getByTestId('cost-toggle').click(); // lock again
  await expect(page.getByTestId('cost-lock')).toContainText('ปิด (ล็อก)');
});

test('มัดจำซื้อ and รับวางบิลซื้อ: pay the billing note and take off the deposit in one voucher', async ({ page, request }) => {
  const suda = await apiToken(request, 'suda');
  const vendors = (await call(request, suda, 'get', '/api/vendors?limit=50')).items as { id: string; name: string }[];
  const v = vendors.find((x) => x.name.includes('ทวีพัฒนา'))!;
  const products = (await call(request, suda, 'get', '/api/products?q=SAND-C&limit=1')).items as { id: string }[];
  const whs = (await call(request, suda, 'get', '/api/warehouses')).items as { id: string; isPos: boolean; active: boolean; kind?: string }[];
  const wh = whs.find((w) => !w.isPos && w.active && w.kind !== 'damaged')!;
  for (const inv of [`VB${RUN}A`, `VB${RUN}B`]) {
    await call(request, suda, 'post', '/api/stock/receipts', { vendorId: v.id, vendorInvoiceNo: inv, deliveryNo: `DN-${inv}`, warehouseId: wh.id, lines: [{ productId: products[0]!.id, unitIdx: 0, qty: '2', unitCost: '500' }] });
  }

  await login(page, 'suda');
  await page.goto('/ap');
  await page.getByTestId('btn-ap-deposit').click();
  await page.getByTestId('apdep-vendor').selectOption({ label: v.name });
  await page.getByTestId('apdep-amount').fill('300');
  await page.getByTestId('apdep-note').fill(`มัดจำ ${RUN}`);
  await page.getByTestId('apdep-save').click();
  await expect(page.getByText(/บันทึกมัดจำซื้อ PD\d{4}-\d{4} แล้ว/)).toBeVisible();

  await page.getByTestId('btn-ap-vb').click();
  await page.getByTestId('vb-vendor').selectOption({ label: v.name });
  await page.getByTestId(`vb-pick-VB${RUN}A`).check();
  await page.getByTestId(`vb-pick-VB${RUN}B`).check();
  await page.getByTestId('vb-docno').fill(`BL-${RUN}`);
  await page.getByTestId('vb-due').fill('2026-12-25');
  await shot(page, 'ap-billing-note-form');
  await page.getByTestId('vb-save').click();
  await expect(page.getByText(/บันทึกรับวางบิล VB\d{4}-\d{4} แล้ว/)).toBeVisible();
  const vbRow = page.getByTestId('ap-vb').locator('tbody tr', { hasText: `BL-${RUN}` });
  await expect(vbRow).toContainText('2,140.00');

  await vbRow.getByRole('button', { name: 'จ่ายตามใบวางบิล' }).click();
  await expect(page.getByTestId('pay-bills').locator('tbody tr')).toHaveCount(2);
  const dep = page.getByTestId('pay-deposits').locator('tbody tr', { hasText: '300.00' }).first();
  await dep.locator('input[type=checkbox]').check();
  await expect(page.getByTestId('pay-net')).toHaveText('฿1,840.00');
  await shot(page, 'ap-pay-deposit');
  await page.getByTestId('pay-save').click();
  await expect(page.getByText(/บันทึกจ่าย PV\d{4}-\d{4} · จ่ายจริง ฿1,840.00/)).toBeVisible();
  await page.locator('select[aria-label="สถานะใบรับวางบิล"]').selectOption('all');
  await expect(page.getByTestId('ap-vb').locator('tbody tr', { hasText: `BL-${RUN}` })).toContainText('จ่ายครบ');
  await expect(page.getByTestId('ap-payments')).toContainText('หักมัดจำ 300.00');
  await page.getByTestId('ap-vb').scrollIntoViewIfNeeded();
  await shot(page, 'ap-billing-notes');
});

test('รับเงินมัดจำ / เงินล่วงหน้า for any customer: used on an invoice, the rest of the advance returned', async ({ page, request }) => {
  const boy = await apiToken(request, 'boy');
  await login(page, 'boy');
  await page.goto('/b2b?tab=dp');
  await page.getByTestId('new-deposit').click();
  await pick(page, 'dep-customer', 'รุ่งเรือง');
  await page.getByTestId('dep-type-advance').check();
  await page.getByTestId('dep-amount').fill('1070');
  await page.getByTestId('dep-note').fill(`ล่วงหน้า ${RUN}`);
  await shot(page, 'deposit-form');
  await page.getByTestId('dep-save').click();
  await expect(page.getByText(/รับเงินล่วงหน้า DP\d{4}-\d{4} · ออกใบกำกับ INV\d{4}-\d{4}/)).toBeVisible();
  const row = page.getByTestId('deposit-table').locator('tbody tr', { hasText: '1,070.00' }).first();
  const no = (await row.locator('td').first().innerText()).match(/DP\d{4}-\d{4}/)![0];

  // the invoice form offers the customer's open deposits
  await page.getByTestId('new-inv').click();
  await pick(page, 'doc-customer', 'รุ่งเรือง');
  await expect(page.getByTestId('deposit-picker')).toContainText(no);
  await pick(page, 'line-product-0', 'ทรายหยาบ', 'ทรายหยาบ');
  await expect(page.getByTestId('doc-total')).not.toHaveText('฿0.00');
  await page.getByTestId(`use-dep-${no}`).check();
  await expect(page.getByTestId('deposit-due')).toBeVisible();
  await page.getByTestId('deposit-picker').scrollIntoViewIfNeeded();
  await shot(page, 'invoice-deposit-picker');
  await page.keyboard.press('Escape');

  const customers = (await call(request, boy, 'get', '/api/customers?limit=20')).items as { id: string; code: string }[];
  const products = (await call(request, boy, 'get', '/api/products?q=SAND-C&limit=1')).items as { id: string }[];
  const whs = (await call(request, boy, 'get', '/api/warehouses')).items as { id: string; isPos: boolean; active: boolean; kind?: string }[];
  const inv = await call(request, boy, 'post', '/api/sales/invoices', {
    source: 'direct', customerId: customers.find((c) => c.code === 'C00001')!.id, warehouseId: whs.find((w) => !w.isPos && w.active && w.kind !== 'damaged')!.id,
    lines: [{ productId: products[0]!.id, qty: '1', unitPrice: '650' }], deposits: [{ no, amount: '535' }],
  });
  expect(inv.depositType).toBe('advance');
  await page.goto(`/b2b/inv/${inv.doc.no}`);
  await expect(page.getByTestId('paper')).toContainText('หักเงินรับล่วงหน้า');
  await logout(page);

  await login(page, 'suda');
  await page.goto('/b2b?tab=dp');
  await page.getByTestId(`dep-refund-${no}`).click();
  await page.getByTestId('dep-refund-reason').fill('ลูกค้าไม่รับของส่วนที่เหลือ');
  await page.getByTestId('dep-refund-ok').click();
  await expect(page.getByText(new RegExp(`คืนเงินล่วงหน้า ${no} · ออกใบลดหนี้ CN\\d{4}-\\d{4}`))).toBeVisible();
  await expect(page.getByTestId(`dep-row-${no}`)).toContainText('คืนแล้ว');
  await shot(page, 'deposits');
});

test('ขอลดหนี้ขาย: asked from the invoice, approved by the manager, the credit note lowers the balance', async ({ page, request }) => {
  const boy = await apiToken(request, 'boy');
  const customers = (await call(request, boy, 'get', '/api/customers?limit=20')).items as { id: string; code: string }[];
  const products = (await call(request, boy, 'get', '/api/products?q=SAND-C&limit=1')).items as { id: string }[];
  const whs = (await call(request, boy, 'get', '/api/warehouses')).items as { id: string; isPos: boolean; active: boolean; kind?: string }[];
  const inv = await call(request, boy, 'post', '/api/sales/invoices', {
    source: 'direct', customerId: customers.find((c) => c.code === 'C00002')!.id, warehouseId: whs.find((w) => !w.isPos && w.active && w.kind !== 'damaged')!.id,
    lines: [{ productId: products[0]!.id, qty: '2', unitPrice: '650' }],
  });
  const before = Number(inv.arBalance);

  await login(page, 'boy');
  await page.goto(`/b2b/inv/${inv.doc.no}`);
  await page.getByTestId('inv-cn-request').click();
  await page.getByTestId('cr-amount').fill('107');
  await page.getByTestId('cr-note').fill(`โทรคุยกับลูกค้า ${RUN}`);
  await shot(page, 'cn-request-form');
  await page.getByTestId('cr-save').click();
  await expect(page.getByText(/ส่งคำขอ CR\d{4}-\d{4} รออนุมัติ/)).toBeVisible();
  await logout(page);

  await login(page, 'suda');
  await page.goto('/ar?tab=cr');
  const row = page.getByTestId('cn-request-table').locator('tbody tr', { hasText: inv.doc.no });
  await expect(row).toContainText('รออนุมัติ');
  await row.getByRole('button', { name: 'อนุมัติ', exact: true }).click();
  await expect(page.getByText(/อนุมัติ CR\d{4}-\d{4} · ออกใบลดหนี้ CN\d{4}-\d{4}/)).toBeVisible();
  await expect(row).toContainText('ออกใบลดหนี้แล้ว');
  await shot(page, 'cn-requests');
  await page.goto(`/b2b/inv/${inv.doc.no}`);
  await expect(page.getByTestId('inv-balance')).toHaveText((before - 107).toLocaleString('en-US', { minimumFractionDigits: 2 }));
});
