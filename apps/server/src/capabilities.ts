import type { Edition } from './lib/context';
import { scgFamily } from './adapters/scgfamily';
import { promptPlusCapabilities } from './adapters/promptplus';

/**
 * GET /api/meta capabilities. The on-prem build contains no Prompt Plus names at all: the cloud-only flags are
 * added inside the `process.env.EDITION === 'cloud'` branch (removed from the on-prem bundle), and the contract
 * parses the missing flags as false.
 */
export function capabilities(edition: Edition): Record<string, boolean> {
  const caps: Record<string, boolean> = { scgFamily: scgFamily.available(edition) };
  if (process.env.EDITION === 'cloud') {
    if (edition === 'cloud') Object.assign(caps, promptPlusCapabilities());
  }
  return caps;
}
