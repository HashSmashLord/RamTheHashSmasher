import { loadConfig, loadDotEnv } from './config.js';
import { createApp } from './app.js';
import { autoSeedPolicy, seedRosterFunding, startRosterSandboxes } from './lib/autoseed.js';

loadDotEnv();
const config = loadConfig();
if (config.adminToken === 'dev-admin-token') {
  console.warn('herd: using the default dev admin token. Set ADMIN_TOKEN before exposing this beyond localhost.');
}
const app = createApp(config);
// Auto-seed (opt-in, RAMHERD_AUTO_SEED=true; see lib/autoseed.js). createApp
// has already built the whole store (ledger, slot and sandbox managers), so
// funding + reallocation run here, awaited, before listen: the first request
// sees funded slots. Sandbox starts take seconds each, so they run after
// listen in the background and never block or crash boot.
const autoSeed = autoSeedPolicy(process.env);
const seeded = autoSeed.enabled ? await seedRosterFunding(app.store, { budgetConfig: config.budget, log: config.log }) : null;
const address = await app.listen();
console.log(`herd listening on http://${address.address}:${address.port}`);
if (seeded?.ok) startRosterSandboxes(app.store, { log: config.log });

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
