import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const EDITION = (process.env.EDITION ?? 'cloud') as 'cloud' | 'onprem';

export async function login(page: Page, username: string, password = '1234') {
  await page.goto('/');
  await page.getByLabel('ชื่อผู้ใช้').fill(username);
  await page.getByLabel('รหัสผ่าน').fill(password);
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
  await expect(page.getByLabel('ชื่อผู้ใช้')).toBeVisible();
}

/** Approver PIN modal: pick the approver by visible name and enter the PIN. */
export async function approve(page: Page, approverName: string, pin = '1234') {
  const sel = page.getByTestId('apv-by');
  await expect(sel).toBeVisible();
  await sel.selectOption({ label: await optionLabel(page, approverName) });
  await page.getByTestId('apv-pin').fill(pin);
  await page.getByTestId('apv-ok').click();
}

async function optionLabel(page: Page, contains: string): Promise<string> {
  const labels = await page.getByTestId('apv-by').locator('option').allTextContents();
  const hit = labels.find((l) => l.includes(contains));
  if (!hit) throw new Error(`approver "${contains}" not in ${labels.join(' | ')}`);
  return hit;
}

export async function apiToken(request: APIRequestContext, username: string): Promise<string> {
  const r = await request.post('/api/auth/login', { data: { username, password: '1234' } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).token as string;
}

export const PP = /prompt[\s_-]*plus/i;
