import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // test/<module>/*.test.ts per module group (sales, purchasing, retail, admin, reports); core tests stay in test/.
    include: ['test/**/*.test.ts'],
    globalSetup: './test/global-setup.ts',
    // All files share the erp_test database; each file truncates and re-seeds it.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
