// Bundles src/main.ts -> dist-cloud/server.mjs with EDITION=cloud baked in.
import { runCli } from './build.lib.mjs';

await runCli('cloud');
