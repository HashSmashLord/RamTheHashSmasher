import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { startApp } from './helpers/harness.js';

test('serves the frontend from src/ on the same origin as the API', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  const page = await s.get('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /HashRammers/);
  for (const [path, type] of [['/herd.html', /text\/html/], ['/herder.html', /text\/html/], ['/submit.html', /text\/html/], ['/rules.html', /text\/html/], ['/index.js', /javascript/], ['/herd.js', /javascript/], ['/ui.js', /javascript/], ['/styles.css', /text\/css/], ['/mock-data.js', /javascript/], ['/favicon.svg', /svg/], ['/fonts/archivo-variable.woff2', /woff2/]]) {
    const res = await s.get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), type, path);
  }
  // API still answers JSON with its own strict policy.
  const health = await s.get('/api/health');
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-security-policy'), /default-src 'none'/);
});

test('clean URLs (no .html) serve the same pages, and still work alongside the old .html links', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  for (const path of ['/herd', '/herder', '/submit', '/rules', '/launch']) {
    const clean = await s.get(path);
    const withExt = await s.get(`${path}.html`);
    assert.equal(clean.status, 200, path);
    assert.match(clean.headers.get('content-type'), /^text\/html/, path);
    assert.equal(await clean.text(), await withExt.text(), `${path} must serve the identical page as ${path}.html`);
  }
  // A real asset or a genuine 404 is never swallowed by the extensionless fallback.
  assert.equal((await s.get('/styles.css')).status, 200);
  assert.equal((await s.get('/nope')).status, 404);
});

test('static serving refuses unknown files, dotfiles and traversal', async (t) => {
  const s = await startApp();
  t.after(() => s.stop());
  assert.equal((await s.get('/nope.html')).status, 404);
  assert.equal((await s.get('/api/nope.js')).status, 404);
  assert.equal((await s.get('/.env')).status, 404);
  assert.equal((await s.get('/', { method: 'POST' })).status, 404);
  // Raw request so fetch() can't normalise the ../ away.
  const port = new URL(s.base).port;
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fserver%2fapp.js']) {
    const status = await new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('end', () => resolve(Number(data.split(' ')[1])));
      sock.on('error', reject);
    });
    assert.equal(status, 404, path);
  }
});
