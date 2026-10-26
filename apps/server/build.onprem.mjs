// Bundles src/main.ts -> dist-onprem/server.mjs with EDITION=onprem baked in.
// Every import matching /promptplus/i is replaced by an empty stub module.
// Verify the result with: node scripts/check-onprem.mjs apps/server/dist-onprem
import { runCli } from './build.lib.mjs';

await runCli('onprem');
