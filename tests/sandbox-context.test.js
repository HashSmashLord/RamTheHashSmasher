// On-screen context banner (server/lib/sandbox-context.js) and its slots.js
// wiring. Every test uses a FAKE desktop: no real sandbox is created here (each
// would bill real E2B time). The real end-to-end run is
// scripts/prove-sandbox-task.mjs, opt-in only, which screenshots the banner.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextHeader, contextNowLine, contextPayload, writeContextCommand, writeFileCommand, bannerScript,
  launchBannerCommand, startContextBanner, updateContextBanner, contextBanner,
  STOP_BANNER_COMMAND, FIND_BANNER_COMMAND, CONTEXT_FILE, BANNER_SCRIPT, BANNER_TITLE, MAX_NOW_CHARS,
} from '../server/lib/sandbox-context.js';
import { ACTIVE_TRACKS, assignmentForIndex } from '../server/lib/targets.js';
import { createSandboxManager } from '../server/lib/sandbox.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createMockLlmProvider } from '../server/lib/llm.js';

/**
 * A fake desktop that behaves like the real one where the banner depends on it:
 * files written through writeFileCommand land in `files` (decoded the way the
 * real `base64 -d` would), launching the banner makes its window findable.
 */
function fakeDesktop({ noWindow = false, failWrites = false } = {}) {
  const log = [];
  const state = { files: new Map(), launched: 0, contextWrites: [] };
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
  const sbx = {
    commands: {
      run: async (cmd, opts = {}) => {
        log.push({ cmd, opts });
        const w = /^mkdir -p \S+ && printf %s '([A-Za-z0-9+/=]*)' \| base64 -d > (\S+)\.tmp && mv -f \2\.tmp \2$/.exec(cmd);
        if (w) {
          if (failWrites) throw new Error('sandbox is gone');
          const text = Buffer.from(w[1], 'base64').toString('utf8');
          state.files.set(w[2], text);
          if (w[2] === CONTEXT_FILE) state.contextWrites.push(JSON.parse(text));
          return ok();
        }
        if (cmd.includes(`exec python3 ${BANNER_SCRIPT}`)) { state.launched++; return ok(); }
        if (cmd === FIND_BANNER_COMMAND) return ok(state.launched && !noWindow ? '52428803\n' : '');
        if (cmd.startsWith('tail -n 5')) return ok("ValueError: Namespace GdkX11 not available\n");
        return ok();
      },
    },
  };
  return { sbx, log, state };
}

const r31 = () => ({ ...ACTIVE_TRACKS[0], approach: 'literature-replication', model: 'anthropic/claude-opus-5.5' });

test('header names the RAM, its hash, rounds, approach and model, from the assignment', () => {
  assert.equal(
    contextHeader({ slotId: 'slot-0', assignment: r31() }),
    'RAM slot-0 · SHA-256, 31 rounds · literature-replication approach · model anthropic/claude-opus-5.5',
  );
  assert.equal(
    contextHeader({ slotId: 'slot-7', ramId: 'ram-abc', assignment: { ...ACTIVE_TRACKS[4], approach: 'structural-shortcut', model: 'x/y' } }),
    'RAM ram-abc (slot-7) · BLAKE3, 1 round · structural-shortcut approach · model x/y',
  );
});

test('every roster assignment gets its own real header (not hardcoded to one track)', () => {
  const headers = ACTIVE_TRACKS.map((_, i) => contextHeader({ slotId: `slot-${i}`, assignment: assignmentForIndex(i) }));
  assert.equal(new Set(headers).size, ACTIVE_TRACKS.length);
  ACTIVE_TRACKS.forEach((t, i) => {
    assert.ok(headers[i].includes(`${t.hashFunction}, ${t.rounds} round${t.rounds === 1 ? '' : 's'} ·`), headers[i]);
    assert.ok(headers[i].includes(`model ${t.defaultModel}`), headers[i]);
  });
});

test('status line is the real status plus the latest feed entry, verbatim', () => {
  assert.equal(contextNowLine({ status: 'idle', feed: [] }), 'Status: idle · no activity yet');
  const feed = [
    { ts: '2026-10-05T21:00:00.000Z', type: 'activated', message: 'old' },
    { ts: '2026-10-05T21:15:02.123Z', type: 'sandbox-task-step', message: 'Desktop terminal: `git clone x` (exit 0).' },
  ];
  assert.equal(
    contextNowLine({ status: 'thinking', feed }),
    'Status: thinking · latest (21:15:02 UTC): Workbench: Desktop terminal: `git clone x` (exit 0).',
  );
  // unknown types are shown as-is, multi-line messages become one line
  assert.equal(
    contextNowLine({ status: 'idle', feed: [{ ts: 'n/a', type: 'pipeline-check', message: 'a\n  b' }] }),
    'Status: idle · latest: pipeline-check: a b',
  );
});

test('long messages are clipped with an ellipsis, never silently cut', () => {
  const line = contextNowLine({ status: 'thinking', feed: [{ ts: '2026-10-05T00:00:00Z', type: 'thinking', message: 'x'.repeat(1000) }] });
  assert.ok(line.endsWith('…'));
  assert.equal(line.split(': ').at(-1).length, MAX_NOW_CHARS);
});

test('context text reaches the shell only as base64: hostile feed text is never parsed', () => {
  const evil = `it's "$(rm -rf ~)" \`id\` ; echo pwned > /tmp/x`;
  const cmd = writeContextCommand({ header: evil, now: evil });
  assert.ok(!cmd.includes('rm -rf'));
  assert.ok(!cmd.includes('`'));
  assert.match(cmd, /^mkdir -p \/tmp\/ramctx && printf %s '[A-Za-z0-9+/=]+' \| base64 -d > \/tmp\/ramctx\/context\.json\.tmp && mv -f \/tmp\/ramctx\/context\.json\.tmp \/tmp\/ramctx\/context\.json$/);
  const b64 = cmd.match(/'([^']+)'/)[1];
  assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), { header: evil, now: evil });
});

test('the banner is a strut-reserving dock above everything, re-reading the context file', () => {
  const py = bannerScript();
  assert.match(py, /WindowTypeHint\.DOCK/);
  assert.match(py, /set_keep_above\(True\)/);
  assert.match(py, /set_accept_focus\(False\)/);
  assert.match(py, /_NET_WM_STRUT_PARTIAL/);
  assert.match(py, /_NET_WORKAREA/);
  assert.match(py, /GLib\.timeout_add\(1000, refresh\)/);
  assert.ok(py.includes(`Gtk.Window(title='${BANNER_TITLE}')`));
  // the stop command goes by pid file: `pkill -f` would match (and kill) its own shell
  assert.ok(!STOP_BANNER_COMMAND.includes('pkill'));
  assert.match(launchBannerCommand(), /^echo \$\$ > \/tmp\/ramctx\/banner\.pid && exec python3 /);
});

test('startContextBanner writes the script and context, launches in the background, finds the window', async () => {
  const d = fakeDesktop();
  const payload = contextPayload({ slotId: 'slot-0', assignment: r31(), status: 'idle', feed: [] });
  const res = await startContextBanner(d.sbx, payload);
  assert.deepEqual(res, { windowId: '52428803' });
  assert.equal(d.log[0].cmd, STOP_BANNER_COMMAND);
  assert.equal(d.state.files.get(BANNER_SCRIPT), bannerScript());
  assert.deepEqual(d.state.contextWrites, [payload]);
  const launch = d.log.find((l) => l.cmd.includes('exec python3'));
  assert.deepEqual(launch.opts, { background: true, timeoutMs: 0 });
  assert.equal(d.state.launched, 1);
});

test('no banner window -> error carrying the banner log tail', async () => {
  const d = fakeDesktop({ noWindow: true });
  await assert.rejects(startContextBanner(d.sbx, { header: 'h', now: 'n' }), /context banner window did not appear: ValueError: Namespace GdkX11/);
});

test('updateContextBanner only rewrites the context file', async () => {
  const d = fakeDesktop();
  await updateContextBanner(d.sbx, { header: 'h', now: 'n2' });
  assert.equal(d.log.length, 1);
  assert.deepEqual(d.state.contextWrites, [{ header: 'h', now: 'n2' }]);
  assert.equal(contextBanner.start, startContextBanner);
  assert.equal(contextBanner.update, updateContextBanner);
});

// ---- slots.js wiring, through the real sandbox manager with a fake SDK ----

function fakeSdk(desktopOpts) {
  const desks = [];
  class Sandbox {
    static async create() {
      const d = fakeDesktop(desktopOpts);
      const base = d.sbx.commands.run;
      let x11 = [];
      const sbx = {
        sandboxId: `sbx${desks.length + 1}`,
        display: ':0',
        getHost: (p) => `${p}-sbx${desks.length}.e2b.app`,
        kill: async () => true,
        commands: {
          run: async (cmd, opts) => {
            if (cmd.startsWith('x11vnc -bg')) { x11.push(cmd); return { exitCode: 0, stdout: '', stderr: '' }; }
            if (cmd.startsWith('pkill -x x11vnc')) { x11 = []; return { exitCode: 0, stdout: '', stderr: '' }; }
            if (cmd.startsWith('ps -C x11vnc')) return { exitCode: 0, stdout: `${x11.join('\n')}\n`, stderr: '' };
            return base(cmd, opts);
          },
        },
      };
      desks.push(d);
      return sbx;
    }
    static async kill() { return true; }
  }
  return { desks, loadSdk: async () => ({ Sandbox }) };
}

function slotsWithContext(sdk, extra = {}) {
  const sandboxManager = createSandboxManager({ apiKey: 'e2b_fakekeyfortests0123456789', loadSdk: sdk.loadSdk });
  return createSlotManager({ llmProvider: createMockLlmProvider(), sandboxManager, sandboxContext: contextBanner, ...extra });
}

test('startSandbox puts the banner up with the slot\'s real assignment, and logs it to the feed', async () => {
  const sdk = fakeSdk();
  const m = slotsWithContext(sdk);
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  const snap = await m.startSandbox(id);
  assert.equal(snap.feed.at(-1).type, 'sandbox-started'); // returns before the banner
  await m.waitForSandboxContext(id);
  const slot = m.getSlot(id);
  assert.equal(slot.feed.at(-1).type, 'sandbox-context-started');
  const writes = sdk.desks[0].state.contextWrites;
  assert.equal(writes[0].header, contextHeader({ slotId: id, assignment: slot.assignment }));
  // the banner's text always ends on the slot's real latest entry
  assert.deepEqual(writes.at(-1), contextPayload({ slotId: id, assignment: slot.assignment, status: slot.status, feed: slot.feed }));
});

test('every later feed entry updates the banner with the real latest entry', async () => {
  const sdk = fakeSdk();
  const m = slotsWithContext(sdk);
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  await m.startSandbox(id);
  await m.waitForSandboxContext(id);
  await m.advance(id); // idle -> thinking: the mock LLM's real reply lands in the feed
  await m.waitForSandboxContext(id);
  const slot = m.getSlot(id);
  const last = sdk.desks[0].state.contextWrites.at(-1);
  assert.equal(slot.status, 'thinking');
  assert.ok(last.now.startsWith('Status: thinking · latest ('), last.now);
  assert.ok(last.now.includes(slot.feed.at(-1).message.replace(/\s+/g, ' ').trim().slice(0, 40)));
});

test('a burst of feed entries is coalesced, and the final write is the newest state', async () => {
  const sdk = fakeSdk();
  const m = slotsWithContext(sdk);
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  await m.startSandbox(id);
  await m.waitForSandboxContext(id);
  const before = sdk.desks[0].state.contextWrites.length;
  for (let i = 0; i < 10; i++) m.attachSuggestion(id, { id: `i${i}`, text: `idea ${i}` });
  await m.waitForSandboxContext(id);
  const writes = sdk.desks[0].state.contextWrites.slice(before);
  assert.ok(writes.length >= 1 && writes.length <= 2, `expected coalesced writes, got ${writes.length}`);
  assert.match(writes.at(-1).now, /Viewer suggestion: Viewer suggestion attached: "idea 9"/);
});

test('each RAM\'s sandbox gets its own banner with its own assignment', async () => {
  const sdk = fakeSdk();
  const m = slotsWithContext(sdk);
  m.setSlotCount(3);
  const ids = m.getSlots().map((s) => s.id);
  for (const id of ids) await m.startSandbox(id);
  for (const id of ids) await m.waitForSandboxContext(id);
  ids.forEach((id, i) => {
    const head = sdk.desks[i].state.contextWrites[0].header;
    assert.ok(head.startsWith(`RAM ${id} · ${ACTIVE_TRACKS[i].hashFunction}, ${ACTIVE_TRACKS[i].rounds} rounds ·`), head);
    assert.equal(sdk.desks[i].state.launched, 1);
  });
});

test('once the sandbox is stopped, feed entries no longer touch it', async () => {
  const sdk = fakeSdk();
  const m = slotsWithContext(sdk);
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  await m.startSandbox(id);
  await m.waitForSandboxContext(id);
  await m.stopSandbox(id);
  const n = sdk.desks[0].log.length;
  await m.advance(id);
  await m.waitForSandboxContext(id);
  assert.equal(sdk.desks[0].log.length, n);
});

test('a banner that cannot start lands in the feed, never fails the start, and is not updated', async () => {
  const sdk = fakeSdk({ noWindow: true });
  const m = slotsWithContext(sdk);
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  const snap = await m.startSandbox(id);
  assert.equal(snap.sandbox.status, 'running');
  await m.waitForSandboxContext(id);
  assert.equal(m.getSlot(id).feed.at(-1).type, 'sandbox-context-error');
  assert.match(m.getSlot(id).feed.at(-1).message, /context banner window did not appear/);
  const writes = sdk.desks[0].state.contextWrites.length;
  await m.advance(id);
  await m.waitForSandboxContext(id);
  assert.equal(sdk.desks[0].state.contextWrites.length, writes);
});

test('without sandboxContext, starting a sandbox draws no banner (opt-in wiring)', async () => {
  const sdk = fakeSdk();
  const sandboxManager = createSandboxManager({ apiKey: 'e2b_fakekeyfortests0123456789', loadSdk: sdk.loadSdk });
  const m = createSlotManager({ llmProvider: createMockLlmProvider(), sandboxManager });
  m.setSlotCount(1);
  const id = m.getSlots()[0].id;
  await m.startSandbox(id);
  await m.waitForSandboxContext(id);
  assert.equal(sdk.desks[0].state.launched, 0);
  assert.equal(m.getSlot(id).feed.at(-1).type, 'sandbox-started');
});

test('writeFileCommand is the one write path (script and context alike)', () => {
  assert.match(writeFileCommand('/tmp/ramctx/x', 'hi'), /printf %s 'aGk=' \| base64 -d > \/tmp\/ramctx\/x\.tmp/);
});
