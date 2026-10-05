import { createServer } from 'node:http';
import { createStore } from './store.js';
import { createRateLimiter } from './lib/ratelimit.js';

const SECURITY_HEADERS = {
  // JSON-only API: no document is ever rendered, so the strictest policy applies.
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
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
  const store = createStore({ budgetConfig: config.budget, env: config.env ?? process.env, loadSandboxSdk: config.loadSandboxSdk });
  const ideaLimiter = createRateLimiter(config.ideaRateLimit);
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

  function requireAdmin(req, res) {
    const token = req.headers['x-admin-token'];
    if (!token || token !== config.adminToken) {
      sendError(res, 401, 'unauthorized');
      return false;
    }
    return true;
  }

  // ---- public read routes ----

  function getLedger(req, res) {
    sendOk(res, { ledger: store.ledger.getSnapshot() });
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

  function getCoordinatorSummary(req, res) {
    sendOk(res, { summary: store.coordinator.getSummary() });
  }

  async function postCoordinatorAsk(req, res) {
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
    if (pathname === '/api/coordinator/summary' && method === 'GET') {
      req.routeLabel = 'api/coordinator/summary';
      return getCoordinatorSummary(req, res);
    }
    if (pathname === '/api/coordinator/ask' && method === 'POST') {
      req.routeLabel = 'api/coordinator/ask';
      return postCoordinatorAsk(req, res);
    }
    if (pathname === '/api/ideas' && method === 'POST') {
      req.routeLabel = 'api/ideas';
      return postIdea(req, res);
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
      return sendError(res, 404, 'not_found');
    }

    req.routeLabel = 'not-found';
    return sendError(res, 404, 'not_found');
  }

  const server = createServer(async (req, res) => {
    const started = performance.now();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    res.on('finish', () => {
      log(`${new Date().toISOString()} ${req.method} ${req.routeLabel || '-'} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
    });
    try {
      await route(req, res);
    } catch (err) {
      req.routeLabel = 'error';
      log(`${new Date().toISOString()} error ${err.code || err.name}: ${err.message}`);
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
      // Kill any running sandboxes first: they bill per second.
      if (store.sandboxManager) await store.sandboxManager.stopAll().catch(() => {});
      return new Promise((resolve) => {
        ideaLimiter.stop();
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
