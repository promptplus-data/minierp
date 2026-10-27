/** Test database. Set TEST_DATABASE_URL per worktree (erp_test_a, erp_test_b, ...); global-setup creates it if missing. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/erp_test';
