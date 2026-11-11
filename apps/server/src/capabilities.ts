import type { Edition } from './lib/context';
import { promptPlusCapabilities } from './adapters/promptplus';
import { scgFamilyCapabilities } from './adapters/scgfamily';

/**
 * GET /api/meta capabilities. The on-prem build contains no cloud-only names at all (Prompt Plus, SCG Family): the
 * cloud-only flags are added inside the `process.env.EDITION === 'cloud'` branch (removed from the on-prem bundle),
 * and the contract parses the missing flags as false.
 */
export function capabilities(edition: Edition): Record<string, boolean> {
  const caps: Record<string, boolean> = {};
  if (process.env.EDITION === 'cloud') {
    if (edition === 'cloud') Object.assign(caps, promptPlusCapabilities(), scgFamilyCapabilities());
  }
  return caps;
}
