import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { withTenant } from './tx';

/** A pool double whose client fails the statement under test and optionally the ROLLBACK. */
function fakePool(failRollback: boolean) {
  const release = vi.fn();
  const client = {
    release,
    query: vi.fn(async (sql: string) => {
      if (sql === 'ROLLBACK' && failRollback) throw new Error('connection lost');
      if (sql === 'boom') throw new Error('statement failed');
      return { rows: [], rowCount: 0 };
    }),
  };
  const pool = { connect: async () => client, query: async () => ({ rows: [{ ok: false }] }) } as unknown as pg.Pool;
  return { pool, release };
}

describe('withTenant', () => {
  it('returns a healthy connection to the pool after a normal rollback', async () => {
    const { pool, release } = fakePool(false);
    await expect(withTenant(pool, null, (tx) => tx.query('boom'))).rejects.toThrow('statement failed');
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('destroys the connection (release(err)) when ROLLBACK itself fails, and rethrows the original error', async () => {
    const { pool, release } = fakePool(true);
    await expect(withTenant(pool, null, (tx) => tx.query('boom'))).rejects.toThrow('statement failed');
    expect(release.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((release.mock.calls[0]![0] as Error).message).toBe('connection lost');
  });
});
