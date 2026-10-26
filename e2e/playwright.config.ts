import { defineConfig, devices } from '@playwright/test';

/** Started by e2e/run.mjs, which sets BASE_URL and EDITION and runs the server for one edition. */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '../test-results',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3310',
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    viewport: { width: 1300, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1300, height: 900 } } }],
});
