// The desk viewer (src/sandbox-viewer.js): it must only ever embed the server's
// view-only E2B stream, and show a plain idle state otherwise.

import test from 'node:test';
import assert from 'node:assert/strict';
import { safeStreamUrl, loadDesk, createDeskViewer } from '../src/sandbox-viewer.js';
import { startApp } from './helpers/harness.js';

const GOOD = 'https://6080-ivvmlcp84hvtvuqqb4pvo.e2b.app/vnc.html?autoconnect=true&view_only=true&resize=scale&password=Ab3dEf7h';

test('safeStreamUrl accepts only a server-enforced view-only noVNC page on an E2B sandbox host', () => {
  assert.equal(safeStreamUrl({ viewOnly: 'server', streamUrl: GOOD }), GOOD);
  // view_only page parameter is put back if missing (cosmetic; the server enforces it)
  const noParam = GOOD.replace('&view_only=true', '');
  assert.match(safeStreamUrl({ viewOnly: 'server', streamUrl: noParam }), /view_only=true/);

  for (const [why, stream] of [
    ['null', null],
    ['client-side view-only is not enough', { viewOnly: 'client-side', streamUrl: GOOD }],
    ['no label', { streamUrl: GOOD }],
    ['http', { viewOnly: 'server', streamUrl: GOOD.replace('https:', 'http:') }],
    ['other port (e.g. a control listener)', { viewOnly: 'server', streamUrl: GOOD.replace('6080-', '6081-') }],
    ['other host', { viewOnly: 'server', streamUrl: 'https://6080-abc.evil.example/vnc.html' }],
    ['lookalike host', { viewOnly: 'server', streamUrl: 'https://6080-abc.e2b.app.evil.example/vnc.html' }],
    ['other path', { viewOnly: 'server', streamUrl: GOOD.replace('/vnc.html', '/x.html') }],
    ['javascript url', { viewOnly: 'server', streamUrl: 'javascript:alert(1)' }],
    ['credentials in url', { viewOnly: 'server', streamUrl: GOOD.replace('https://', 'https://u:p@') }],
    ['garbage', { viewOnly: 'server', streamUrl: 'not a url' }],
  ]) {
    assert.equal(safeStreamUrl(stream), null, why);
  }
});

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('loadDesk: live only for a safe stream; 404, off, unsafe and failures read as no desk', async () => {
  const calls = [];
  const live = await loadDesk('slot-0', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return res(200, { ok: true, enabled: true, stream: { sessionId: 'sbx1', viewOnly: 'server', streamUrl: GOOD, expiresAt: '2026-10-05T17:00:00.000Z' } });
    },
  });
  assert.deepEqual(live, { state: 'live', url: GOOD, expiresAt: '2026-10-05T17:00:00.000Z', sessionId: 'sbx1' });
  assert.equal(calls[0].url, '/api/slots/slot-0/stream');
  assert.equal(calls[0].init.credentials, 'omit');

  assert.deepEqual(await loadDesk('slot-0', { fetchImpl: async () => res(200, { ok: true, enabled: true, stream: null }) }), { state: 'idle', enabled: true });
  assert.deepEqual(await loadDesk('slot-0', { fetchImpl: async () => res(200, { ok: true, enabled: false, stream: null }) }), { state: 'idle', enabled: false });
  assert.deepEqual(await loadDesk('nope', { fetchImpl: async () => res(404, {}) }), { state: 'idle', enabled: false });
  assert.deepEqual(
    await loadDesk('slot-0', { fetchImpl: async () => res(200, { ok: true, enabled: true, stream: { viewOnly: 'client-side', streamUrl: GOOD } }) }),
    { state: 'idle', enabled: true },
  );
  assert.deepEqual(await loadDesk('slot-0', { fetchImpl: async () => res(500, {}) }), { state: 'unreachable' });
  assert.deepEqual(await loadDesk('slot-0', { fetchImpl: async () => { throw new TypeError('offline'); } }), { state: 'unreachable' });
  // ids are path-encoded
  let seen;
  await loadDesk('a/../b', { fetchImpl: async (u) => { seen = u; return res(404, {}); } });
  assert.equal(seen, '/api/slots/a%2F..%2Fb/stream');
});

// --- a tiny DOM, enough for the component ---
function fakeDoc() {
  const make = (tag) => {
    const node = {
      tag, children: [], attrs: {}, hidden: false, className: '', textContent: '', parent: null, src: '', title: '',
      classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } },
      replaceChildren(...kids) { this.children = []; this.append(...kids); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; },
    };
    return node;
  };
  return { createElement: make };
}

test('desk viewer: idle text with no sandbox, a sandboxed iframe for the live stream, back to idle when it stops', async () => {
  let next = { state: 'idle', enabled: true };
  const desk = createDeskViewer({ ramLabel: 'ram-01', slotId: 'slot-0', doc: fakeDoc(), load: async () => next });
  const [line, frame] = desk.el.children;
  assert.match(line.textContent, /Checking ram-01/);

  await desk.refresh();
  assert.match(line.textContent, /No desktop running for ram-01/);
  assert.equal(frame.hidden, true);
  assert.equal(frame.children.length, 0);
  assert.equal(desk.url, null);

  next = { state: 'live', url: GOOD, expiresAt: '2026-10-05T17:00:00.000Z', sessionId: 'sbx1' };
  await desk.refresh();
  assert.equal(desk.el.classList.contains('is-live'), true);
  assert.match(line.textContent, /View only/);
  assert.equal(frame.hidden, false);
  const iframe = frame.children[0];
  assert.equal(iframe.tag, 'iframe');
  assert.equal(iframe.src, GOOD);
  assert.equal(iframe.attrs.sandbox, 'allow-scripts allow-same-origin', 'no forms, popups or top navigation');
  assert.equal(iframe.referrerPolicy, 'no-referrer');

  // a poll with the same stream does not rebuild (reload) the frame
  await desk.refresh();
  assert.equal(frame.children[0], iframe);

  next = { state: 'idle', enabled: true };
  await desk.refresh();
  assert.equal(frame.hidden, true);
  assert.equal(frame.children.length, 0);
  assert.equal(desk.el.classList.contains('is-live'), false);

  next = { state: 'unreachable' };
  await desk.refresh();
  assert.match(line.textContent, /could not be reached/);

  desk.destroy();
  next = { state: 'live', url: GOOD };
  await desk.refresh();
  assert.equal(frame.children.length, 0, 'a destroyed viewer never embeds anything');
});

test('pages are allowed to frame only E2B sandbox hosts', async (t) => {
  const s = await startApp({ env: {} });
  t.after(() => s.stop());
  const page = await s.get('/');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /frame-src https:\/\/\*\.e2b\.app;/);
  assert.match(csp, /frame-ancestors 'none'/);
  const viewer = await s.get('/sandbox-viewer.js');
  assert.equal(viewer.status, 200);
});
