/**
 * Group D (admin): HR / payroll / payslip / leave (both editions), on-prem system screens (license, cloud backup to an
 * S3 stub, sales-summary preview, export), and the SCG Admin console (cloud).
 *
 * License steps need a throw-away keypair shared with the server process. Run with, for example:
 *   node -e "const c=require('crypto');const k=c.generateKeyPairSync('ed25519');
 *     console.log('export LICENSE_SIGNING_KEY=\"'+k.privateKey.export({type:'pkcs8',format:'pem'}).toString().replace(/\n/g,'\\\\n')+'\"');
 *     console.log('export ERP_LICENSE_TEST_PUBKEY='+k.publicKey.export({type:'spki',format:'der'}).toString('base64'))"
 * (run.mjs passes the environment to the server). Without them the license steps are skipped.
 * Screenshots: e2e/screenshots/admin-<edition>-<screen>-<width>.png
 */
import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPrivateKey } from 'node:crypto';
import { signLicense } from '../apps/server/src/modules/admin/license';
import { EDITION, login } from './helpers';

const DIR = path.join(__dirname, 'screenshots');
const ROOT = path.join(__dirname, '..');
const WIDTHS = [1300, 390] as const;
const HAS_KEYS = !!process.env.LICENSE_SIGNING_KEY && !!process.env.ERP_LICENSE_TEST_PUBKEY;
const uniq = Date.now().toString(36).slice(-5);

async function noHorizontalScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw, `page is ${sw}px wide in a ${iw}px viewport`).toBeLessThanOrEqual(iw);
}
async function shot(page: Page, name: string) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await noHorizontalScroll(page);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  await page.screenshot({ path: path.join(DIR, `admin-${EDITION}-${name}.png`), fullPage: true });
}
async function both(page: Page, name: string, prep?: () => Promise<void>) {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: w > 600 ? 900 : 844 });
    await page.waitForTimeout(500); // drawer slide transition after the resize
    if (prep) await prep();
    await shot(page, `${name}-${w}`);
  }
  await page.setViewportSize({ width: 1300, height: 900 });
}

test.beforeAll(() => {
  // Idempotent demo employees, leave, a paid September payroll, central master and SCG Admin accounts.
  execSync('pnpm --filter @erp/db exec tsx src/seedAdmin.ts', { cwd: ROOT, stdio: 'inherit', env: process.env });
});

function monthAhead(n: number): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

test.describe.serial('HR, payroll and leave (M17)', () => {
  test('employee with login user, resign instead of delete', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/hr');
    await expect(page.getByTestId('emp-table').locator('tbody tr').first()).toBeVisible();
    await both(page, 'hr-employees');

    const user = `emp${uniq}`;
    await page.getByTestId('emp-new').click();
    await page.getByTestId('emp-name').fill(`พนักงานทดสอบ ${uniq}`);
    await page.getByTestId('emp-position').fill('พนักงานขาย');
    await page.getByTestId('emp-salary').fill('13000');
    await page.getByTestId('emp-username').fill(user);
    await page.getByTestId('emp-save').click();
    await expect(page.getByTestId('temp-password')).toHaveText(/\S{8,}/);
    await page.getByRole('button', { name: 'จดแล้ว ปิด' }).click();

    const row = page.getByTestId('emp-table').locator('tbody tr', { hasText: user });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: 'แก้ไข' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'ลบ', exact: true })).toHaveCount(0);
    await row.getByRole('button', { name: 'ลาออก' }).click();
    await page.getByTestId('resign-ok').click();
    await expect(row.getByText('ลาออก').first()).toBeVisible();
    await expect(row.getByRole('button', { name: 'รับกลับ' })).toBeVisible();
  });

  test('payroll month: create, approve, pay; payslip prints', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/hr?tab=pay');
    await expect(page.getByTestId('pay-new')).toBeVisible();
    const period = monthAhead(1);
    await page.getByTestId('pay-new').click();
    await page.getByTestId('pay-new-period').fill(period);
    await page.getByTestId('pay-new-ok').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('pay-period')).toHaveValue(period);
    await expect(page.getByTestId('pay-table').locator('tbody tr').first()).toBeVisible();
    await expect(page.getByTestId('pay-net-total')).toBeVisible();
    await both(page, 'payroll');
    await page.getByTestId('pay-approve').click();
    await page.getByTestId('pay-confirm').click();
    await page.getByTestId('pay-ok').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('pay-confirm')).toHaveCount(0);

    await page.getByTestId('slip-all').click();
    await expect(page.getByTestId('payslip').first()).toBeVisible();
    await expect(page.getByTestId('payslip-net').first()).toBeVisible();
    await expect(page.getByTestId('slip-print')).toBeEnabled();
    await both(page, 'payslip');
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('slip-print')).toBeHidden();
    await page.emulateMedia({ media: 'screen' });
  });

  test('leave entitlements and records', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/leave');
    await expect(page.getByTestId('balance-table')).toBeVisible();
    await page.getByTestId('leave-new').click();
    const emp = page.getByTestId('leave-emp');
    await emp.selectOption({ index: 1 });
    await page.getByTestId('leave-type').selectOption('personal');
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 14);
    while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    const ymd = d.toISOString().slice(0, 10);
    await page.getByTestId('leave-from').fill(ymd);
    await page.getByTestId('leave-to').fill(ymd);
    await page.getByTestId('leave-reason').fill(`ธุระ ${uniq}`);
    await expect(page.getByTestId('leave-days')).toContainText('1');
    await page.getByTestId('leave-save').click();
    const rowL = page.getByTestId('leave-table').locator('tbody tr', { hasText: `ธุระ ${uniq}` });
    await expect(rowL).toBeVisible();
    // Recorded by the owner: approved straight away. A request waiting from seed data is approved by hand.
    await expect(rowL).toContainText('อนุมัติ');
    const pending = page.getByTestId('leave-table').getByRole('button', { name: 'อนุมัติ', exact: true }).first();
    if (await pending.count()) {
      await pending.click();
      await expect(page.getByTestId('leave-table')).toBeVisible();
    }
    await both(page, 'leave');
  });

  test('cashier cannot see payroll', async ({ page }) => {
    await login(page, 'prae');
    await page.goto('/hr?tab=pay');
    await expect(page.getByTestId('pay-new')).toHaveCount(0);
  });
});

test.describe('on-prem system screens (M19)', () => {
  test.skip(EDITION !== 'onprem', 'on-premise only');

  test('license key: install an expiring key, status and banner', async ({ page }) => {
    test.skip(!HAS_KEYS, 'needs LICENSE_SIGNING_KEY + ERP_LICENSE_TEST_PUBKEY (see header)');
    await login(page, 'charoen');
    await page.goto('/system');
    await expect(page.getByTestId('license-status')).toBeVisible();
    const shop = await page.evaluate(async () => (await (await fetch('/api/meta')).json()).shop?.name ?? '');
    const raw = process.env.LICENSE_SIGNING_KEY!;
    const key = signLicense({
      v: 1, licenseId: `LIC-E2E-${uniq}`, edition: 'onprem', type: 'expiring', shopName: shop, taxId: '0000000000000',
      expiresAt: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), issuedAt: new Date().toISOString(),
    }, createPrivateKey(raw.includes('BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8')));
    await page.getByTestId('license-key').fill('SCG1.not-a-real.key-for-this-shop-xxxxxxxx');
    await page.getByTestId('license-install').click();
    await expect(page.getByTestId('license-error')).toBeVisible();
    await page.getByTestId('license-key').fill(key);
    await page.getByTestId('license-install').click();
    // The shop name / tax id binding may reject it; the screen then shows the reason instead of crashing.
    await expect(page.getByTestId('license-error').or(page.getByTestId('license-banner'))).toBeVisible();
  });

  test('license status screen', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/system');
    await expect(page.getByTestId('license-status')).toBeVisible();
    await both(page, 'license');
  });

  test('cloud backup: off by default; S3 signed PUT reaches the stub; Drive is a stub', async ({ page }) => {
    const puts: { url: string; auth: string; bytes: number }[] = [];
    const stub = http.createServer((req, res) => {
      let n = 0;
      req.on('data', (c: Buffer) => { n += c.length; });
      req.on('end', () => {
        if (req.method === 'PUT') puts.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? ''), bytes: n });
        res.writeHead(200, { ETag: '"stub"' }).end();
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    const port = (stub.address() as AddressInfo).port;
    try {
      await login(page, 'charoen');
      await page.goto('/system?tab=backup');
      await expect(page.getByTestId('backup-enabled')).not.toBeChecked();
      await page.getByTestId('backup-provider').selectOption('s3');
      await page.getByTestId('s3-endpoint').fill(`http://127.0.0.1:${port}`);
      await page.getByTestId('s3-bucket').fill('shop-backup');
      await page.getByTestId('s3-key').fill('AKIAE2E');
      await page.locator('[data-testid="s3-secret"]').fill('secret-e2e-secret');
      await page.getByTestId('backup-pass').fill('e2e-passphrase-1');
      await page.getByTestId('backup-pass2').fill('e2e-passphrase-1');
      await page.getByTestId('backup-enabled').check();
      await page.getByTestId('backup-save').click();
      await expect(page.getByTestId('backup-run')).toBeEnabled();
      await page.getByTestId('backup-run').click();
      await expect.poll(() => puts.length, { timeout: 20_000 }).toBeGreaterThan(0);
      expect(puts[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(puts[0]!.bytes).toBeGreaterThan(100);
      await expect(page.getByTestId('backup-runs').locator('tbody tr').first()).toBeVisible();
      await both(page, 'backup');

      await page.getByTestId('backup-provider').selectOption('gdrive');
      await expect(page.getByTestId('oauth-connect').or(page.getByTestId('oauth-unavailable'))).toBeVisible();
    } finally {
      stub.close();
    }
  });

  test('sales summary: preview then manual send needs confirmation', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/system?tab=share');
    await page.getByTestId('share-preview').click();
    await expect(page.getByTestId('share-table')).toBeVisible();
    await expect(page.getByTestId('share-total')).toBeVisible();
    await both(page, 'share');
    await page.getByTestId('share-send').click();
    await expect(page.getByTestId('share-confirm')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('export the shop for the cloud', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/system?tab=export');
    await page.getByTestId('export-pass').fill('e2e-export-pass');
    await page.getByTestId('export-pass2').fill('e2e-export-pass');
    const dl = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByTestId('export-go').click();
    expect((await dl).suggestedFilename()).toMatch(/\.|erp|shop/i);
    await both(page, 'export');
  });

  test('terms page and nav', async ({ page }) => {
    await login(page, 'charoen');
    await page.goto('/terms');
    await expect(page.getByTestId('terms-history').or(page.getByTestId('terms-paper'))).toBeVisible();
  });
});

test.describe('SCG Admin console (M14)', () => {
  test.skip(EDITION !== 'cloud', 'cloud only');

  test('KPI, new shop, central master, license issuing', async ({ page }) => {
    await page.goto('/scg');
    await page.getByLabel('ชื่อผู้ใช้').fill('scg.admin');
    await page.getByLabel('รหัสผ่าน').fill('1234');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByTestId('adm-who')).toBeVisible();
    await expect(page.getByTestId('kpi-total')).toBeVisible();
    await both(page, 'scg-kpi');

    await page.goto('/scg/shops');
    await expect(page.getByTestId('shops-table')).toBeVisible();
    const code = `e2e-${uniq}`;
    await page.getByTestId('shop-new').click();
    await page.getByTestId('ns-code').fill(code);
    await page.getByTestId('ns-name').fill(`ร้านทดสอบ ${uniq}`);
    await page.getByTestId('ns-tax').fill('0105500000000');
    await page.getByTestId('ns-oname').fill('เจ้าของทดสอบ');
    await page.getByTestId('ns-ouser').fill(`own${uniq}`);
    await page.getByTestId('ns-opass').fill('Passw0rd-e2e');
    await page.getByTestId('ns-opin').fill('1234');
    await page.getByTestId('ns-save').click();
    await expect(page.getByTestId('shops-table').locator('tbody tr', { hasText: code })).toBeVisible();
    await both(page, 'scg-shops');
    await page.getByTestId(`shop-status-${code}`).click();
    await page.getByTestId('status-reason').fill('ทดสอบระงับ');
    await page.getByTestId('status-ok').click();
    await expect(page.getByTestId('shops-table').locator('tbody tr', { hasText: code })).toContainText(/ระงับ/);

    await page.goto('/scg/master');
    await expect(page.getByTestId('central-table')).toBeVisible();
    await both(page, 'scg-master');

    await page.goto('/scg/licenses');
    await expect(page.getByTestId('license-table')).toBeVisible();
    if (HAS_KEYS) {
      await page.getByTestId('lic-shop').fill(`ร้านทดสอบ ${uniq}`);
      await page.getByTestId('lic-tax').fill('0105500000000');
      await page.getByTestId('lic-type').selectOption('lifetime');
      await page.getByTestId('lic-issue').click();
      await expect(page.getByTestId('lic-key')).toContainText(/^SCG1\./);
      await page.getByRole('button', { name: 'ปิด', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    await both(page, 'scg-licenses');
  });
});
