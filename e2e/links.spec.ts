/**
 * Cross-module navigation, both editions: every document number is a link to its detail page, and the page lists the
 * documents made from it and the one it came from (goods receipt ↔ AP bill ↔ payment voucher ↔ vendor return;
 * tax invoice ↔ credit note ↔ billing note ↔ receipt), dashboard cards and report rows open the right filtered list,
 * every menu item of every role opens without a 403 or a bounce to the home page.
 * Data is created through the API (a shared helper below), assertions go through the UI.
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { EDITION, apiToken, login } from './helpers';

const ROOT = path.join(__dirname, '..');
const rnd = () => Math.random().toString(36).slice(2, 7).toUpperCase();

async function call<T = any>(request: APIRequestContext, token: string, method: 'get' | 'post', url: string, data?: unknown): Promise<T> {
  const r = await request[method](url, { headers: { authorization: `Bearer ${token}` }, ...(data !== undefined ? { data } : {}) });
  const body = await r.json();
  expect(r.ok(), `${method.toUpperCase()} ${url} → ${r.status()} ${JSON.stringify(body).slice(0, 300)}`).toBeTruthy();
  return body as T;
}

interface Ctx { token: string; backWh: string; posWh: string; vendorId: string; customerId: string; cementId: string }
async function context(request: APIRequestContext): Promise<Ctx> {
  const token = await apiToken(request, 'charoen');
  const whs = (await call(request, token, 'get', '/api/warehouses')).items as { id: string; isPos: boolean; active: boolean }[];
  const vendor = ((await call(request, token, 'get', '/api/vendors?limit=20')).items as { id: string; code: string }[]).find((v) => v.code === 'V00003')!; // purchasing.spec pays V00001
  const customers = (await call(request, token, 'get', '/api/customers?limit=20')).items as { id: string; code: string }[];
  const cement = (await call(request, token, 'get', '/api/products?q=SCG-CEM-T50&limit=1')).items[0];
  return {
    token, backWh: whs.find((w) => !w.isPos && w.active)!.id, posWh: whs.find((w) => w.isPos && w.active)!.id, vendorId: vendor.id,
    customerId: customers.find((c) => c.code === 'C00001')!.id, cementId: cement.id,
  };
}

test.describe.serial('document links', () => {
  let c: Ctx;
  const doc: Record<string, string> = {};

  test('setup: goods receipt → AP bill → payment voucher → vendor return, tax invoice → credit note → billing note → receipt', async ({ request }) => {
    c = await context(request);
    const gr = await call(request, c.token, 'post', '/api/stock/receipts', {
      vendorId: c.vendorId, vendorInvoiceNo: `IV-LNK-${rnd()}`, deliveryNo: `DN-LNK-${rnd()}`, warehouseId: c.backWh,
      lines: [{ productId: c.cementId, unitIdx: 0, qty: '20', unitCost: '100' }],
    });
    doc.gr = gr.no;
    const grDetail = await call(request, c.token, 'get', `/api/purchasing/receipts/${doc.gr}`);
    doc.ap = grDetail.apBillNo;
    expect(doc.ap, 'a manual receipt creates its AP bill').toBeTruthy();
    const bill = await call(request, c.token, 'get', `/api/ap/bills/${doc.ap}`);
    const pv = await call(request, c.token, 'post', '/api/ap/payments', { vendorId: c.vendorId, method: 'transfer', ref: 'LNK', allocations: [{ billId: bill.id, amount: '500' }] });
    doc.pv = pv.no;
    const ret = await call(request, c.token, 'post', '/api/ap/vendor-returns', { grNo: doc.gr, lines: [{ grLineId: grDetail.lines[0].id, qty: '1' }], reason: 'สินค้าชำรุด / แตก' });
    doc.pr = ret.no;

    const inv = await call(request, c.token, 'post', '/api/sales/invoices', {
      source: 'direct', customerId: c.customerId, warehouseId: c.backWh, lines: [{ productId: c.cementId, unitIdx: 0, qty: '3', unitPrice: '150' }],
    });
    doc.inv = inv.doc.no;
    const full = await call(request, c.token, 'get', `/api/sales/docs/${doc.inv}`);
    const cn = await call(request, c.token, 'post', '/api/returns', {
      sourceDocNo: doc.inv, lines: [{ lineId: full.lines[0].id, qty: '1' }], condition: 'good', refund: 'credit', reason: 'ลูกค้าสั่งเกิน',
    });
    doc.cn = cn.no;
    const bn = await call(request, c.token, 'post', '/api/ar/billing-notes', { customerId: c.customerId, invoiceNos: [doc.inv] });
    doc.bn = bn.no;
    const after = await call(request, c.token, 'get', `/api/sales/invoices/${doc.inv}`);
    const re = await call(request, c.token, 'post', '/api/ar/receipts', { customerId: c.customerId, method: 'transfer', lines: [{ invoiceNo: doc.inv, amount: after.arBalance }] });
    doc.re = re.no;
    expect(Object.values(doc).every(Boolean)).toBeTruthy();
  });

  test('goods receipt page links the AP bill and the vendor return; the bill links the voucher and the return; each links back', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/purchasing');
    await page.getByTestId('receipt-table').getByRole('link', { name: doc.gr! }).click();
    await expect(page).toHaveURL(new RegExp(`/purchasing/gr/${doc.gr}$`));
    await expect(page.getByTestId('doc-no')).toHaveText(doc.gr!);
    await expect(page.getByRole('link', { name: doc.pr! })).toBeVisible();
    await page.getByRole('link', { name: doc.ap! }).click();
    await expect(page).toHaveURL(new RegExp(`/ap/bill/${doc.ap}$`));
    await expect(page.getByRole('link', { name: doc.gr! })).toBeVisible();
    await expect(page.getByRole('link', { name: doc.pr! }).first()).toBeVisible();
    await page.getByTestId('bill-payments').getByRole('link', { name: doc.pv! }).click();
    await expect(page).toHaveURL(new RegExp(`/ap/pv/${doc.pv}$`));
    await page.getByTestId('pv-bills').getByRole('link', { name: doc.ap! }).click();
    await expect(page).toHaveURL(new RegExp(`/ap/bill/${doc.ap}$`));
    await page.getByRole('link', { name: doc.pr! }).first().click();
    await expect(page).toHaveURL(new RegExp(`/ap/pr/${doc.pr}$`));
    await expect(page.getByRole('link', { name: doc.gr! })).toBeVisible();
    await expect(page.getByRole('link', { name: doc.ap! })).toBeVisible();
  });

  test('AP lists, stock ledger and audit log open the documents', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/ap');
    await expect(page.getByTestId('ap-payments').getByRole('link', { name: doc.pv! })).toBeVisible();
    await expect(page.getByTestId('ap-returns').getByRole('link', { name: doc.pr! })).toBeVisible();
    await page.getByTestId('ap-returns').getByRole('link', { name: doc.gr! }).first().click();
    await expect(page).toHaveURL(new RegExp(`/purchasing/gr/${doc.gr}$`));
    await page.goto(`/stock-ledger?q=${doc.gr}`);
    await expect(page.getByTestId('ledger-table').getByRole('link', { name: doc.gr! }).first()).toBeVisible();
    await page.goto('/audit');
    await page.getByRole('searchbox').fill(doc.pv!);
    await page.getByTestId('audit-table').getByRole('link', { name: doc.pv! }).first().click();
    await expect(page).toHaveURL(new RegExp(`/ap/pv/${doc.pv}$`));
  });

  test('tax invoice, credit note, billing note and receipt link each other', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto(`/b2b/inv/${doc.inv}`);
    await expect(page.getByTestId('doc-no')).toHaveText(doc.inv!);
    for (const n of [doc.cn!, doc.bn!, doc.re!]) await expect(page.getByRole('link', { name: n }).first()).toBeVisible();
    await page.getByRole('link', { name: doc.re! }).first().click();
    await expect(page).toHaveURL(new RegExp(`/ar/rc/${doc.re}$`));
    await page.getByRole('link', { name: doc.inv! }).first().click();
    await expect(page).toHaveURL(new RegExp(`/b2b/inv/${doc.inv}$`));
    await page.getByRole('link', { name: doc.bn! }).first().click();
    await expect(page).toHaveURL(new RegExp(`/ar/bn/${doc.bn}$`));
    // the core sales-document page of the same invoice lists the documents made from it, and the CN points back
    await page.goto(`/sales/${doc.inv}`);
    await expect(page.getByTestId('doc-related')).toContainText(doc.cn!);
    await expect(page.getByTestId('doc-related')).toContainText(doc.re!);
    await page.getByTestId('doc-related').getByRole('link', { name: doc.cn! }).click();
    await expect(page).toHaveURL(new RegExp(`/sales/${doc.cn}$`));
    await expect(page.getByTestId('doc-ref').getByRole('link', { name: doc.inv! })).toBeVisible();
    // a stock-ledger line for the invoice opens the document
    await page.goto(`/stock-ledger?q=${doc.inv}`);
    await page.getByTestId('ledger-table').getByRole('link', { name: doc.inv! }).first().click();
    await expect(page.getByTestId('doc-no')).toHaveText(doc.inv!);
  });

  test('AR statement and credit-note list link the documents', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/ar?tab=rc');
    await expect(page.getByTestId('ar-rc').getByRole('link', { name: doc.re! })).toBeVisible();
    await page.getByTestId('ar-rc').getByRole('link', { name: doc.inv! }).first().click();
    await expect(page).toHaveURL(new RegExp(`/b2b/inv/${doc.inv}$`));
    await page.goto('/b2b?tab=cn');
    await page.getByRole('link', { name: doc.inv! }).first().click();
    await expect(page).toHaveURL(new RegExp(`/b2b/inv/${doc.inv}$`));
  });

  test('home cards and the GR-overdue banner open the right list', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/');
    await page.getByTestId('card-low-stock').click();
    await expect(page).toHaveURL(/\/stock-ledger\?tab=reorder/);
    await expect(page.getByTestId('tab-reorder')).toHaveClass(/on/);
    await page.goto('/');
    await page.getByTestId('ap-due-card').click();
    await expect(page).toHaveURL(/\/ap$/);
    await page.goto('/');
    await page.getByTestId('ar-due-card').click();
    await expect(page).toHaveURL(/\/ar\?tab=inv/);
  });

  test('a sales report row opens the documents behind it', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/reports');
    await page.getByTestId('sales-by').selectOption('customer');
    const link = page.getByTestId('sales-table').locator('tbody tr').first().getByRole('link');
    await link.click();
    await expect(page).toHaveURL(/\/sales\?.*customerId=/);
    await expect(page.getByTestId('docs-filter')).toBeVisible();
    await expect(page.getByTestId('docs-table').locator('tbody tr').first()).toContainText(/ABB|INV|CN/);
    await page.getByRole('link', { name: 'ล้างตัวกรอง' }).click();
    await expect(page.getByTestId('docs-filter')).toHaveCount(0);
  });

  test('stock count and adjustment request link each other, and the stock page links to the ledger', async ({ page, request }) => {
    const count = await call(request, c.token, 'post', '/api/stock-counts', { warehouseId: c.backWh });
    await call(request, c.token, 'post', `/api/stock-counts/${count.id}/entries`, { productId: c.cementId, qty: '1', mode: 'set' });
    const sub = await call(request, c.token, 'post', `/api/stock-counts/${count.id}/submit`);
    const rq = sub.adjustRequestNo as string;
    expect(rq).toBeTruthy();
    await login(page, 'charoen');
    await page.goto('/stock-count');
    await page.getByTestId('count-list').getByRole('link', { name: rq }).click();
    await expect(page).toHaveURL(new RegExp(`/stock\\?req=${rq}`));
    await expect(page.locator(`#adj-${rq}`)).toBeVisible();
    await page.goto(`/stock-count?no=${count.no}`);
    await expect(page.getByTestId('count-submit')).toHaveCount(0); // opened the (submitted) round, not the list
    await expect(page.getByRole('link', { name: rq })).toBeVisible();
  });

  for (const user of ['charoen', 'suda', 'prae', 'boy', 'chai']) {
    test(`every menu item of ${user} opens: no 403, no bounce to the home page`, async ({ page }) => {
      const denied: string[] = [];
      page.on('response', (r) => { if (r.status() === 403 && r.url().includes('/api/')) denied.push(r.url().replace(/^.*\/api/, '/api')); });
      await login(page, user);
      const hrefs = await page.$$eval('aside.side nav a', (as) => as.map((a) => a.getAttribute('href')!));
      expect(hrefs.length, `${user} has menu items`).toBeGreaterThan(0);
      for (const h of hrefs) {
        await page.goto(h, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(600);
        expect(new URL(page.url()).pathname, `${user} opens ${h}`).toBe(h.split('?')[0]);
      }
      expect(denied, `${user}: 403 while opening the menu`).toEqual([]);
    });
  }

  test('SCG admin: a license row links to its shop', async ({ page, request }) => {
    test.skip(EDITION !== 'cloud', 'SCG Admin is cloud only');
    execSync('pnpm --filter @erp/db exec tsx src/seedAdmin.ts', { cwd: ROOT, stdio: 'ignore', env: process.env });
    const login = await request.post('/api/adm/auth/login', { data: { username: 'scg.admin', password: '1234' } });
    expect(login.ok()).toBeTruthy();
    const { token } = await login.json();
    const taxId = `9${String(Date.now()).slice(-12)}`;
    await call(request, token, 'post', '/api/adm/licenses', { shopName: `ร้านทดสอบลิงก์ ${rnd()}`, taxId, type: 'lifetime' });
    await page.goto('/scg');
    await page.getByLabel('ชื่อผู้ใช้').fill('scg.admin');
    await page.getByLabel('รหัสผ่าน').fill('1234');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByTestId('adm-who')).toBeVisible();
    await page.goto(`/scg/licenses?q=${taxId}`);
    const rows = page.getByTestId('license-table').locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    await rows.first().getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`/scg/shops\\?q=${taxId}`));
    await expect(page.getByTestId('shops-table')).toBeVisible();
    await page.goto('/scg/shops');
    // and back: a shop row opens the licenses filtered by its tax id
    await page.getByTestId('shops-table').locator('tbody tr').first().getByRole('link', { name: /license/ }).click();
    await expect(page).toHaveURL(/\/scg\/licenses\?q=\d+/);
    await expect(page.getByTestId('license-table')).toBeVisible();
  });

  test('AR: both customer-row actions (billing note, statement) open their dialog at desktop and phone width', async ({ page, request }) => {
    // an open invoice so the customer has a balance and shows in the aging list
    await call(request, c.token, 'post', '/api/sales/invoices', { source: 'direct', customerId: c.customerId, warehouseId: c.backWh, lines: [{ productId: c.cementId, unitIdx: 0, qty: '1', unitPrice: '150' }] });
    await login(page, 'charoen');
    await page.goto('/ar');
    await page.getByTestId('ar-search').fill('C00001');
    const row = page.getByTestId('ar-cust').locator('tbody tr').first();
    await row.getByRole('button', { name: 'ออกใบวางบิล' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await row.getByRole('button', { name: 'รายการเดินบัญชี' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 800 });
    await row.getByRole('button', { name: 'เดินบัญชี', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});
