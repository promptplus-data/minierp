/**
 * GET /api/meta (M01, M19). Kept in its own module: the package is marked side-effect free, so a bundle
 * that never imports these schemas (the on-prem server) drops this file and with it the cloud-only
 * capability names, which scripts/check-onprem.mjs forbids in on-prem payloads.
 */
import { z } from 'zod';

export const Edition = z.enum(['cloud', 'onprem']);
export type Edition = z.infer<typeof Edition>;

export const Capabilities = z.object({
  // The on-prem server omits the two cloud-only flags entirely; parsing fills in false.
  promptPlusOrders: z.boolean().default(false), // REQ-M05-01/02/05, M08-11 — false on onprem (REQ-M19-03)
  promptPlusSso: z.boolean().default(false),    // REQ-M01-01 — false on onprem
  scgFamily: z.boolean(),        // M13 — cloud only; never offered on onprem (OQ-A2)
});
export type Capabilities = z.infer<typeof Capabilities>;
export const Meta = z.object({
  edition: Edition,
  capabilities: Capabilities,
  shop: z.object({ name: z.string(), taxId: z.string(), branch: z.string(), vatRegistered: z.boolean(), b2bVatMode: z.enum(['inc', 'exc']) }),
  version: z.string(),
  /** On-prem first run: no shop yet; the web shows the setup screen (POST /api/setup). */
  needsSetup: z.boolean().default(false),
});
export type Meta = z.infer<typeof Meta>;
