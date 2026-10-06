import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createRateLimiter } from './lib/ratelimit.js';
import { createLaunchpadRoutes } from './launchpad-routes.js';

const SECURITY_HEADERS = {
  // JSON-only API: no document is ever rendered, so the strictest policy applies.
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// The static frontend (src/) is served from the same origin as the API, so one
// deployable unit answers both. Pages get a CSP that allows same-origin assets only.
const DEFAULT_STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
// frame-src: the only thing a page may embed is an E2B sandbox's noVNC page
// (https://6080-<id>.e2b.app), the server-side view-only stream; see lib/sandbox.js.
// connect-src: same-origin (the API) plus the Solana RPC the launch page's
// browser-side signing talks to directly (src/launch.js's signAndSendLaunch,
// via web3.Connection) — never routed through our own server, so it needs its
// own allowance. api.mainnet-beta.solana.com/api.devnet.solana.com are kept as
// a fallback only: the public mainnet one actively refuses every browser-origin
// request with 403 "Access forbidden" (confirmed 2026-10-06, not theoretical).
// The real one in use is whatever SOLANA_RPC_URL is set to (server/config.js) —
// Helius today (CORS-open, confirmed) — read by the client from GET
// /api/launchpad/config. *.publicnode.com kept as the CORS-open free fallback.
// img-src also allows Pinata's gateway (server/lib/pinata.js's GATEWAY) --
// every launched RAM's token image is served from there, not same-origin;
// without this every such image is silently blocked by the browser, not a
// 404 (confirmed real 2026-10-06 on the live Discover page).
const PAGE_CSP =
  "default-src 'self'; img-src 'self' data: https://gateway.pinata.cloud; frame-src https://*.e2b.app; connect-src 'self' https://*.helius-rpc.com https://*.publicnode.com https://api.mainnet-beta.solana.com https://api.devnet.solana.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const ERROR_MESSAGES = {
  not_found: 'Not found.',
  method_not_allowed: 'Method not allowed.',
  bad_request: 'Bad request.',
  invalid_body: 'That request could not be read.',
  too_large: 'That request was too large.',
  unauthorized: 'Missing or invalid admin token.',
  rate_limited: 'Too many idea submissions from here. Please try again later.',
  server_error: 'Something went wrong on our side. Please try again later.',
};

function clientAddress(req, trustProxy) {
  if (trustProxy > 0) {
    const header = req.headers['x-forwarded-for'];
    if (header) {
      const parts = header.split(',').map((s) => s.trim());
      const index = Math.max(0, parts.length - trustProxy);
      if (parts[index]) return parts[index];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let tooLarge = Number.isFinite(declared) && declared > limit;
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      if (size > limit * 16) return req.destroy();
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => (tooLarge ? reject(Object.assign(new Error('too_large'), { code: 'too_large' })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
    req.on('close', () => {
      if (!req.complete) reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
    });
  });
}

// Constant-time admin-token check. Both sides are SHA-256 hashed first, so the
// buffers handed to timingSafeEqual are always 32 bytes: a wrong token of a
// different length is simply rejected (timingSafeEqual would throw on unequal
// lengths) and the compare time doesn't reveal the real token's length.
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || !given || typeof expected !== 'string' || !expected) return false;
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

// Request-derived text (route labels are built from the decoded URL path)
// must not be able to forge log lines: control characters such as a decoded
// %0A or %0D are escaped to a visible \xNN form instead of written raw.
export function safeLogField(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function parseJson(raw) {
  const text = raw.toString('utf8').trim();
  if (text === '') return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function createApp(config) {
  // config.env / config.loadSandboxSdk exist for tests; production uses process.env and the real SDK.
  const store = createStore({
    budgetConfig: config.budget,
    env: config.env ?? process.env,
    loadSandboxSdk: config.loadSandboxSdk,
    launchpad: { publicBaseUrl: config.launchpad.publicBaseUrl, treasury: config.launchpad.treasury, rpcUrl: config.launchpad.rpcUrl },
    log: config.log || (() => {}),
  });
  const ideaLimiter = createRateLimiter(config.ideaRateLimit);
  // Public and unauthenticated; each ask is a (paid, once live) LLM call and a
  // cost-ledger entry, so it is limited per client like /api/ideas.
  const askLimiter = createRateLimiter(config.coordinatorAskRateLimit ?? { max: 10, windowMs: 10 * 60 * 1000 });
  const log = config.log || (() => {});

  function send(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  const sendOk = (res, data, status = 200) => send(res, status, { ok: true, ...data });
  const sendError = (res, status, code, message = ERROR_MESSAGES[code], headers) =>
    send(res, status, { ok: false, error: code, message }, headers);

  async function readJsonBody(req, res) {
    let raw;
    try {
      raw = await readBody(req, config.maxBodyBytes);
    } catch (err) {
      if (err.code === 'too_large') {
        sendError(res, 413, 'too_large', undefined, { Connection: 'close' });
      }
      return undefined; // client went away, or we already responded
    }
    const body = parseJson(raw);
    if (body === undefined) sendError(res, 400, 'invalid_body');
    return body;
  }

  /** Raw bytes with their own size cap (the launchpad image upload); undefined once answered. */
  async function readRawBody(req, res, limit) {
    try {
      return await readBody(req, limit);
    } catch (err) {
      if (err.code === 'too_large') sendError(res, 413, 'too_large', undefined, { Connection: 'close' });
      return undefined;
    }
  }

  // Launchpad (user-created RAMs): its own module; see server/launchpad-routes.js.
  const launchpad = createLaunchpadRoutes({
    store,
    config,
    sendOk,
    sendError: (res, status, code, message = ERROR_MESSAGES[code], headers, extra = {}) =>
      send(res, status, { ok: false, error: code, message, ...extra }, headers),
    readJsonBody,
    readRawBody,
    clientKey: (req) => clientAddress(req, config.trustProxy),
  });

  function requireAdmin(req, res) {
    const token = req.headers['x-admin-token'];
    if (!tokenMatches(token, config.adminToken)) {
      sendError(res, 401, 'unauthorized');
      return false;
    }
    return true;
  }

  // ---- public read routes ----

  function getLedger(req, res) {
    sendOk(res, { ledger: { ...store.ledger.getSnapshot(), totalZec: store.totalZec() } });
  }

  function getAllocation(req, res) {
    sendOk(res, { allocation: store.getAllocation() });
  }

  function getSlots(req, res) {
    sendOk(res, {
      slots: store.slotManager.getSlots(),
      sandboxes: { enabled: store.slotManager.sandboxesEnabled, provider: store.sandbox.provider },
    });
  }

  function getSlot(req, res, id) {
    const slot = store.slotManager.getSlot(id);
    if (!slot) return sendError(res, 404, 'not_found');
    sendOk(res, { slot });
  }

  // Public: a RAM's live desktop, view-only enforced by the VNC server itself
  // (x11vnc -viewonly, see lib/sandbox.js). `stream` is null when none runs;
  // `sandbox` then says why (never started / starting / stopped / expired /
  // failed, see lib/slots.js), status and how it ended only, no error text.
  function getSlotStream(req, res, id) {
    const slot = store.slotManager.getSlot(id);
    if (!slot) return sendError(res, 404, 'not_found');
    const stream = store.sandboxManager?.getPublicStream(id) ?? null;
    const sandbox = slot.sandbox ? { status: slot.sandbox.status, endedBy: slot.sandbox.endedBy ?? null } : null;
    sendOk(res, { enabled: Boolean(store.sandboxManager), stream, sandbox });
  }

  function getCoordinatorSummary(req, res) {
    sendOk(res, { summary: store.coordinator.getSummary() });
  }

  // Public: this repo's own real commit history (server/lib/changelog.js), cached and
  // refreshed on a timer (server/index.js) -- never fetched from GitHub per-request.
  function getChangelog(req, res) {
    sendOk(res, { changelog: store.changelog.getSnapshot() });
  }

  async function postCoordinatorAsk(req, res) {
    const verdict = askLimiter.hit(clientAddress(req, config.trustProxy));
    if (!verdict.allowed) {
      req.resume();
      return sendError(res, 429, 'rate_limited', 'Too many questions from here. Please try again later.', { 'Retry-After': String(verdict.retryAfterSec) });
    }
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    if (typeof body.question !== 'string' || !body.question.trim()) {
      return sendError(res, 400, 'bad_request', 'Body must include a non-empty "question" string.');
    }
    const result = await store.coordinator.ask(body.question);
    sendOk(res, { result });
  }

  async function postIdea(req, res) {
    const key = clientAddress(req, config.trustProxy);
    const verdict = ideaLimiter.hit(key);
    if (!verdict.allowed) {
      req.resume();
      return sendError(res, 429, 'rate_limited', undefined, { 'Retry-After': String(verdict.retryAfterSec) });
    }
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    if (typeof body.text !== 'string') {
      return sendError(res, 400, 'bad_request', 'Body must include a "text" string.');
    }
    const author = typeof body.author === 'string' ? body.author.slice(0, 200) : undefined;
    const result = store.ideaQueue.submit(body.text, { author });
    if (!result.ok) return sendOk(res, { result }, 422); // screened out, but tell the submitter why
    sendOk(res, { result }, 201);
  }

  // ---- admin routes (require x-admin-token) ----

  async function postAdminFees(req, res) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const amountUsd = Number(body.amountUsd);
    const mode = body.mode === 'set' ? 'set' : 'add';
    if (!Number.isFinite(amountUsd)) {
      return sendError(res, 400, 'bad_request', 'Body must include a finite "amountUsd" number.');
    }
    if (store.feeSource.kind !== 'mock') {
      return sendError(res, 409, 'bad_request', 'Fee source is not mock-controllable.');
    }
    store.feeSource[mode](amountUsd, typeof body.note === 'string' ? body.note : undefined);
    const ledger = await store.ledger.refresh();
    sendOk(res, { ledger });
  }

  function postAdminReallocate(req, res) {
    const allocation = store.reallocateSlotsFromBudget();
    sendOk(res, { allocation, slots: store.slotManager.getSlots() });
  }

  async function postAdminSlotAdvance(req, res, id) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    try {
      const slot = await store.slotManager.advance(id, { outcome: body.outcome });
      sendOk(res, { slot });
    } catch (err) {
      sendError(res, 400, 'bad_request', err.message);
    }
  }

  async function postAdminSlotSandbox(req, res, id, action) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    if (!store.slotManager.sandboxesEnabled) {
      return sendError(res, 409, 'bad_request', 'Sandboxes are disabled. Set RAMHERD_SANDBOX=e2b and E2B_API_KEY.');
    }
    const current = store.slotManager.getSlot(id);
    if (!current) return sendError(res, 404, 'not_found');
    if (action === 'start' && !current.active) return sendError(res, 409, 'bad_request', 'Retired slots cannot start a sandbox.');
    try {
      const slot = action === 'start'
        ? await store.slotManager.startSandbox(id)
        : await store.slotManager.stopSandbox(id);
      sendOk(res, { slot }, action === 'start' ? 201 : 200);
    } catch (err) {
      sendError(res, 502, 'bad_request', err.message);
    }
  }

  // Auto-restart switch (see lib/slots.js). GET shows it; POST {enabled}
  // turns it off (cancels every pending restart) or back on. It can only be
  // turned on when RAMHERD_SANDBOX_AUTORESTART=true configured it.
  function getAdminSandboxAutoRestart(req, res) {
    sendOk(res, { autoRestart: store.slotManager.autoRestartStatus() });
  }

  async function postAdminSandboxAutoRestart(req, res) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    if (typeof body.enabled !== 'boolean') return sendError(res, 400, 'bad_request', 'Body must be {"enabled": true|false}.');
    try {
      sendOk(res, { autoRestart: store.slotManager.setAutoRestart(body.enabled) });
    } catch (err) {
      sendError(res, 409, 'bad_request', err.message);
    }
  }

  function getAdminSlotSandbox(req, res, id) {
    if (!store.slotManager.getSlot(id)) return sendError(res, 404, 'not_found');
    const stream = store.slotManager.getSandboxStream(id);
    if (!stream) return sendError(res, 404, 'not_found', 'This slot has no running sandbox.');
    sendOk(res, { sandbox: stream });
  }

  function getAdminIdeas(req, res, status) {
    const lists = {
      pending: store.ideaQueue.listPending(),
      approved: store.ideaQueue.listApproved(),
      rejected: store.ideaQueue.listRejected(),
    };
    sendOk(res, { ideas: lists[status] });
  }

  async function postAdminIdeaApprove(req, res, id) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    let targetSlotIds = body.targetSlotIds;
    if (targetSlotIds === 'all') {
      targetSlotIds = store.slotManager
        .getSlots()
        .filter((s) => s.active)
        .map((s) => s.id);
    }
    if (!Array.isArray(targetSlotIds)) targetSlotIds = [];
    try {
      const record = store.ideaQueue.approve(id, {
        targetSlotIds,
        attach: (slotId, idea) => store.slotManager.attachSuggestion(slotId, idea),
      });
      sendOk(res, { idea: record });
    } catch (err) {
      sendError(res, 404, 'not_found', err.message);
    }
  }

  async function postAdminIdeaReject(req, res, id) {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    try {
      const record = store.ideaQueue.reject(id, typeof body.reason === 'string' ? body.reason : '');
      sendOk(res, { idea: record });
    } catch (err) {
      sendError(res, 404, 'not_found', err.message);
    }
  }

  async function route(req, res) {
    const target = req.url || '/';
    if (!target.startsWith('/')) {
      req.routeLabel = 'bad-request';
      return sendError(res, 400, 'bad_request');
    }
    const pathname = decodeURIComponent(target.split(/[?#]/)[0]);
    const parts = pathname.split('/').filter(Boolean);
    const method = req.method;

    if (pathname === '/api/health') {
      req.routeLabel = 'api/health';
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'method_not_allowed', undefined, { Allow: 'GET, HEAD' });
      return sendOk(res, { service: 'herd' });
    }

    if (pathname === '/api/ledger' && method === 'GET') {
      req.routeLabel = 'api/ledger';
      return getLedger(req, res);
    }
    if (pathname === '/api/allocation' && method === 'GET') {
      req.routeLabel = 'api/allocation';
      return getAllocation(req, res);
    }
    if (pathname === '/api/slots' && method === 'GET') {
      req.routeLabel = 'api/slots';
      return getSlots(req, res);
    }
    if (parts[0] === 'api' && parts[1] === 'slots' && parts.length === 3 && method === 'GET') {
      req.routeLabel = 'api/slots/:id';
      return getSlot(req, res, parts[2]);
    }
    if (parts[0] === 'api' && parts[1] === 'slots' && parts.length === 4 && parts[3] === 'stream' && method === 'GET') {
      req.routeLabel = 'api/slots/:id/stream';
      return getSlotStream(req, res, parts[2]);
    }
    if (pathname === '/api/coordinator/summary' && method === 'GET') {
      req.routeLabel = 'api/coordinator/summary';
      return getCoordinatorSummary(req, res);
    }
    if (pathname === '/api/changelog' && method === 'GET') {
      req.routeLabel = 'api/changelog';
      return getChangelog(req, res);
    }
    if (pathname === '/api/coordinator/ask' && method === 'POST') {
      req.routeLabel = 'api/coordinator/ask';
      return postCoordinatorAsk(req, res);
    }
    if (pathname === '/api/ideas' && method === 'POST') {
      req.routeLabel = 'api/ideas';
      return postIdea(req, res);
    }

    if (parts[0] === 'api' && parts[1] === 'launchpad') {
      const query = new URLSearchParams(target.includes('?') ? target.slice(target.indexOf('?') + 1).split('#')[0] : '');
      if (await launchpad.handlePublic(req, res, { pathname, parts, method, query })) return;
    }

    // ---- admin ----
    if (parts[0] === 'api' && parts[1] === 'admin') {
      req.routeLabel = `api/admin/${parts.slice(2).join('/') || 'root'}`;
      if (!requireAdmin(req, res)) return;

      if (pathname === '/api/admin/fees' && method === 'POST') return postAdminFees(req, res);
      if (pathname === '/api/admin/reallocate' && method === 'POST') return postAdminReallocate(req, res);
      if (parts.length === 5 && parts[2] === 'slots' && parts[4] === 'advance' && method === 'POST') {
        return postAdminSlotAdvance(req, res, parts[3]);
      }
      if (pathname === '/api/admin/sandboxes/autorestart' && method === 'GET') return getAdminSandboxAutoRestart(req, res);
      if (pathname === '/api/admin/sandboxes/autorestart' && method === 'POST') return postAdminSandboxAutoRestart(req, res);
      if (parts.length === 5 && parts[2] === 'slots' && parts[4] === 'sandbox' && method === 'GET') {
        return getAdminSlotSandbox(req, res, parts[3]);
      }
      if (parts.length === 6 && parts[2] === 'slots' && parts[4] === 'sandbox' && ['start', 'stop'].includes(parts[5]) && method === 'POST') {
        return postAdminSlotSandbox(req, res, parts[3], parts[5]);
      }
      if (parts.length === 4 && parts[2] === 'ideas' && ['pending', 'approved', 'rejected'].includes(parts[3]) && method === 'GET') {
        return getAdminIdeas(req, res, parts[3]);
      }
      if (parts.length === 5 && parts[2] === 'ideas' && parts[4] === 'approve' && method === 'POST') {
        return postAdminIdeaApprove(req, res, parts[3]);
      }
      if (parts.length === 5 && parts[2] === 'ideas' && parts[4] === 'reject' && method === 'POST') {
        return postAdminIdeaReject(req, res, parts[3]);
      }
      if (parts[2] === 'launchpad' && (await launchpad.handleAdmin(req, res, { parts, method }))) return;
      return sendError(res, 404, 'not_found');
    }

    if (parts[0] !== 'api' && (method === 'GET' || method === 'HEAD') && (await serveStatic(req, res, pathname))) return;

    req.routeLabel = 'not-found';
    return sendError(res, 404, 'not_found');
  }

  // Serves a file from the static dir. Returns false (caller sends 404) when there is none.
  const staticDir = config.staticDir ?? DEFAULT_STATIC_DIR;
  async function serveStatic(req, res, pathname) {
    const rel = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    if (rel.split('/').some((p) => p.startsWith('.'))) return false;
    let file = resolve(staticDir, `.${rel}`);
    // Clean URLs: a path with no extension at all (/herd, /herder, ...) tries
    // its .html file. Only a bare segment with no dot qualifies, so a real
    // asset request (/styles.css, /favicon.svg, a typo'd /nope.css) never
    // falls through to this. Paths that already say .html keep working too
    // (already-shared/tweeted links), this is purely an added alias.
    if (!extname(file)) file = `${file}.html`;
    const type = STATIC_TYPES[extname(file).toLowerCase()];
    if (!type || !file.startsWith(staticDir + sep)) return false;
    let body;
    try {
      body = await readFile(file);
    } catch {
      return false;
    }
    req.routeLabel = 'static';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
      'Content-Security-Policy': PAGE_CSP,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  const server = createServer(async (req, res) => {
    const started = performance.now();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.on('finish', () => {
      log(`${new Date().toISOString()} ${safeLogField(req.method)} ${safeLogField(req.routeLabel || '-')} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
    });
    try {
      await route(req, res);
    } catch (err) {
      req.routeLabel = 'error';
      log(`${new Date().toISOString()} error ${safeLogField(err.code || err.name)}: ${safeLogField(err.message)}`);
      if (!res.headersSent) {
        try {
          sendError(res, 500, 'server_error');
        } catch {
          res.destroy();
        }
      } else {
        res.destroy();
      }
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    store,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      }),
    close: async () => {
      // Switch auto-restart off for good BEFORE killing sandboxes, so no pending
      // restart can fire and start a new one after stopAll.
      store.slotManager.stopAutoRestart?.();
      store.slotManager.stopActiveLoops?.();
      // Kill any running sandboxes first: they bill per second.
      if (store.sandboxManager) await store.sandboxManager.stopAll().catch(() => {});
      return new Promise((resolve) => {
        ideaLimiter.stop();
        askLimiter.stop();
        store.rams?.stop?.();
        launchpad.stop();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
