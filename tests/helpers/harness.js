import { createApp } from '../../server/app.js';
import { loadConfig } from '../../server/config.js';

/**
 * Starts a real app instance on an ephemeral port for integration tests.
 * @param {object} [overrides] - passed straight into loadConfig's overrides.
 */
export async function startApp(overrides = {}) {
  const config = loadConfig(process.env, { port: 0, log: () => {}, ...overrides });
  const app = createApp(config);
  const address = await app.listen();
  const base = `http://127.0.0.1:${address.port}`;

  function get(path, opts = {}) {
    return fetch(`${base}${path}`, { method: 'GET', ...opts });
  }

  function postJson(path, body, opts = {}) {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: JSON.stringify(body),
      ...opts,
    });
  }

  function adminHeaders(extra = {}) {
    return { 'x-admin-token': config.adminToken, ...extra };
  }

  return {
    base,
    config,
    app,
    store: app.store,
    get,
    postJson,
    adminHeaders,
    stop: () => app.close(),
  };
}
