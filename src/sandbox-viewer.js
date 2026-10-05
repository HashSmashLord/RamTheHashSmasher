// RAMherd: a RAM's desk, watched live.
//
// Embeds the RAM's E2B desktop (noVNC page) when a sandbox is running for it,
// and says plainly when none is. It only ever shows the stream the server hands
// out at GET /api/slots/:id/stream, which is the x11vnc -viewonly stream: the
// VNC server itself drops every mouse/keyboard event (server/lib/sandbox.js,
// proven with raw RFB input in scripts/prove-viewonly.mjs). There is no
// full-control stream anywhere for this page to receive.
//
// Defence in depth on this side too: a stream is shown only if the server
// labels it `viewOnly: "server"` AND its URL is an https noVNC page on an E2B
// sandbox host (6080-<id>.e2b.app). Anything else is treated as "no desk".
//
// When there is no desk, the server's slot record says why (`sandbox.status`,
// see server/lib/slots.js) and the words say the same, plainly: never started
// (the usual case), starting, finished (stopped from the server, or its hard
// stop reached), closed early on E2B's side, or could not start. Each is a
// fact about the RAM's lifecycle, not an error page; a real failure is still
// named as one. Demo pages have no slot record, so they keep the default line.

const HOST_RE = /^6080-[a-z0-9]+\.e2b\.app$/;

/**
 * Why a slot has no desk right now, from its public `sandbox` record:
 * "never" | "starting" | "stopped" | "expired" | "ended" | "failed".
 * @param {any} sandbox - the slot's `sandbox` field (null when it never had one)
 */
export function deskWhy(sandbox) {
  const status = sandbox?.status;
  if (status === "starting") return "starting";
  if (status === "stopped") return "stopped";
  if (status === "expired") return sandbox.endedBy === "provider" ? "ended" : "expired";
  if (status === "failed") return "failed";
  return "never";
}

/**
 * Returns a safe URL string, or null if `stream` is not a server-enforced
 * view-only E2B noVNC stream.
 * @param {any} stream
 */
export function safeStreamUrl(stream) {
  if (!stream || stream.viewOnly !== "server" || typeof stream.streamUrl !== "string") return null;
  let url;
  try {
    url = new URL(stream.streamUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !HOST_RE.test(url.host) || url.pathname !== "/vnc.html") return null;
  if (url.username || url.password) return null;
  // The page parameter only hides noVNC's controls; the server enforces view-only regardless.
  url.searchParams.set("view_only", "true");
  return url.toString();
}

/**
 * Same-origin fetch of a slot's public stream. Any failure (no backend, unknown
 * slot, sandboxes off) reads as "no desk running", never as an error page.
 * @param {string} slotId
 * @param {{ base?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ state: "live", url: string, expiresAt: string|null, sessionId: string } | { state: "idle", enabled: boolean, why?: string } | { state: "unreachable" }>}
 */
export async function loadDesk(slotId, { base = "", fetchImpl = globalThis.fetch } = {}) {
  let body;
  try {
    const res = await fetchImpl(`${base}/api/slots/${encodeURIComponent(slotId)}/stream`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
    });
    if (res.status === 404) return { state: "idle", enabled: false };
    if (!res.ok) return { state: "unreachable" };
    body = await res.json();
  } catch {
    return { state: "unreachable" };
  }
  const url = safeStreamUrl(body?.stream);
  if (!url) {
    const idle = { state: "idle", enabled: Boolean(body?.enabled) };
    // The stream route also says why there is no desk (`sandbox`, null when it never had one).
    return body && typeof body === "object" && "sandbox" in body ? { ...idle, why: deskWhy(body.sandbox) } : idle;
  }
  return { state: "live", url, expiresAt: body.stream.expiresAt ?? null, sessionId: String(body.stream.sessionId ?? "") };
}

/**
 * Whether this page is served by the RAMherd API server, which answers
 * GET /api/slots/:id/stream, rather than by a bare static file server (the
 * README's `python3 -m http.server`), which has no desk feed at all. The API
 * server marks every page it serves with a frame-src CSP naming E2B hosts; a
 * static server sends no such header. A HEAD of the page itself succeeds on
 * both, so the answer costs no failed request and no console error.
 * @param {{ fetchImpl?: typeof fetch, href?: string }} [opts]
 */
export async function deskFeedAvailable({ fetchImpl = globalThis.fetch, href = globalThis.location?.href } = {}) {
  try {
    const res = await fetchImpl(href, { method: "HEAD", cache: "no-store", credentials: "omit" });
    const csp = res.headers?.get?.("content-security-policy") || "";
    return /frame-src[^;]*e2b\.app/.test(csp);
  } catch {
    return false;
  }
}

/**
 * One listing for every screen on the page. GET /api/slots answers 200 whether or not
 * any slot or sandbox exists, so polling it costs no failed request; a slot's stream is
 * asked for only when the listing says that slot exists and its sandbox is running.
 * Everything else reads as "no desk" without a request. `refresh()` once per poll, then
 * hand `load` to each viewer in place of loadDesk.
 * @param {{ base?: string, fetchImpl?: typeof fetch, load?: typeof loadDesk }} [opts]
 */
export function createDeskDirectory({ base = "", fetchImpl = globalThis.fetch, load = loadDesk } = {}) {
  let slots = new Map();
  let enabled = false;
  let reachable = true;

  async function refresh() {
    try {
      const res = await fetchImpl(`${base}/api/slots`, { headers: { Accept: "application/json" }, cache: "no-store", credentials: "omit" });
      if (!res.ok) {
        reachable = false;
        return;
      }
      const body = await res.json();
      slots = new Map((Array.isArray(body?.slots) ? body.slots : []).map((s) => [String(s.id), s]));
      enabled = Boolean(body?.sandboxes?.enabled);
      reachable = true;
    } catch {
      reachable = false;
    }
  }

  /** @param {string} slotId */
  async function loadSlot(slotId) {
    if (!reachable) return { state: "unreachable" };
    const slot = slots.get(slotId);
    if (!slot) return { state: "idle", enabled };
    if (slot.sandbox?.status !== "running") return { state: "idle", enabled, why: deskWhy(slot.sandbox) };
    return load(slotId, { base, fetchImpl });
  }

  return { refresh, load: loadSlot, get reachable() { return reachable; }, get enabled() { return enabled; }, get size() { return slots.size; } };
}

const clockTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

// The words a desk shows in each state. A page may pass its own `copy` (shorter for a tile,
// fuller for a RAM's page); the state logic and the embed rules never change with it.
// `idle` is the no-desk default (never had one, or no record to go on); the other no-desk
// states (deskWhy) fall back to it when a page's copy has no line for them.
const DEFAULT_COPY = {
  checking: (label) => `Checking ${label}'s desk…`,
  idle: (label) => `No desktop running for ${label}. Its work runs on the host right now; when a sandbox is started for it, its screen shows here, watch-only.`,
  starting: (label) => `${label}'s desk is starting. Its screen shows here, watch-only, as soon as the desktop is up.`,
  stopped: (label) => `${label} finished its visible desk session and is back to working on the host. When a desk is started for it again, its screen shows here, watch-only.`,
  expired: (label) => `${label}'s desk session ran its full time and closed; it is back to working on the host. When a desk is started for it again, its screen shows here, watch-only.`,
  ended: (label) => `${label}'s desk session closed before its scheduled stop; it is back to working on the host. When a desk is started for it again, its screen shows here, watch-only.`,
  failed: (label) => `${label}'s desk could not start this time; it is still working on the host. When a desk is started for it again, its screen shows here, watch-only.`,
  unreachable: (label) => `${label}'s desk feed could not be reached just now.`,
  live: (label, until) => `Watching ${label}'s desk. View only: the desktop's VNC server ignores every click and key${until ? `. Hard stop at ${until}` : ""}.`,
};
// The short badge drawn on the screen itself, one per state.
const BADGE = {
  checking: "checking",
  idle: "No desk running",
  starting: "Desk starting",
  stopped: "Desk session done",
  expired: "Desk session done",
  ended: "Desk session closed",
  failed: "Desk did not start",
  unreachable: "feed unreachable",
  live: "Live · view only",
};

/**
 * Builds the desk viewer for one RAM. Call `refresh()` to (re)load; it only
 * touches the iframe when the stream itself changes, so a poll never reloads it.
 *
 * @param {{ ramLabel: string, slotId: string, doc?: Document, load?: typeof loadDesk, copy?: Partial<typeof DEFAULT_COPY> }} opts
 */
export function createDeskViewer({ ramLabel, slotId, doc = document, load = loadDesk, copy = {} }) {
  const words = { ...DEFAULT_COPY, ...copy };
  const el = doc.createElement("div");
  el.className = "desk";
  el.setAttribute("aria-live", "polite");

  const line = doc.createElement("p");
  line.className = "desk-line";
  const frameWrap = doc.createElement("div");
  frameWrap.className = "desk-frame";
  frameWrap.hidden = true;
  const badge = doc.createElement("span");
  badge.className = "desk-badge";
  badge.setAttribute("aria-hidden", "true");
  el.append(line, frameWrap, badge);

  let shownUrl = null;
  let destroyed = false;

  function setLine(text, state) {
    line.textContent = text;
    badge.textContent = BADGE[state];
    el.classList.toggle("is-live", state === "live");
  }

  function showIdle(text, state = "idle") {
    if (shownUrl !== null) {
      frameWrap.replaceChildren();
      frameWrap.hidden = true;
      shownUrl = null;
    }
    setLine(text, state);
  }

  function showLive(desk) {
    const until = desk.expiresAt ? clockTime(desk.expiresAt) : null;
    setLine(words.live(ramLabel, until), "live");
    if (shownUrl === desk.url) return;
    const iframe = doc.createElement("iframe");
    iframe.className = "desk-iframe";
    iframe.title = `${ramLabel}'s desktop, live, view only`;
    iframe.src = desk.url;
    iframe.loading = "lazy";
    iframe.referrerPolicy = "no-referrer";
    // noVNC needs scripts and its own origin (its websocket + settings); nothing else.
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
    iframe.setAttribute("allow", "");
    iframe.tabIndex = -1; // nothing to operate inside; keep it out of the tab order
    frameWrap.replaceChildren(iframe);
    frameWrap.hidden = false;
    shownUrl = desk.url;
  }

  async function refresh() {
    if (destroyed) return;
    const desk = await load(slotId);
    if (destroyed) return;
    if (desk.state === "live") showLive(desk);
    else if (desk.state === "unreachable") showIdle(words.unreachable(ramLabel), "unreachable");
    else {
      // "never" (and anything without a line of its own) reads as the plain idle state.
      const why = desk.why && desk.why !== "never" && typeof words[desk.why] === "function" && BADGE[desk.why] ? desk.why : "idle";
      showIdle(words[why](ramLabel), why);
    }
  }

  function destroy() {
    destroyed = true;
    frameWrap.replaceChildren();
    el.remove();
  }

  showIdle(words.checking(ramLabel), "checking");
  return { el, refresh, destroy, get url() { return shownUrl; } };
}
