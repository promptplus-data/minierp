/**
 * Cross-cutting pickers / notes / lazy lists / payslip publish (both editions):
 * vendor partial Thai search in the manual receipt, note saved on the GR and copied to the AP bill (and edited there),
 * LoadMore on the audit log, payslip button disabled until the payroll run is published (no slips request fired).
 */
import { expect, test } from '@playwright/test';
import { apiToken, login, pick } from './helpers';

const RUN = Date.now().toString(36).slice(-5).toUpperCase();

test('manual receipt: vendor found by a word inside its Thai name; the note is saved on the GR and the AP bill', async ({ page, request }) => {
  await login(page, 'charoen');
  await page.goto('/purchasing');
  await page.getByRole('button', { name: '+ ซื้อเข้าแบบบันทึกเอง' }).click();
  // "พัฒนา" is in the middle of "หจก. ทวีพัฒนาวัสดุ (ผู้แทนจำหน่าย)"
  const input = page.getByTestId('gr-vendor-input');
  await input.click();
  await input.fill('พัฒนา');
  await expect(page.getByTestId('gr-vendor-list').getByRole('option', { name: /ทวีพัฒนาวัสดุ/ })).toBeVisible();
  await page.getByTestId('gr-vendor-list').getByRole('option', { name: /ทวีพัฒนาวัสดุ/ }).click();
  await expect(input).toHaveValue(/ทวีพัฒนาวัสดุ/);
  await page.getByTestId('gr-dn').fill(`DN-PK-${RUN}`);
  await page.getByTestId('gr-inv').fill(`IV-PK-${RUN}`);
  await pick(page, 'gr-p0', 'ปูนซีเมนต์ตราเสือ 50 กก.', 'ปูนเสือ');
  await page.getByTestId('gr-q0').fill('2');
  await page.getByTestId('gr-c0').fill('120');
  await page.getByTestId('gr-note').fill(`ถุงฉีก 1 ถุง ${RUN}`);
  await page.getByTestId('gr-save').click();
  await expect(page.getByText(/รับเข้าสต็อก GR\d{4}-\d{4} แล้ว/)).toBeVisible();

  const token = await apiToken(request, 'charoen');
  const list = await (await request.get(`/api/purchasing/receipts?q=IV-PK-${RUN}`, { headers: { authorization: `Bearer ${token}` } })).json();
  const gr = list.items[0];
  expect(gr.note).toBe(`ถุงฉีก 1 ถุง ${RUN}`);
  await page.goto(`/purchasing/gr/${gr.no}`);
  await expect(page.getByTestId('doc-note')).toHaveText(`ถุงฉีก 1 ถุง ${RUN}`);
  await page.goto(`/ap/bill/${gr.apBillNo}`);
  await expect(page.getByTestId('doc-note')).toHaveText(`ถุงฉีก 1 ถุง ${RUN}`);
  await page.getByTestId('bill-note-edit').click();
  await page.getByTestId('bill-note-edit-input').fill(`ผู้ขายเปลี่ยนให้แล้ว ${RUN}`);
  await page.getByTestId('bill-note-edit-save').click();
  await expect(page.getByTestId('doc-note')).toHaveText(`ผู้ขายเปลี่ยนให้แล้ว ${RUN}`);
});

test('audit log loads 20 rows, then more when the footer scrolls into view', async ({ page, request }) => {
  const token = await apiToken(request, 'charoen');
  for (let i = 0; i < 22; i++) {
    const r = await request.post('/api/vendors', { headers: { authorization: `Bearer ${token}` }, data: { name: `ผู้ขายทดสอบ ${RUN}-${i}` } });
    expect(r.status()).toBe(201);
  }
  await login(page, 'charoen');
  await page.goto('/audit');
  const rows = page.getByTestId('audit-table').locator('tbody tr');
  await expect(rows.nth(19)).toBeVisible();
  const more = page.getByTestId('audit-more');
  await more.scrollIntoViewIfNeeded();
  await expect.poll(async () => rows.count()).toBeGreaterThan(20);
});

test('payslip button is disabled with "รอเผยแพร่รอบเงินเดือน" until the run is paid; no slips request is sent', async ({ page, request }) => {
  const token = await apiToken(request, 'charoen');
  const period = `2031-${String((Date.now() % 12) + 1).padStart(2, '0')}`;
  const r = await request.post('/api/hr/payroll', { headers: { authorization: `Bearer ${token}` }, data: { period } });
  expect([201, 409]).toContain(r.status());
  const slipCalls: string[] = [];
  page.on('request', (q) => { if (/\/api\/hr\/payroll\/[^/]+\/slips/.test(q.url())) slipCalls.push(q.url()); });

  await login(page, 'charoen');
  await page.goto('/hr?tab=pay');
  await page.getByTestId('pay-period').selectOption(period);
  const all = page.getByTestId('slip-all');
  await expect(all).toBeDisabled();
  await expect(page.locator('.adm-slip-wait').first()).toHaveAttribute('title', 'รอเผยแพร่รอบเงินเดือน');

  await page.goto(`/payslip/${period}`);
  await expect(page.getByTestId('slip-wait')).toContainText('รอเผยแพร่รอบเงินเดือน');
  await expect(page.getByTestId('slip-print')).toBeDisabled();
  expect(slipCalls).toEqual([]);

  await request.post(`/api/hr/payroll/${period}/approve`, { headers: { authorization: `Bearer ${token}` }, data: {} });
  await request.post(`/api/hr/payroll/${period}/pay`, { headers: { authorization: `Bearer ${token}` }, data: {} });
  await page.goto('/hr?tab=pay');
  await page.getByTestId('pay-period').selectOption(period);
  await expect(page.getByTestId('slip-all')).toBeEnabled();
  await page.getByTestId('slip-all').click();
  await expect(page.getByTestId('payslip').first()).toBeVisible();
});
