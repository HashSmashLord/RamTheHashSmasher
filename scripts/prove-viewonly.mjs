#!/usr/bin/env node
// Live proof that the public sandbox stream is view-only ON THE SERVER.
//
// Costs real money (one E2B desktop sandbox for well under a minute, ~$0.01).
// Refuses to run unless RAMHERD_PROVE_VIEWONLY=yes and E2B_API_KEY are set.
//
// What it does, against ONE real sandbox started through the production code
// path (createSandboxManager().start(), i.e. x11vnc -viewonly + noVNC):
//   0. Observers inside the sandbox: a focused terminal running `cat > /tmp/keys.txt`,
//      `xinput test-xi2 --root` logging raw X input events, `xdotool getmouselocation`.
//      Sanity: local xdotool input DOES show up in all of them.
//   1. PUBLIC endpoint (wss://6080-<id>.e2b.app/websockify, the URL the frontend
//      gets): a raw RFB client authenticates with the URL's password and sends
//      PointerEvents (moves + a button-1 click) and KeyEvents ("viewprobe" + Return).
//      Expect: pointer unchanged, nothing typed, no new raw input events.
//   2. POSITIVE CONTROL (test-only, never in production code): a second x11vnc on
//      the same desktop WITHOUT -viewonly (5901, noVNC 6081). Same RFB script.
//      Expect: pointer moves and "ctrlprobe" is typed. Proves the client script
//      really delivers input when the server allows it. Killed right after.
//   3. Raw RFB port 5900 through E2B's proxy, and envd without its access token:
//      both must be refused.
//   4. Kill the sandbox, confirm E2B no longer knows it, print the cost.
//
// Usage: set -a; . ./.env; set +a; RAMHERD_PROVE_VIEWONLY=yes node scripts/prove-viewonly.mjs

import { createCipheriv } from 'node:crypto';
import { createSandboxManager, estimateCostUsd } from '../server/lib/sandbox.js';

const apiKey = process.env.E2B_API_KEY;
if (process.env.RAMHERD_PROVE_VIEWONLY !== 'yes' || !apiKey) {
  console.error('Refusing: set RAMHERD_PROVE_VIEWONLY=yes and E2B_API_KEY (this bills real E2B time).');
  process.exit(2);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- RFB client

/** VNC auth: DES-encrypt the 16-byte challenge, key = password with each byte's bits reversed. */
export function vncAuthResponse(password, challenge) {
  const key = Buffer.alloc(8);
  Buffer.from(password, 'latin1').copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) {
    let b = key[i], r = 0;
    for (let j = 0; j < 8; j++) { r = (r << 1) | (b & 1); b >>= 1; }
    key[i] = r;
  }
  const c = createCipheriv('des-ede3-ecb', Buffer.concat([key, key, key]), null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(challenge), c.final()]);
}

async function rfbSession(wsUrl, password, actions) {
  const ws = new WebSocket(wsUrl, ['binary']);
  ws.binaryType = 'arraybuffer';
  let buf = Buffer.alloc(0);
  let waiter = null;
  let closed = null;
  ws.onmessage = (ev) => {
    buf = Buffer.concat([buf, Buffer.from(ev.data)]);
    waiter?.();
  };
  ws.onclose = (ev) => { closed = `closed ${ev.code}`; waiter?.(); };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`websocket error ${wsUrl}`)); });
  const read = async (n) => {
    const deadline = Date.now() + 15000;
    while (buf.length < n) {
      if (closed) throw new Error(`RFB ${closed} while reading`);
      if (Date.now() > deadline) throw new Error('RFB read timeout');
      await new Promise((r) => { waiter = r; setTimeout(r, 200); });
      waiter = null;
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  const send = (b) => ws.send(b);

  const version = (await read(12)).toString('latin1');
  send(Buffer.from('RFB 003.008\n', 'latin1'));
  const nTypes = (await read(1))[0];
  if (nTypes === 0) throw new Error('server refused: no security types');
  const types = [...(await read(nTypes))];
  if (!types.includes(2)) throw new Error(`no VNC auth offered: ${types}`);
  send(Buffer.from([2]));
  const challenge = Buffer.from(await read(16));
  send(vncAuthResponse(password, challenge));
  const result = (await read(4)).readUInt32BE(0);
  if (result !== 0) throw new Error(`VNC auth failed (${result})`);
  send(Buffer.from([1])); // ClientInit, shared
  const init = await read(24);
  const width = init.readUInt16BE(0), height = init.readUInt16BE(2);
  const name = (await read(init.readUInt32BE(20))).toString('latin1');

  const pointer = (mask, x, y) => {
    const b = Buffer.alloc(6); b[0] = 5; b[1] = mask; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); send(b);
  };
  const key = (down, keysym) => {
    const b = Buffer.alloc(8); b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(keysym, 4); send(b);
  };
  await actions({ pointer, key });
  await sleep(1500); // let the server process (or drop) everything
  const stillOpen = !closed;
  ws.close();
  return { version: version.trim(), securityTypes: types, width, height, name, authOk: true, stillOpen };
}

async function sendProbe(wsUrl, password, word) {
  return rfbSession(wsUrl, password, async ({ pointer, key }) => {
    for (const [x, y] of [[400, 300], [500, 350], [640, 400]]) { pointer(0, x, y); await sleep(60); }
    pointer(1, 640, 400); await sleep(60); pointer(0, 640, 400); // a left click
    for (const ch of word) { key(true, ch.charCodeAt(0)); key(false, ch.charCodeAt(0)); await sleep(30); }
    key(true, 0xff0d); key(false, 0xff0d); // Return
  });
}

// ---------------------------------------------------------------- run

const { Sandbox } = await import('@e2b/desktop');
const manager = createSandboxManager({ apiKey, timeoutMs: 4 * 60_000, maxConcurrent: 1 });
let sbx = null;
let sessionId = null;
let resources = null;
const t0 = Date.now();
let ranSeconds = null;
const evidence = {};

try {
  log('creating sandbox through createSandboxManager().start() ...');
  const info = await manager.start('proof');
  sessionId = info.sessionId;
  log('sandbox', sessionId, 'running; view-only stream verified by the manager');
  const pub = manager.getPublicStream('proof');
  const streamUrl = new URL(pub.streamUrl);
  const password = streamUrl.searchParams.get('password');
  const host = streamUrl.host;
  log('public stream page:', `https://${host}/vnc.html?...view_only=true&password=<redacted>`);

  sbx = await Sandbox.connect(sessionId, { apiKey });
  const sh = async (cmd, opts) => (await sbx.commands.run(cmd, { envs: { DISPLAY: ':0' }, ...opts }));
  try {
    const inf = await Sandbox.getInfo(sessionId, { apiKey });
    resources = { cpuCount: inf.cpuCount, memoryMB: inf.memoryMB };
  } catch { /* cost falls back to the stock template size below */ }
  evidence.envdTokenIssued = Boolean(sbx.envdAccessToken);

  evidence.x11vncProcesses = (await sh('ps -C x11vnc -o args=')).stdout.trim();
  log('x11vnc processes:\n  ' + evidence.x11vncProcesses);
  evidence.rfbListen = (await sh(`(ss -ltn 2>/dev/null || netstat -tln) | grep -E ':(5900|6080) ' || true`)).stdout.trim();
  log('listening sockets:\n  ' + evidence.rfbListen.split('\n').join('\n  '));

  // ---- observers
  const hasXterm = (await sh('command -v xterm || true')).stdout.trim() !== '';
  const hasXinput = (await sh('command -v xinput || true')).stdout.trim() !== '';
  const term = hasXterm
    ? `xterm -geometry 100x20+300+200 -title probe -e sh -c 'cat > /tmp/keys.txt'`
    : `xfce4-terminal --disable-server --geometry 100x20+300+200 -T probe -x sh -c 'cat > /tmp/keys.txt'`;
  await sh(term, { background: true, timeoutMs: 0 });
  await sleep(2500);
  await sh(`xdotool search --sync --name probe | head -1 | xargs -I{} xdotool windowactivate --sync {} 2>/dev/null || true`);
  if (hasXinput) await sh('xinput test-xi2 --root > /tmp/xi.log 2>&1', { background: true, timeoutMs: 0 });
  await sleep(800);

  const observe = async () => {
    const loc = (await sh('xdotool getmouselocation')).stdout.trim();
    const keys = (await sh('cat /tmp/keys.txt 2>/dev/null || true')).stdout;
    const xi = hasXinput
      ? (await sh(`grep -cE 'EVENT type [0-9]+ \\((RawMotion|RawButtonPress|RawKeyPress|ButtonPress|KeyPress|Motion)\\)' /tmp/xi.log || true`)).stdout.trim()
      : 'n/a';
    return { pointer: loc, typed: JSON.stringify(keys), rawInputEvents: xi };
  };

  // ---- sanity: local input reaches the observers
  await sh('xdotool mousemove 20 20');
  await sleep(300);
  const before0 = await observe();
  await sh('xdotool search --name probe | head -1 | xargs -I{} xdotool windowactivate --sync {} 2>/dev/null; xdotool type --delay 20 localok; xdotool key Return; xdotool mousemove 20 20');
  await sleep(800);
  const afterLocal = await observe();
  evidence.sanity = { before: before0, afterLocalXdotool: afterLocal };
  log('SANITY (local xdotool input):', JSON.stringify(evidence.sanity));
  if (!afterLocal.typed.includes('localok')) throw new Error('observer broken: local typing did not reach the terminal; proof would be meaningless');

  // ---- 1. public view-only endpoint
  await sh('xdotool mousemove 20 20');
  await sleep(300);
  const beforePub = await observe();
  const pubSession = await sendProbe(`wss://${host}/websockify`, password, 'viewprobe');
  const afterPub = await observe();
  evidence.publicViewOnly = { session: pubSession, before: beforePub, after: afterPub };
  log('PUBLIC (x11vnc -viewonly):', JSON.stringify(evidence.publicViewOnly));

  // ---- 2. positive control: same script against an x11vnc WITHOUT -viewonly (test-only)
  await sh(`x11vnc -bg -forever -shared -wait 50 -display :0 -rfbport 5901 -localhost -usepw -o /tmp/x11vnc-control.log`);
  await sh(`cd /opt/noVNC/utils && ./novnc_proxy --vnc localhost:5901 --listen 6081 --web /opt/noVNC > /tmp/novnc-control.log 2>&1`, { background: true, timeoutMs: 0 });
  await sh(`for i in $(seq 1 75); do (ss -ltn 2>/dev/null || netstat -tln) | grep -q ':6081 ' && exit 0; sleep 0.2; done; exit 1`);
  await sh('xdotool search --name probe | head -1 | xargs -I{} xdotool windowactivate --sync {} 2>/dev/null; xdotool mousemove 20 20');
  await sleep(300);
  const beforeCtl = await observe();
  const ctlSession = await sendProbe(`wss://${sbx.getHost(6081)}/websockify`, password, 'ctrlprobe');
  const afterCtl = await observe();
  evidence.positiveControl = { session: ctlSession, before: beforeCtl, after: afterCtl };
  log('CONTROL (x11vnc without -viewonly, test-only):', JSON.stringify(evidence.positiveControl));
  await sh(`pkill -f 'rfbport 590[1]' || true`); // bracket: don't match this shell itself

  // ---- 3. other doors
  const tryFetch = async (url, init) => {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
      return `HTTP ${r.status}`;
    } catch (e) { return `error: ${e.cause?.code || e.message}`; }
  };
  evidence.rawRfbPort5900 = await tryFetch(`https://${sbx.getHost(5900)}/`);
  evidence.envdWithoutToken = await tryFetch(`https://${sbx.getHost(49983)}/process.Process/List`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  log('raw port 5900 via E2B proxy:', evidence.rawRfbPort5900, '| envd without token:', evidence.envdWithoutToken, '| envd token issued:', evidence.envdTokenIssued);

  // ---- verdict
  const moved = (e) => e.before.pointer !== e.after.pointer;
  const typed = (e, w) => e.after.typed.includes(w);
  const rawDelta = (e) => (hasXinput ? Number(e.after.rawInputEvents) - Number(e.before.rawInputEvents) : null);
  evidence.verdict = {
    publicPointerMoved: moved(evidence.publicViewOnly),
    publicTyped: typed(evidence.publicViewOnly, 'viewprobe'),
    publicRawInputEventsDelta: rawDelta(evidence.publicViewOnly),
    controlPointerMoved: moved(evidence.positiveControl),
    controlTyped: typed(evidence.positiveControl, 'ctrlprobe'),
    controlRawInputEventsDelta: rawDelta(evidence.positiveControl),
  };
  const v = evidence.verdict;
  evidence.pass = !v.publicPointerMoved && !v.publicTyped && (v.publicRawInputEventsDelta ?? 0) === 0 && v.controlPointerMoved && v.controlTyped;
  log('VERDICT:', JSON.stringify(v), evidence.pass ? 'PASS' : 'FAIL');
} catch (err) {
  log('ERROR:', String(err?.message || err).split(apiKey).join('[redacted]'));
  evidence.error = String(err?.message || err).split(apiKey).join('[redacted]');
} finally {
  const stopped = await manager.stopAll();
  ranSeconds = (Date.now() - t0) / 1000;
  if (sessionId) {
    try { await Sandbox.kill(sessionId, { apiKey }); } catch { /* already gone */ }
    let gone;
    try { await Sandbox.getInfo(sessionId, { apiKey }); gone = 'still exists?!'; } catch (e) { gone = `getInfo -> ${e.name || 'error'}: ${String(e.message).slice(0, 80)}`; }
    let running = 'unknown';
    try {
      const p = Sandbox.list({ apiKey });
      const items = typeof p.nextItems === 'function' ? await p.nextItems() : await p;
      running = String(items.length);
    } catch (e) { running = `list failed: ${e.message}`; }
    log('stopAll:', JSON.stringify(stopped), '| after kill:', gone, '| sandboxes still running on account:', running);
  }
  const r = resources ?? { cpuCount: 8, memoryMB: 8192 };
  log(`ran ${ranSeconds.toFixed(1)} s at ${r.cpuCount} vCPU / ${r.memoryMB} MiB, est. cost $${estimateCostUsd({ seconds: ranSeconds, ...r }).toFixed(4)}`);
  process.exitCode = evidence.pass ? 0 : 1;
}
