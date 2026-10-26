import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

/** The main machine itself (on-prem): requests from loopback skip device pairing and may run first-time setup. */
export const isLoopback = (ip: string): boolean => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export const DEVICE_COOKIE = 'erp_device';
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function cookie(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
