/**
 * Stock workstream, both editions: a damaged return goes to the auto-created damaged-goods warehouse, reserved /
 * available show on the stock screen, a stock count is approved line by line with one line sent back to recount.
 * Data is created through the API, assertions go through the UI.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { EDITION, apiToken, login, logout, pick } from './helpers';

const DIR = path.join(__dirname, 'screenshots');
/** Keeps the A4 document in the page: window.print is stubbed, then the print media is emulated for the screenshot. */
async function printShot(page: Page, name: string) {
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 1000, height: 1300 });
  await page.screenshot({ path: path.join(DIR, `stock-${EDITION}-${name}.png`), fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 1300, height: 900 });
}
async function download(page: Page, button: ReturnType<Page['getByTestId']>) {
  const [dl] = await Promise.all([page.waitForEvent('download'), button.click()]);
  return { name: dl.suggestedFilename(), raw: readFileSync((await dl.path())!) };
}

async function call<T = any>(request: APIRequestContext, token: string, method: 'get' | 'post', url: string, data?: unknown): Promise<T> {
  const r = await request[method](url, { headers: { authorization: `Bearer ${token}` }, ...(data !== undefined ? { data } : {}) });
  const body = await r.json();
  expect(r.ok(), `${method.toUpperCase()} ${url} → ${r.status()} ${JSON.stringify(body).slice(0, 300)}`).toBeTruthy();
  return body as T;
}
const product = async (request: APIRequestContext, token: string, sku: string) =>
  (await call(request, token, 'get', `/api/products?q=${sku}&limit=1`)).items[0] as { id: string; name: string };

test.describe.configure({ mode: 'serial' });

let owner = '';
let backWh = '';
test.beforeAll(async ({ request }) => {
  owner = await apiToken(request, 'charoen');
  const whs = (await call(request, owner, 'get', '/api/warehouses')).items as { id: string; isPos: boolean; active: boolean; kind?: string }[];
  backWh = whs.find((w) => !w.isPos && w.active && w.kind !== 'damaged')!.id;
});

test('damaged return line goes to the auto-created คลังสินค้าชำรุด, not back to sellable stock', async ({ page, request }) => {
  const boy = await apiToken(request, 'boy');
  const pvc = await product(request, owner, 'PVC-4-85');
  const customers = (await call(request, owner, 'get', '/api/customers?limit=20')).items as { id: string; code: string }[];
  const inv = await call(request, boy, 'post', '/api/sales/invoices', {
    source: 'direct', customerId: customers.find((c) => c.code === 'C00002')!.id, warehouseId: backWh,
    lines: [{ productId: pvc.id, qty: '3', unitPrice: '83.18' }], payments: [{ method: 'transfer', amount: '267.01' }],
  });
  const before = (await call(request, owner, 'get', `/api/stock?productId=${pvc.id}&warehouseId=${backWh}`)).items[0].qty;

  await login(page, 'suda');
  await page.goto('/returns');
  await page.getByTestId('new-return').click();
  await page.getByTestId('bill-search').fill(inv.doc.no);
  await page.getByTestId('bill-search').press('Enter');
  await expect(page.getByTestId('bill-selected')).toContainText(inv.doc.no);
  await page.getByTestId('rq-0').fill('2');
  await page.getByTestId('rc-0').selectOption('damaged');
  await expect(page.getByTestId('ret-damaged-note')).toBeVisible();
  await page.getByTestId('ret-refund').selectOption('transfer');
  await page.getByTestId('ret-note').fill('ท่อแตกจากการขนส่ง');
  await page.getByTestId('ret-save').click();
  await expect(page.getByTestId('cn-no')).toHaveText(/^CN\d{4}-\d{4}$/);

  const dmg = (await call(request, owner, 'get', '/api/warehouses?kind=damaged')).items;
  expect(dmg).toMatchObject([{ name: 'คลังสินค้าชำรุด', kind: 'damaged', system: true, isPos: false }]);
  expect((await call(request, owner, 'get', `/api/stock?productId=${pvc.id}&warehouseId=${backWh}`)).items[0].qty).toBe(before);
  expect((await call(request, owner, 'get', `/api/stock?productId=${pvc.id}&warehouseId=${dmg[0].id}`)).items[0].qty).toBe('2');

  await page.goto('/stock');
  await expect(page.getByTestId('stock-table').locator('thead')).toContainText('คลังสินค้าชำรุด');
  await expect(page.getByTestId('stock-table').locator('thead')).toContainText('ไม่นับเป็นสต็อกขาย');
});

test('reserved and available show on the stock screen and in the ledger', async ({ page, request }) => {
  const boy = await apiToken(request, 'boy');
  const ta = await product(request, owner, 'SCG-TA-20');
  const customers = (await call(request, owner, 'get', '/api/customers?limit=20')).items as { id: string; code: string }[];
  const row0 = (await call(request, owner, 'get', `/api/stock?productId=${ta.id}&warehouseId=${backWh}`)).items[0];
  await call(request, boy, 'post', '/api/sales/orders', { customerId: customers.find((c) => c.code === 'C00001')!.id, warehouseId: backWh, lines: [{ productId: ta.id, qty: '7', unitPrice: '196.26' }] });
  const row = (await call(request, owner, 'get', `/api/stock?productId=${ta.id}&warehouseId=${backWh}`)).items[0];
  expect(Number(row.reserved)).toBe(Number(row0.reserved) + 7);

  await login(page, 'charoen');
  await page.goto('/stock');
  await page.getByLabel('ค้นหาสต็อก').fill('SCG-TA-20');
  const tr = page.getByTestId('stock-table').locator(`tr[data-product="${ta.id}"]`);
  await expect(tr.getByTestId('stk-reserved')).not.toHaveText('-');
  await expect(tr).toContainText('จอง');
  await page.goto(`/stock-ledger?productId=${ta.id}`);
  await expect(page.getByTestId('ledger-balance')).toContainText('จอง');
  await expect(page.getByTestId('ledger-balance')).toContainText('พร้อมขาย');
});

test('stock count: approve one line, send the other back to recount, recount closes it', async ({ page, request }) => {
  const chai = await apiToken(request, 'chai');
  const suda = await apiToken(request, 'suda');
  const sand = await product(request, owner, 'SAND-C');
  const stone = await product(request, owner, 'STONE-34');
  const c = await call(request, chai, 'post', '/api/stock-counts', { warehouseId: backWh, category: 'วัสดุมวลรวม', note: 'e2e นับบางหมวด' });
  const sys = await call(request, suda, 'get', `/api/stock-counts/${c.id}?showSystem=true`);
  const q = (pid: string) => Number(sys.items.find((i: { productId: string }) => i.productId === pid).systemQty);
  await call(request, chai, 'post', `/api/stock-counts/${c.id}/entries`, { productId: sand.id, qty: String(q(sand.id) + 1) });
  await call(request, chai, 'post', `/api/stock-counts/${c.id}/entries`, { productId: stone.id, qty: String(Math.max(0, q(stone.id) - 1)) });
  await call(request, chai, 'post', `/api/stock-counts/${c.id}/submit`);

  await login(page, 'suda');
  await page.goto(`/stock-count?no=${c.no}`);
  await expect(page.getByTestId('count-sheet')).toContainText('รออนุมัติ');
  await page.getByTestId('count-decide').click();
  await page.getByTestId('dec-recount-SAND-C').check();
  await page.getByTestId('dec-note').fill('ทรายดูแปลก นับใหม่');
  await page.getByTestId('dec-save').click();
  await expect(page.getByText(/อนุมัติแล้ว · ปรับสต็อก ADJ\d{4}-\d{4} · สั่งนับใหม่ 1 รายการ/)).toBeVisible();
  const sheet = page.getByTestId('count-sheet');
  await expect(sheet.locator('tr[data-state="approved"]')).toContainText('หิน 3/4');
  await expect(sheet.locator('tr[data-state="counting"]')).toContainText('ทรายหยาบ');
  await expect(sheet.locator('tr[data-state="counting"]')).toContainText('นับครั้งก่อน');
  await logout(page);

  // the counter recounts only the sent-back line
  await login(page, 'chai');
  await page.goto(`/stock-count?no=${c.no}`);
  await expect(page.getByTestId('count-q-STONE-34')).toHaveCount(0);
  await page.getByTestId('count-q-SAND-C').fill(String(q(sand.id)));
  await page.getByTestId('count-q-SAND-C').blur();
  await expect(page.getByTestId('count-sheet').locator('tr[data-state="counting"]')).toContainText('พี่ชัย');
  page.once('dialog', (dlg) => void dlg.accept());
  await page.getByTestId('count-submit').click();
  await expect(page.getByText('นับตรงทุกรายการ')).toBeVisible();
  await expect(page.getByTestId('count-sheet').locator('tr[data-state="counting"]')).toHaveCount(0);
});

test('stock and ledger export to Excel / CSV for the picked products and warehouses', async ({ page, request }) => {
  const cement = await product(request, owner, 'SCG-CEM-T50');
  await login(page, 'suda');
  await page.goto('/stock');
  await page.getByTestId('btn-stock-export').click();
  await pick(page, 'exp-product', cement.name, 'SCG-CEM-T50');
  await expect(page.getByTestId('exp-products')).toContainText(cement.name);
  await page.getByTestId('exp-wh-all').uncheck();
  await page.getByTestId('exp-wh-WH2').check();
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.screenshot({ path: path.join(DIR, `stock-${EDITION}-export-modal-1300.png`) });
  const csv = await download(page, page.getByTestId('exp-csv'));
  expect(csv.name).toMatch(/^stock-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = csv.raw.toString('utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  expect(lines[0]).toContain('พร้อมขาย');
  expect(lines[0]).toContain('มูลค่าคงเหลือ');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('SCG-CEM-T50');

  await page.goto(`/stock-ledger?productId=${cement.id}`);
  await page.getByTestId('btn-ledger-export').click();
  await expect(page.getByTestId('exp-products')).toContainText(cement.name);
  const xlsx = await download(page, page.getByTestId('exp-xlsx'));
  expect(xlsx.name).toMatch(/^stock-ledger-.+\.xlsx$/);
  expect(xlsx.raw.subarray(0, 2).toString()).toBe('PK');
});

test('stock count prints the count order and the result with the counters and the approver', async ({ page, request }) => {
  const chai = await apiToken(request, 'chai');
  const sand = await product(request, owner, 'SAND-C');
  const c = await call(request, chai, 'post', '/api/stock-counts', { warehouseId: backWh, category: 'วัสดุมวลรวม', note: 'e2e พิมพ์ใบนับ' });

  await login(page, 'chai');
  await page.addInitScript(() => { window.print = () => {}; });
  await page.goto(`/stock-count?no=${c.no}`);
  await page.getByTestId('count-print-order').click();
  const doc = page.getByTestId('a4-doc');
  await expect(doc).toContainText('ใบสั่งนับสต็อก');
  await expect(doc).toContainText(c.no);
  await expect(doc).toContainText(sand.name);
  await expect(doc.locator('th', { hasText: 'จำนวนที่นับได้' })).toHaveCount(1);
  await expect(doc.locator('th', { hasText: 'ตามระบบ' })).toHaveCount(0);
  await expect(doc).toContainText('ผู้สั่งนับ');
  await printShot(page, 'count-order-print');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(doc).toHaveCount(0);

  const sys = await call(request, owner, 'get', `/api/stock-counts/${c.id}?showSystem=true`);
  const q = Number(sys.items.find((i: { productId: string }) => i.productId === sand.id).systemQty);
  await call(request, chai, 'post', `/api/stock-counts/${c.id}/entries`, { productId: sand.id, qty: String(q + 2) });
  await call(request, chai, 'post', `/api/stock-counts/${c.id}/submit`);
  await logout(page);

  await login(page, 'suda');
  await page.goto(`/stock-count?no=${c.no}`);
  await page.getByTestId('count-decide').click();
  await page.getByTestId('dec-save').click();
  await expect(page.getByText(/อนุมัติแล้ว/)).toBeVisible();
  await page.getByTestId('count-print-result').click();
  await expect(doc).toContainText('ใบรายงานผลการนับสต็อก');
  await expect(doc).toContainText('พี่ชัย');
  await expect(doc).toContainText('คุณสุดา ศรีสุข');
  await expect(doc).toContainText('อนุมัติปรับยอด');
  await expect(doc.locator('.a4-signs')).toContainText('ผู้นับ');
  await expect(doc.locator('.a4-signs')).toContainText('ผู้อนุมัติ');
  await printShot(page, 'count-result-print');
});
