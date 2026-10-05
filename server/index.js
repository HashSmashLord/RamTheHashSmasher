import { loadConfig, loadDotEnv } from './config.js';
import { createApp } from './app.js';

loadDotEnv();
const config = loadConfig();
if (config.adminToken === 'dev-admin-token') {
  console.warn('herd: using the default dev admin token. Set ADMIN_TOKEN before exposing this beyond localhost.');
}
const app = createApp(config);
const address = await app.listen();
console.log(`herd listening on http://${address.address}:${address.port}`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
