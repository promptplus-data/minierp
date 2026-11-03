/**
 * Group A browser flows (M08 / M09 / M10) on a freshly seeded shop, both editions:
 * quotation with a free-text line → sales order (map the line) → two partial delivery orders → one tax invoice;
 * credit approval with the owner's PIN; billing note and receipt with 3 % WHT; project with 50/50 → 30/40/30,
 * deposit, delivery, installment bill and a variation order; void blocked by downstream documents;
 * screenshots at 1300 / 390 px. Serial: later tests use documents made by earlier ones.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import path from 'node:path';
import { EDITION, PP, approve, login } from './helpers';

test.describe.configure({ mode: 'serial' });

const DIR = path.join(__dirname, 'screenshots');
const docs = { qt: '', so: '', do1: '', do2: '', inv: '', bn: '', rc: '', soCredit: '', project: '' };

/** Select the option whose text contains `contains`. */
async function pick(sel: Locator, contains: string) {
  await expect(sel.locator('option').filter({ hasText: contains }).first()).toBeAttached();
  const opts = await sel.locator('option').allTextContents();
  const hit = opts.find((o) => o.includes(contains));
  if (!hit) throw new Error(`"${contains}" not in ${opts.join(' | ')}`);
  await sel.selectOption({ label: hit });
}

async function docNo(page: Page, kind: string): Promise<string> {
  await expect(page).toHaveURL(new RegExp(`/b2b/${kind}/`));
  const no = (await page.getByTestId('doc-no').textContent())!.trim();
  expect(no).toMatch(new RegExp(`^${kind === 'inv' ? 'INV' : kind.toUpperCase()}`));
  return no;
}

async function noHorizontalScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
}

async function noPromptPlus(page: Page) {
  if (EDITION !== 'onprem') return;
  await expect(page.locator('body')).not.toContainText(PP);
  await expect(page.locator('[data-testid^="pp-"]')).toHaveCount(0);
}

test('quotation with a free-text line → sales order → two partial deliveries → one tax invoice', async ({ page }) => {
  await login(page, 'boy');
  await page.getByRole('link', { name: /ขายส่ง \/ เงินเชื่อ/ }).click();
  await expect(page.getByTestId('b2b-table-so')).toBeVisible();
  await noPromptPlus(page);

  // quotation (REQ-M08-01/08/09)
  await page.getByTestId('new-qt').click();
  await pick(page.getByTestId('doc-customer'), 'รุ่งเรือง');
  await pick(page.getByTestId('line-product-0'), 'SCG-CEM-T50');
  await expect(page.getByTestId('line-price-0')).not.toHaveValue('');
  await page.getByTestId('line-qty-0').fill('10');
  await page.getByTestId('line-add-free').click();
  await page.getByTestId('line-name-1').fill('ประตูไม้สักบานคู่ 160×200 ซม.');
  await page.getByTestId('line-price-1').fill('8500');
  await page.getByTestId('doc-save').click();
  docs.qt = await docNo(page, 'qt');
  await expect(page.getByText('มีรายการที่ยังไม่มีในระบบ 1 รายการ')).toBeVisible();
  const paper = page.getByTestId('paper');
  await expect(paper).toContainText('ใบเสนอราคา');
  await expect(paper).toContainText('ประตูไม้สักบานคู่');
  await expect(paper.locator('.pbaht')).toContainText('บาท');
  await page.getByTestId('qt-sent').click();
  await expect(page.getByText('ส่งแล้ว · รอลูกค้า')).toBeVisible();

  // convert: the free-text line must be mapped to a product (REQ-M08-02/09)
  await page.getByTestId('qt-convert').click();
  await expect(page.getByTestId('doc-save')).toBeDisabled();
  await pick(page.getByTestId('line-product-1'), 'SCG-ROOF-LK');
  await expect(page.getByTestId('line-price-1')).toHaveValue(/8500/);
  await page.getByTestId('doc-save').click();
  docs.so = await docNo(page, 'so');
  await expect(page.getByText(docs.qt).first()).toBeVisible();

  // first delivery: part of line 1 only (REQ-M08-04)
  await page.getByTestId('so-deliver').click();
  await page.getByTestId('dlv-qty-0').fill('4');
  await page.getByTestId('dlv-qty-1').fill('0');
  await page.getByTestId('dlv-save').click();
  docs.do1 = await docNo(page, 'do');
  await page.getByRole('link', { name: docs.so }).first().click();
  await expect(page.getByText('ส่งบางส่วน').first()).toBeVisible();
  // second delivery: the rest (defaults to the remaining quantities)
  await page.getByTestId('so-deliver').click();
  await expect(page.getByTestId('dlv-qty-0')).toHaveValue('6');
  await page.getByTestId('dlv-qty-0').fill('7');
  await page.getByTestId('dlv-save').click();
  await expect(page.getByRole('alert')).toBeVisible(); // more than ordered
  await page.getByTestId('dlv-qty-0').fill('6');
  await page.getByTestId('dlv-save').click();
  docs.do2 = await docNo(page, 'do');

  // one tax invoice over both delivery orders (REQ-M08-05)
  await page.goto('/b2b?tab=do');
  await page.getByTestId('new-inv-do').click();
  await page.getByLabel(`เลือก ${docs.do1}`).check();
  await page.getByLabel(`เลือก ${docs.do2}`).check();
  await page.getByTestId('inv-from-do-save').click();
  docs.inv = await docNo(page, 'inv');
  await expect(page.getByTestId('inv-balance')).not.toHaveText('0.00');
  await expect(page.getByTestId('paper')).toContainText('ใบกำกับภาษี');
  await expect(page.getByTestId('paper')).toContainText(docs.do1);
  await page.goto(`/b2b/so/${docs.so}`);
  await expect(page.getByText('ส่งครบแล้ว').first()).toBeVisible();
  await noPromptPlus(page);
});

test('credit approval: over the limit stops and needs a PIN, the approver is recorded (BR-08)', async ({ page }) => {
  await login(page, 'boy');
  await page.goto('/b2b');
  await page.getByTestId('new-so').click();
  await pick(page.getByTestId('doc-customer'), 'บ้านนา'); // limit 80,000
  await pick(page.getByTestId('line-product-0'), 'SCG-CEM-T50');
  await expect(page.getByTestId('line-price-0')).not.toHaveValue('');
  await page.getByTestId('line-qty-0').fill('600');
  await page.getByTestId('line-qty-0').blur();
  await page.getByTestId('doc-save').click();
  await expect(page.getByTestId('credit-need')).toContainText('เกินวงเงิน');
  await page.getByTestId('apv-pin').fill('0000');
  await page.getByTestId('apv-ok').click();
  await expect(page.getByRole('alert')).toBeVisible(); // wrong PIN
  await approve(page, 'คุณเจริญ');
  docs.soCredit = await docNo(page, 'so');
  await expect(page.getByTestId('credit-approval')).toContainText('คุณเจริญ');
});

test('AR: billing note, then a receipt with 3 % WHT on the pre-VAT amount', async ({ page }) => {
  await login(page, 'charoen');
  await page.getByRole('link', { name: /ลูกหนี้ \/ รับชำระ/ }).click();
  await expect(page.getByTestId('ar-aging')).toBeVisible();
  await expect(page.getByTestId('ar-cust')).toContainText('รุ่งเรือง');
  await noPromptPlus(page);

  await page.locator('[data-testid="bn-C00001"]:visible').click();
  await expect(page.getByTestId('bn-invoices')).toContainText(docs.inv);
  await page.getByTestId('bn-save').click();
  await expect(page).toHaveURL(/\/ar\/bn\//);
  docs.bn = (await page.getByTestId('doc-no').textContent())!.trim();
  await expect(page.getByTestId('paper')).toContainText('ใบวางบิล');
  await expect(page.getByTestId('paper')).toContainText(docs.inv);
  await expect(page.getByTestId('paper').locator('.pbaht')).toContainText('บาท');

  await page.goto('/ar');
  await page.locator('[data-testid="rc-C00001"]:visible').click();
  await expect(page.getByTestId('rc-invoices')).toContainText(docs.inv);
  await page.getByTestId('rc-wht').selectOption('3');
  await page.getByTestId('rc-cert').fill('2569/0153');
  const settled = Number((await page.getByTestId('rc-settled').textContent())!.replace(/,/g, ''));
  const wht = Number((await page.getByTestId('rc-wht-val').textContent())!.replace(/[−,]/g, ''));
  const cash = Number((await page.getByTestId('rc-cash').textContent())!.replace(/[฿,]/g, ''));
  expect(wht).toBeCloseTo(Math.round((settled / 1.07) * 0.03 * 100) / 100, 1);
  expect(cash).toBeCloseTo(settled - wht, 2);
  await page.getByTestId('rc-save').click();
  await expect(page).toHaveURL(/\/ar\/rc\//);
  docs.rc = (await page.getByTestId('doc-no').textContent())!.trim();
  await expect(page.getByTestId('paper')).toContainText('หัก ณ ที่จ่าย 3%');
  await expect(page.getByTestId('paper')).toContainText('2569/0153');
  await page.goto(`/b2b/inv/${docs.inv}`);
  await expect(page.getByTestId('inv-balance')).toHaveText('0.00');
});

test('project: new SO as a project (50/50), switch to 30/40/30, deposit, delivery, bill installment 1, variation order', async ({ page }) => {
  await login(page, 'charoen');
  await page.getByRole('link', { name: /ขายโครงการ/ }).click();
  await page.getByTestId('new-project').click();
  await page.getByTestId('pj-way-new').click();
  await pick(page.getByTestId('doc-customer'), 'รุ่งเรือง');
  await expect(page.getByTestId('so-project')).toHaveValue('new');
  await page.getByTestId('pj-name').fill('บ้านคุณสมชาย หมู่บ้านลานนา แปลง 5');
  await page.getByTestId('pj-template').selectOption('50/50');
  await pick(page.getByTestId('line-product-0'), 'SCG-CEM-T50');
  await expect(page.getByTestId('line-price-0')).not.toHaveValue('');
  await page.getByTestId('line-qty-0').fill('40');
  await page.getByTestId('doc-save').click();
  await docNo(page, 'so');
  await page.getByRole('link', { name: 'ดูโครงการ' }).click();
  await expect(page.getByTestId('pj-title')).toHaveText('บ้านคุณสมชาย หมู่บ้านลานนา แปลง 5');
  docs.project = page.url().split('/projects/')[1]!;
  await expect(page.getByTestId('pj-installments').locator('tbody tr')).toHaveCount(2);

  await page.getByTestId('pj-inst-edit').click();
  await page.getByTestId('tpl-30/40/30').click();
  await expect(page.getByTestId('inst-sum')).toHaveText('100%');
  await page.getByTestId('inst-pct-0').fill('20');
  await expect(page.getByTestId('inst-save')).toBeDisabled();
  await page.getByTestId('inst-pct-0').fill('30');
  await page.getByTestId('inst-save').click();
  await expect(page.getByTestId('pj-installments').locator('tbody tr')).toHaveCount(3);

  await page.getByTestId('pj-deposit').click();
  await page.getByTestId('dep-save').click();
  await expect(page.getByText('รับชำระค่าสินค้าล่วงหน้า').first()).toBeVisible();

  await page.getByTestId('pj-deliver').click();
  await page.getByTestId('dlv-qty-0').fill('15');
  await page.getByTestId('dlv-save').click();
  await docNo(page, 'do');
  await page.goto(`/projects/${docs.project}`);

  await page.getByTestId('pj-bill-1').click();
  await expect(page.getByTestId('bill-net')).toBeVisible();
  await page.getByTestId('bill-ok').click();
  await expect(page.getByTestId('pj-installments').getByRole('link', { name: /^INV/ })).toHaveCount(1);

  await page.getByTestId('pj-variation').click();
  await expect(page.getByTestId('so-project')).not.toHaveValue('');
  await pick(page.getByTestId('line-product-0'), 'RB9-10');
  await expect(page.getByTestId('line-price-0')).not.toHaveValue('');
  await page.getByTestId('doc-save').click();
  await docNo(page, 'so');
  await page.goto(`/projects/${docs.project}`);
  await expect(page.getByTestId('pj-orders')).toContainText('งานเพิ่ม');
  await noPromptPlus(page);
});

test('void: a sales order with delivery orders is blocked until downstream documents are voided (BR-22)', async ({ page }) => {
  await login(page, 'charoen');
  await page.goto(`/b2b/so/${docs.so}`);
  await page.getByTestId('void').click();
  await page.getByTestId('void-ok').click();
  await expect(page.getByTestId('downstream')).toContainText(docs.do1);
  await page.getByRole('button', { name: 'ตกลง' }).click();
  // a quotation without an active order can be voided
  await page.goto('/b2b?tab=qt');
  await page.getByTestId('new-qt').click();
  await pick(page.getByTestId('doc-customer'), 'บ้านนา');
  await pick(page.getByTestId('line-product-0'), 'PVC-4-85');
  await expect(page.getByTestId('line-price-0')).not.toHaveValue('');
  await page.getByTestId('doc-save').click();
  const qt = await docNo(page, 'qt');
  await page.getByTestId('void').click();
  await page.getByTestId('void-ok').click();
  await expect(page.getByTestId('voided')).toBeVisible();
  await page.goto('/b2b?tab=qt');
  await page.getByTestId('b2b-search').fill(qt);
  await expect(page.getByTestId('b2b-table-qt').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByTestId('b2b-table-qt')).toContainText('ยกเลิก');
});

for (const w of [1300, 390] as const) {
  test(`sales screens at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
    await login(page, 'charoen');
    const shot = async (name: string, ready: Locator, full = true) => {
      await expect(ready.first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noHorizontalScroll(page);
      await noPromptPlus(page);
      await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
      await page.screenshot({ path: path.join(DIR, `sales-${EDITION}-${name}-${w}.png`), fullPage: full });
    };
    await page.goto('/b2b?tab=so');
    await shot('b2b', page.getByTestId('b2b-table-so').locator('tbody tr:not(.skrow)'));
    await page.goto(`/b2b/qt/${docs.qt}`);
    await shot('quote', page.getByTestId('paper'));
    await page.goto(`/b2b/inv/${docs.inv}`);
    await shot('invoice', page.getByTestId('paper'));
    await page.goto('/b2b');
    await page.getByTestId('new-so').click();
    await pick(page.getByTestId('doc-customer'), 'รุ่งเรือง');
    await pick(page.getByTestId('line-product-0'), 'SCG-CEM-T50');
    await shot('so-form', page.getByTestId('line-editor'), false);
    await page.keyboard.press('Escape');
    await page.goto('/projects');
    await shot('projects', page.getByTestId('pj-table').locator('tbody tr:not(.skrow)'));
    await page.goto(`/projects/${docs.project}`);
    await shot('project', page.getByTestId('pj-installments'));
    await page.goto('/ar');
    await shot('ar', page.getByTestId('ar-cust').locator('tbody tr:not(.skrow)'));
    await page.locator('[data-testid="rc-C00001"]:visible').click();
    await page.getByTestId('rc-wht').selectOption('1');
    await shot('receipt-form', page.getByTestId('rc-invoices').locator('tbody tr:not(.skrow)'), false);
    await page.keyboard.press('Escape');
    await page.goto(`/ar/bn/${docs.bn}`);
    await shot('billing-note', page.getByTestId('paper'));
    await page.goto(`/ar/rc/${docs.rc}`);
    await shot('receipt', page.getByTestId('paper'));
  });
}
