/**
 * Touch mode: on-screen number pad and Thai/English keyboard driven by real taps, automatic busy buttons with a slowed
 * request (a double tap makes one bill), the global progress bar, and screenshots at 1300 / 390 px. Serial.
 * Touch mode is forced through localStorage (like the header switch does); one test checks the (pointer: coarse) default.
 */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITION, login } from './helpers';

test.describe.configure({ mode: 'serial' });
test.use({ hasTouch: true });

const DIR = path.join(__dirname, 'screenshots');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { try { if (!localStorage.getItem('erp-touch-mode')) localStorage.setItem('erp-touch-mode', 'on'); } catch { /* ignore */ } });
});

async function openPos(page: Page) {
  await page.goto('/pos');
  const open = page.getByTestId('shift-open');
  const strip = page.getByTestId('shift-strip');
  await expect(open.or(strip)).toBeVisible();
  if (await open.isVisible()) await open.tap();
  await expect(strip).toBeVisible();
}
const pad = (page: Page) => page.getByTestId('numpad');
/** Taps number-pad keys: digits, "." and "00". */
async function keys(page: Page, s: string) {
  for (const k of s.match(/00|./g) ?? []) {
    await pad(page).getByRole('button', { name: k === '.' ? 'จุดทศนิยม' : k, exact: true }).tap();
  }
}
async function shot(page: Page, name: string) {
  await page.waitForTimeout(350); // sheet slide-in finished
  await page.screenshot({ path: path.join(DIR, `touch-${EDITION}-${name}.png`) });
}
async function noHorizontalScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
}

test('touch mode switch, html attribute and persistence', async ({ page }) => {
  await login(page, 'prae');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-touch', 'on');
  const sw = page.getByRole('button', { name: /โหมดจอสัมผัส/ });
  await expect(sw).toHaveAttribute('aria-pressed', 'true');
  await sw.tap();
  await expect(html).toHaveAttribute('data-touch', 'off');
  await page.reload();
  await expect(html).toHaveAttribute('data-touch', 'off');
  await page.getByRole('button', { name: /โหมดจอสัมผัส/ }).tap();
  await expect(html).toHaveAttribute('data-touch', 'on');
  await page.evaluate(() => localStorage.setItem('erp-touch-mode', 'on'));
});

test('number pad edits the POS qty and the payment amount; quick cash; the sale completes', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('tile-SCG-AAC-75').tap();
  const qty = page.getByTestId('qty-0');
  await expect(qty).toHaveValue('1');

  await qty.tap();
  await expect(pad(page)).toBeVisible();
  await expect(qty).toHaveAttribute('inputmode', 'none'); // OS keyboard suppressed while the pad is up
  await keys(page, '12');
  await expect(qty).toHaveValue('12'); // the first key replaced the old value
  await pad(page).getByRole('button', { name: 'ลบหนึ่งตัว' }).tap();
  await expect(qty).toHaveValue('1');
  await keys(page, '.5');
  await expect(qty).toHaveValue('1.5');
  await pad(page).getByTestId('numpad-ok').tap();
  await expect(pad(page)).toHaveCount(0);
  await expect(qty).toHaveAttribute('inputmode', 'decimal'); // restored
  await expect(page.getByTestId('cline-0')).toContainText('36.00'); // 1.5 × 24.00

  // back to a whole number; the line discount field takes the pad too
  await qty.tap();
  await keys(page, '4');
  await pad(page).getByTestId('numpad-ok').tap();
  await expect(qty).toHaveValue('4');
  await page.getByTestId('ldisc-0').tap();
  await keys(page, '10');
  await pad(page).getByTestId('numpad-ok').tap();
  // a cashier's discount asks for the manager PIN right away; cancelling puts the bill back
  await expect(page.getByTestId('override-what')).toBeVisible();
  await page.getByRole('dialog', { name: 'ขออนุมัติ' }).getByRole('button', { name: 'ยกเลิก' }).tap();
  await expect(page.getByTestId('ldisc-0')).toHaveValue('');
  await expect(qty).toHaveValue('4');

  const total = ((await page.getByTestId('total').innerText()).replace(/[^\d.]/g, ''));
  await page.getByTestId('pay').tap();
  const amount = page.getByTestId('pa-0');
  await expect(amount).toHaveValue(/\d/);
  await amount.tap();
  await expect(pad(page)).toBeVisible();
  await pad(page).getByRole('button', { name: 'ลบหนึ่งตัว' }).tap(); // fresh: clears the whole amount
  await expect(amount).toHaveValue('');
  await keys(page, total); // the exact total, typed on the pad
  await pad(page).getByTestId('numpad-ok').tap();
  await expect(amount).toHaveValue(total);
  await expect(page.getByTestId('pay-confirm')).toBeEnabled();

  // quick cash: next 500 / 1,000 note → change appears
  const quick = page.getByTestId('quick-cash-2');
  await expect(quick).toBeVisible();
  await quick.tap();
  await expect(page.getByTestId('pay-change')).not.toHaveText('0.00');
  await page.getByTestId('pay-confirm').tap();
  await expect(page.getByTestId('sale-no')).toHaveText(/^ABB|^RCP|^[A-Z]{2,4}/);
  await page.getByTestId('next-bill').tap();
});

test('number pad respects min/max/step and negatives (shift count form)', async ({ page }) => {
  await login(page, 'prae');
  await page.goto('/pos');
  // a plain number input with max/min, injected to test the pad rules without depending on a screen
  await page.evaluate(() => {
    const i = document.createElement('input');
    i.type = 'number'; i.min = '0'; i.max = '100'; i.step = '0.5'; i.id = 'probe'; i.setAttribute('aria-label', 'ทดสอบช่วง');
    i.style.cssText = 'position:fixed;top:120px;left:20px;z-index:5';
    const n = document.createElement('input');
    n.type = 'number'; n.min = '-50'; n.id = 'probe-neg'; n.setAttribute('aria-label', 'ทดสอบติดลบ');
    n.style.cssText = 'position:fixed;top:170px;left:20px;z-index:5';
    const off = document.createElement('input');
    off.type = 'number'; off.id = 'probe-off'; off.dataset.kbd = 'off';
    off.style.cssText = 'position:fixed;top:220px;left:20px;z-index:5';
    document.body.append(i, n, off);
  });
  await page.locator('#probe').tap();
  await expect(pad(page)).toContainText('ช่วง 0 – 100');
  await keys(page, '250');
  await pad(page).getByTestId('numpad-ok').tap();
  await expect(page.locator('#probe')).toHaveValue('100'); // clamped to max
  await page.locator('#probe').tap();
  await keys(page, '7.25');
  await pad(page).getByTestId('numpad-ok').tap();
  await expect(page.locator('#probe')).toHaveValue('7.3'); // snapped to step 0.5 decimals (1 dp)
  await expect(pad(page).getByRole('button', { name: 'สลับบวกลบ' })).toHaveCount(0);

  await page.locator('#probe-neg').tap();
  await expect(pad(page).getByRole('button', { name: 'สลับบวกลบ' })).toBeVisible();
  await keys(page, '8');
  await pad(page).getByRole('button', { name: 'สลับบวกลบ' }).tap();
  await keys(page, '5');
  await pad(page).getByTestId('numpad-ok').tap();
  await expect(page.locator('#probe-neg')).toHaveValue('-85'.replace('-85', '-50')); // clamped to min

  await page.locator('#probe-off').tap();
  await expect(pad(page)).toHaveCount(0);
  await expect(page.getByTestId('osk')).toHaveCount(0);
});

test('Thai on-screen keyboard types into product search and the tiles filter; hardware keys still work', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  const search = page.getByTestId('pos-search');
  const osk = page.getByTestId('osk');
  const key = (k: string) => osk.locator(`button[data-k="${k}"]`).tap();
  await expect(osk).toHaveCount(0); // autofocus alone does not pop the keyboard up
  await search.tap();
  await expect(osk).toBeVisible();
  await expect(search).toHaveAttribute('inputmode', 'none');
  await expect(page.getByTestId('tile-SCG-CEM-T50')).toBeVisible();
  for (const k of ['ท', '่', 'อ']) await key(k);
  await expect(search).toHaveValue('ท่อ');
  await expect(page.getByTestId('tile-PVC-4-85')).toBeVisible();
  await expect(page.getByTestId('tile-SCG-CEM-T50')).toHaveCount(0);

  // ENG layer + shift: "ท่อ PVC"
  await key(' ');
  await osk.getByTestId('osk-lang').tap();
  await osk.getByRole('button', { name: /ตัวอักษรอีกชุด/ }).tap();
  await key('P');
  await key('v');
  await key('c');
  await expect(search).toHaveValue('ท่อ Pvc');
  await expect(page.getByTestId('tile-PVC-4-85')).toBeVisible();
  // backspace x3 then a hardware keyboard (barcode scanner style) while the sheet is still open
  for (let i = 0; i < 3; i++) await osk.getByRole('button', { name: 'ลบหนึ่งตัว' }).tap();
  await expect(search).toHaveValue('ท่อ ');
  await page.keyboard.type('pvc');
  await expect(search).toHaveValue('ท่อ pvc');
  await expect(osk).toBeVisible();
  // the symbols layer has digits
  await osk.getByRole('button', { name: 'ตัวเลขและสัญลักษณ์' }).tap();
  await key('4');
  await expect(search).toHaveValue('ท่อ pvc4');
  await osk.getByTestId('osk-hide').tap();
  await expect(osk).toHaveCount(0);
  await expect(search).not.toHaveAttribute('inputmode', 'none');
  // clear search for later tests
  await search.fill('');
});

test('a tapped confirm button shows a busy state and a double tap creates one bill; progress bar shows', async ({ page }) => {
  await login(page, 'prae');
  await openPos(page);
  let posts = 0;
  await page.route('**/api/sales/pos', async (route) => {
    posts++;
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.getByTestId('tile-SCG-AAC-75').tap();
  await page.getByTestId('pay').tap();
  const confirm = page.getByTestId('pay-confirm');
  await expect(confirm).toBeEnabled();
  await confirm.dblclick();
  await expect(confirm).toHaveAttribute('aria-busy', 'true');
  await expect(confirm).toBeDisabled();
  await expect(page.getByTestId('top-progress')).toBeVisible();
  await shot(page, 'busy-pay-1300');
  await expect(page.getByTestId('sale-no')).toBeVisible({ timeout: 15_000 });
  expect(posts).toBe(1);
  await expect(page.getByTestId('top-progress')).toHaveCount(0);
  await page.unroute('**/api/sales/pos');
  await page.getByTestId('next-bill').tap();
});

test('screenshots 1300px: POS with number pad, payment modal with number pad, keyboard on search', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await login(page, 'prae');
  await openPos(page);
  await page.getByTestId('tile-SCG-AAC-75').tap();
  await page.getByTestId('tile-PVC-4-85').tap();
  await page.getByTestId('qty-1').tap();
  await keys(page, '25');
  await shot(page, 'pos-numpad-1300');
  await pad(page).getByTestId('numpad-ok').tap();
  await page.getByTestId('pos-search').tap();
  await page.getByTestId('osk').locator('button[data-k="ก"]').tap();
  await page.getByTestId('osk').locator('button[data-k="า"]').tap();
  await shot(page, 'pos-keyboard-1300');
  await page.getByTestId('pos-search').fill('');
  await page.getByTestId('osk-hide').tap();
  await page.getByTestId('pay').tap();
  await page.getByTestId('pa-0').tap();
  await shot(page, 'pay-numpad-1300');
  await pad(page).getByTestId('numpad-ok').tap();
  await page.getByRole('button', { name: 'กลับไปแก้บิล' }).tap();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'ยกเลิกบิล' }).tap();
});

test.describe('phone (390px, coarse pointer default)', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('touch mode defaults on for a coarse pointer; screenshots at 390px', async ({ page, context }) => {
    await context.clearCookies();
    await page.addInitScript(() => { try { localStorage.removeItem('erp-touch-mode'); } catch { /* ignore */ } });
    await login(page, 'prae');
    await expect(page.locator('html')).toHaveAttribute('data-touch', 'on');
    await openPos(page);
    await page.getByTestId('tile-SCG-AAC-75').tap();
    await page.getByTestId('tile-PVC-4-85').tap();
    await noHorizontalScroll(page);
    await page.getByTestId('qty-1').tap();
    await keys(page, '25');
    await expect(page.getByTestId('qty-1')).toBeInViewport();
    await shot(page, 'pos-numpad-390');
    await pad(page).getByTestId('numpad-ok').tap();
    await page.getByTestId('pos-search').tap();
    await page.getByTestId('osk').locator('button[data-k="ก"]').tap();
    await shot(page, 'pos-keyboard-390');
    await page.getByTestId('pos-search').fill('');
    await page.getByTestId('osk-hide').tap();
    await page.getByTestId('pay').tap();
    await page.getByTestId('pa-0').tap();
    await shot(page, 'pay-numpad-390');
    await expect(page.getByTestId('pa-0')).toBeInViewport();
    await pad(page).getByTestId('numpad-ok').tap();
    await page.getByRole('button', { name: 'กลับไปแก้บิล' }).tap();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'ยกเลิกบิล' }).tap();
  });
});
