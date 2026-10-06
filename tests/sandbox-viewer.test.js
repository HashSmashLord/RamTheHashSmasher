// The desk viewer (src/sandbox-viewer.js): it must only ever embed the server's
// view-only E2B stream, and show a plain idle state otherwise.

import test from 'node:test';
import assert from 'node:assert/strict';
import { safeStreamUrl, loadDesk, createDeskViewer, createDeskDirectory, deskWhy } from '../src/sandbox-viewer.js';
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

test('desk viewer: the live iframe reloads periodically, so a dropped noVNC websocket (stuck on its own Connect button) cannot persist forever', async () => {
  let clock = 1_000_000;
  const next = { state: 'live', url: GOOD, expiresAt: '2026-10-05T17:00:00.000Z', sessionId: 'sbx1' };
  const desk = createDeskViewer({ ramLabel: 'ram-01', slotId: 'slot-0', doc: fakeDoc(), load: async () => next, now: () => clock });
  const [, frame] = desk.el.children;

  await desk.refresh();
  const first = frame.children[0];
  assert.equal(first.src, GOOD);

  // well under the reload interval: same stream, same iframe, no reload
  clock += 30_000;
  await desk.refresh();
  assert.equal(frame.children[0], first);

  // past the reload interval: same stream URL, but a fresh iframe -- this is
  // what re-triggers noVNC's own autoconnect after a silent disconnect
  clock += 70_000;
  await desk.refresh();
  const second = frame.children[0];
  assert.notEqual(second, first, 'a new iframe element, not the same one left stale');
  assert.equal(second.src, GOOD);
  assert.equal(frame.children.length, 1, 'the stale iframe is replaced, not appended alongside');

  desk.destroy();
});

// --- why there is no desk: one honest line per real state ---

test('deskWhy reads the slot record: never / starting / stopped / expired / ended / failed', () => {
  assert.equal(deskWhy(null), 'never');
  assert.equal(deskWhy(undefined), 'never');
  assert.equal(deskWhy({ status: 'running' }), 'never', 'a running desk is shown, not explained');
  assert.equal(deskWhy({ status: 'starting' }), 'starting');
  assert.equal(deskWhy({ status: 'stopped' }), 'stopped');
  assert.equal(deskWhy({ status: 'expired', endedBy: 'timeout' }), 'expired');
  assert.equal(deskWhy({ status: 'expired', endedBy: 'provider' }), 'ended');
  assert.equal(deskWhy({ status: 'expired' }), 'expired');
  assert.equal(deskWhy({ status: 'failed', error: 'E2B sandbox create failed: ...' }), 'failed');
  assert.equal(deskWhy({ status: 'something-new' }), 'never', 'unknown states fall back to the plain line');
});

test('loadDesk carries the stream route\'s why; without one (demo, older server) it stays the plain idle', async () => {
  const failed = await loadDesk('slot-1', { fetchImpl: async () => res(200, { ok: true, enabled: true, stream: null, sandbox: { status: 'failed', endedBy: null } }) });
  assert.deepEqual(failed, { state: 'idle', enabled: true, why: 'failed' });
  const expired = await loadDesk('slot-0', { fetchImpl: async () => res(200, { ok: true, enabled: true, stream: null, sandbox: { status: 'expired', endedBy: 'timeout' } }) });
  assert.deepEqual(expired, { state: 'idle', enabled: true, why: 'expired' });
  const never = await loadDesk('slot-0', { fetchImpl: async () => res(200, { ok: true, enabled: true, stream: null, sandbox: null }) });
  assert.deepEqual(never, { state: 'idle', enabled: true, why: 'never' });
  const old = await loadDesk('slot-0', { fetchImpl: async () => res(200, { ok: true, enabled: true, stream: null }) });
  assert.deepEqual(old, { state: 'idle', enabled: true });
});

test('the desk directory says why from one /api/slots listing and asks for a stream only when one runs', async () => {
  const slots = [
    { id: 'slot-0', sandbox: null },
    { id: 'slot-1', sandbox: { status: 'stopped' } },
    { id: 'slot-2', sandbox: { status: 'expired', endedBy: 'timeout' } },
    { id: 'slot-3', sandbox: { status: 'failed', error: 'x' } },
    { id: 'slot-4', sandbox: { status: 'running', sessionId: 'sbx9' } },
    { id: 'slot-5', sandbox: { status: 'starting' } },
  ];
  const asked = [];
  const dir = createDeskDirectory({
    fetchImpl: async (url) => { asked.push(url); return res(200, { ok: true, slots, sandboxes: { enabled: true } }); },
    load: async (id) => ({ state: 'live', url: GOOD, expiresAt: null, sessionId: id }),
  });
  await dir.refresh();
  assert.deepEqual(await dir.load('slot-0'), { state: 'idle', enabled: true, why: 'never' });
  assert.deepEqual(await dir.load('slot-1'), { state: 'idle', enabled: true, why: 'stopped' });
  assert.deepEqual(await dir.load('slot-2'), { state: 'idle', enabled: true, why: 'expired' });
  assert.deepEqual(await dir.load('slot-3'), { state: 'idle', enabled: true, why: 'failed' });
  assert.deepEqual(await dir.load('slot-5'), { state: 'idle', enabled: true, why: 'starting' });
  assert.deepEqual(await dir.load('nope'), { state: 'idle', enabled: true }, 'an unknown slot has no record to read');
  assert.equal((await dir.load('slot-4')).state, 'live');
  assert.deepEqual(asked, ['/api/slots'], 'one listing; the stream fetch is the injected load');
});

test('desk viewer: each no-desk state gets its own honest line and badge; the demo path is unchanged', async () => {
  let next = { state: 'idle', enabled: false };
  const copy = { stopped: (l) => `${l} finished its visible desk session; back to working on the host.` };
  const desk = createDeskViewer({ ramLabel: 'ram-01', slotId: 'slot-0', doc: fakeDoc(), load: async () => next, copy });
  const [line, , badge] = desk.el.children;

  await desk.refresh(); // demo mode: no why at all
  assert.match(line.textContent, /No desktop running for ram-01/);
  assert.equal(badge.textContent, 'No desk running');

  next = { state: 'idle', enabled: true, why: 'never' };
  await desk.refresh();
  assert.match(line.textContent, /No desktop running for ram-01/);
  assert.equal(badge.textContent, 'No desk running');

  next = { state: 'idle', enabled: true, why: 'stopped' };
  await desk.refresh();
  assert.equal(line.textContent, 'ram-01 finished its visible desk session; back to working on the host.', 'a page\'s own copy wins');
  assert.equal(badge.textContent, 'Desk session done');

  next = { state: 'idle', enabled: true, why: 'expired' };
  await desk.refresh();
  assert.match(line.textContent, /ran its full time/);
  assert.equal(badge.textContent, 'Desk session done');

  next = { state: 'idle', enabled: true, why: 'ended' };
  await desk.refresh();
  assert.match(line.textContent, /closed before its scheduled stop/);
  assert.equal(badge.textContent, 'Desk session closed');

  next = { state: 'idle', enabled: true, why: 'failed' };
  await desk.refresh();
  assert.match(line.textContent, /could not start this time; it is still working on the host/);
  assert.equal(badge.textContent, 'Desk did not start');

  next = { state: 'idle', enabled: true, why: 'starting' };
  await desk.refresh();
  assert.match(line.textContent, /desk is starting/);
  assert.equal(badge.textContent, 'Desk starting');

  next = { state: 'idle', enabled: true, why: 'not-a-state' };
  await desk.refresh();
  assert.match(line.textContent, /No desktop running for ram-01/, 'unknown why falls back to idle');
  assert.equal(badge.textContent, 'No desk running');
  for (const el of [line, badge]) assert.equal(el.textContent.includes('!'), false);
  assert.equal(desk.el.classList.contains('is-live'), false);
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
