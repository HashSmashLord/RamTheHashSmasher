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

const HOST_RE = /^6080-[a-z0-9]+\.e2b\.app$/;

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
 * @returns {Promise<{ state: "live", url: string, expiresAt: string|null, sessionId: string } | { state: "idle", enabled: boolean } | { state: "unreachable" }>}
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
  if (!url) return { state: "idle", enabled: Boolean(body?.enabled) };
  return { state: "live", url, expiresAt: body.stream.expiresAt ?? null, sessionId: String(body.stream.sessionId ?? "") };
}

const clockTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * Builds the desk viewer for one RAM. Call `refresh()` to (re)load; it only
 * touches the iframe when the stream itself changes, so a poll never reloads it.
 *
 * @param {{ ramLabel: string, slotId: string, doc?: Document, load?: typeof loadDesk }} opts
 */
export function createDeskViewer({ ramLabel, slotId, doc = document, load = loadDesk }) {
  const el = doc.createElement("div");
  el.className = "desk";
  el.setAttribute("aria-live", "polite");

  const line = doc.createElement("p");
  line.className = "desk-line";
  const frameWrap = doc.createElement("div");
  frameWrap.className = "desk-frame";
  frameWrap.hidden = true;
  el.append(line, frameWrap);

  let shownUrl = null;
  let destroyed = false;

  function setLine(text, live) {
    line.textContent = text;
    el.classList.toggle("is-live", live);
  }

  function showIdle(text) {
    if (shownUrl !== null) {
      frameWrap.replaceChildren();
      frameWrap.hidden = true;
      shownUrl = null;
    }
    setLine(text, false);
  }

  function showLive(desk) {
    const until = desk.expiresAt ? clockTime(desk.expiresAt) : null;
    setLine(`Watching ${ramLabel}'s desk. View only: the desktop's VNC server ignores every click and key${until ? `. Hard stop at ${until}` : ""}.`, true);
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
    else if (desk.state === "unreachable") showIdle(`${ramLabel}'s desk feed could not be reached just now.`);
    else showIdle(`No desktop running for ${ramLabel}. Its work runs on the host right now; when a sandbox is started for it, its screen shows here, watch-only.`);
  }

  function destroy() {
    destroyed = true;
    frameWrap.replaceChildren();
    el.remove();
  }

  showIdle(`Checking ${ramLabel}'s desk…`);
  return { el, refresh, destroy, get url() { return shownUrl; } };
}
