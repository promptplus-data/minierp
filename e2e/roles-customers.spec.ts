/** ข้อมูลลูกค้า (type, credit limit) and สิทธิ์และบทบาท (owner adds ฝ่ายบุคคล; its user sees only the HR menus), both editions. */
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EDITION, apiToken, login, logout } from './helpers';

const DIR = path.join(__dirname, 'screenshots');
const RUN = Date.now().toString(36).slice(-4);
async function shot(page: Page, name: string) {
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(DIR, `roles-${EDITION}-${name}-1300.png`) });
}
test.describe.configure({ mode: 'serial' });

test('customer master: add a customer with its own type and a credit limit, edit, deactivate', async ({ page }) => {
  await login(page, 'suda');
  await page.goto('/customers');
  await expect(page.getByRole('link', { name: /ข้อมูลลูกค้า/ })).toBeVisible();
  await page.getByTestId('cust-new').click();
  await page.getByTestId('cust-name').fill(`บริษัท ทดสอบรับเหมา ${RUN} จำกัด`);
  await page.getByTestId('cust-type').selectOption('บริษัทรับเหมา');
  await page.getByTestId('cust-tax').fill('0105561000123');
  await page.getByTestId('cust-limit').fill('80000');
  await page.getByTestId('cust-term').selectOption('days');
  await page.getByTestId('cust-term-x').fill('45');
  await shot(page, 'customer-form');
  await page.getByTestId('cust-save').click();
  await expect(page.getByText(/เพิ่มลูกค้า C\d{5} บริษัท ทดสอบรับเหมา/)).toBeVisible();

  await page.getByTestId('cust-q').fill(RUN);
  const row = page.getByTestId('cust-table').locator('tbody tr', { hasText: RUN });
  await expect(row).toContainText('บริษัทรับเหมา');
  await expect(row).toContainText('80,000.00');
  await row.getByRole('button', { name: 'แก้ไข' }).click();
  await page.getByTestId('cust-type').selectOption('__o');
  await page.getByTestId('cust-type-other').fill('ร้านวัสดุรายย่อย');
  await page.getByTestId('cust-save').click();
  await expect(row).toContainText('ร้านวัสดุรายย่อย');
  await page.getByTestId('cust-q').fill('');
  await shot(page, 'customers');
  await page.getByTestId('cust-q').fill(RUN);
  await row.getByRole('button', { name: 'แก้ไข' }).click();
  await page.getByTestId('cust-active').uncheck();
  await page.getByTestId('cust-save').click();
  await expect(page.getByTestId('cust-table').locator('tbody tr', { hasText: RUN })).toHaveCount(0);
});

test('roles: the owner adds ฝ่ายบุคคล who sees salaries and the HR menus only', async ({ page, request }) => {
  await login(page, 'charoen');
  await page.goto('/roles');
  await page.getByTestId('role-tab-sales').click();
  await expect(page.getByTestId('perm-rep.view')).toContainText('ดูอย่างเดียว');
  await page.getByTestId('role-add').click();
  await page.getByTestId('role-new-name').fill(`ฝ่ายบุคคล ${RUN}`);
  await page.getByTestId('role-new-base').selectOption('acct');
  await page.getByTestId('role-new-save').click();
  await expect(page.getByText(`เพิ่มบทบาท ฝ่ายบุคคล ${RUN} แล้ว`)).toBeVisible();
  for (const [k, v] of [['fin.ar', '0'], ['fin.shift', '0'], ['fin.ap', '0'], ['data.cost', '0'], ['data.export', '0'], ['rep.view', '0'], ['sales.doc', '0'], ['sales.project', '0'], ['inv.view', '0'], ['data.master', '0'], ['sys.log', '0'],
    ['hr.manage', '1'], ['hr.salary', '1'], ['hr.leave', '1']] as const) {
    await page.getByTestId(`perm-sel-${k}`).selectOption(v);
  }
  await page.getByTestId('perm-hr.salary').scrollIntoViewIfNeeded();
  await shot(page, 'role-editor');
  await page.getByTestId('role-save').click();
  await expect(page.getByText(`บันทึกสิทธิ์ ฝ่ายบุคคล ${RUN} แล้ว`)).toBeVisible();

  // the HR page offers the new role when creating a login
  await page.goto('/hr');
  const owner = await apiToken(request, 'charoen');
  const roles = await (await request.get('/api/roles', { headers: { authorization: `Bearer ${owner}` } })).json() as { id: string; name: string }[];
  const hr = roles.find((r) => r.name === `ฝ่ายบุคคล ${RUN}`)!;
  const res = await request.post('/api/hr/employees', { headers: { authorization: `Bearer ${owner}` }, data: { name: `คุณแนน ${RUN}`, startDate: '2026-11-01', salary: '18000', user: { username: `nan${RUN}`, role: 'acct', shopRoleId: hr.id, password: '1234' } } });
  expect(res.status()).toBe(201);
  await logout(page);

  await login(page, `nan${RUN}`);
  const nav = page.locator('nav.nav');
  await expect(nav).toContainText('พนักงานและเงินเดือน');
  await expect(nav).not.toContainText('ขายหน้าร้าน');
  await expect(nav).not.toContainText('ลูกหนี้');
  await expect(page.locator('.who')).toContainText(`ฝ่ายบุคคล ${RUN}`);
  await page.goto('/hr');
  await expect(page.getByText(`คุณแนน ${RUN}`).first()).toBeVisible();
  await expect(page.locator('body')).toContainText('18,000');
  await shot(page, 'hr-user-view');
});
