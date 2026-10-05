// RAMherd: page wiring. Every piece of data comes through RAMherdAPI (mock-data.js).
// Swap point: nothing in this file changes when the real backend lands, only the
// method bodies inside RAMherdAPI do. See the header comment there.

import { RAMherdAPI } from "./mock-data.js";
import { createDeskViewer, createDeskDirectory, deskFeedAvailable } from "./sandbox-viewer.js";

// The exact words the board writes, one per status. "Submitted" carries its fuller form as a
// tooltip: the board shows the short word, the key spells it out.
const STATUS_WORD = { idle: "Idle", thinking: "Thinking", running: "Running an experiment", submitted: "Submitted" };
const STATUS_FULL = { submitted: "Submitted to HashSmash" };

// Where a handed-in candidate stands with HashSmash's review. The feed sends `judge`
// ("in review" or null); if it does not, a submitted slot falls back to "in review", HashSmash's
// intake state ("In review — Awaiting manual review" on their results page). "accepted" only
// ever comes from their judge, never from this page: nothing from the herd has been accepted.
const JUDGE_WORD = { submitted: "in review" };
const JUDGE_FULL = { "in review": "In review — Awaiting manual review" };

// HashSmash's score: log₂(T), total charged computation, lower is better. Written only once
// their judge has scored a candidate; until then an em dash, exactly as their frontier reads.
const SCORE_TERM = "log₂(T)";

// A RAM nobody has heard from for this long dims. A submitted RAM is waiting on HashSmash's
// judge, not silent, so it never dims however long the review takes.
const STALE_AFTER_SECONDS = 300;
const isStale = (agent, seconds) => seconds > STALE_AFTER_SECONDS && agent.status !== "submitted";

// Every screen re-checks its stream this often (a sandbox may start or stop); never harder.
const DESK_POLL_MS = 10_000;

// Pixel status glyphs on an 8×8 grid. Running has two frames (the burst) and blinks between them.
const GLYPH = {
  running: '<path class="f1" d="M3 3h2v2h-2zM1 1h1v1h-1zM6 1h1v1h-1zM1 6h1v1h-1zM6 6h1v1h-1z"/><path class="f2" d="M3 3h2v2h-2zM3 0h2v1h-2zM3 7h2v1h-2zM0 3h1v2h-1zM7 3h1v2h-1z"/>',
  thinking: '<path d="M0 3h2v2h-2zM3 3h2v2h-2zM6 3h2v2h-2z"/>',
  idle: '<path d="M1 1h6v1h-6zM1 6h6v1h-6zM1 2h1v4h-1zM6 2h1v4h-1z"/>',
  submitted: '<path d="M0 4h1v1h-1zM1 5h1v1h-1zM2 6h1v1h-1zM3 5h1v1h-1zM4 4h1v1h-1zM5 3h1v1h-1zM6 2h1v1h-1zM7 1h1v1h-1z"/>',
};
const glyph = (status) =>
  `<svg class="glyph${status === "running" ? " glyph-run" : ""}" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">${GLYPH[status] || GLYPH.idle}</svg>`;

const money = (n) => `$${n.toFixed(2)}`;
const $ = (id) => document.getElementById(id);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// "SHA-256 r31": the feed's roundLabel, or derived from "SHA-256 · r31 · exploratory".
function roundShort(agent) {
  if (agent.roundLabel) return agent.roundLabel;
  const [target, round] = String(agent.trackLabel).split(" · ");
  return round ? `${target} ${round}` : agent.trackLabel;
}

// A log₂(T) value as HashSmash prints it (125.99, 41.500001): the number as sent, never rounded.
function scoreText(log2T) {
  return log2T == null || log2T === "" ? null : String(log2T);
}

// "8s ago" / "41m ago" / "1h 2m ago" -> seconds. Fallback when the feed sends no raw number.
function parseSeconds(label) {
  const h = /(\d+)h/.exec(label);
  const m = /(\d+)m/.exec(label);
  const s = /(\d+)s/.exec(label);
  return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s ? +s[1] : 0);
}

function secondsOf(agent) {
  return typeof agent.updatedSecondsAgo === "number" ? agent.updatedSecondsAgo : parseSeconds(agent.updatedLabel || "");
}

// Server slots are `slot-0`, `slot-1`, ... in roster order (RAM 1 = slot-0).
// The mock board has no slot ids yet, so derive it; a real feed should send `slotId`.
function slotIdFor(agent) {
  if (agent.slotId) return agent.slotId;
  const n = Number(String(agent.id).replace(/^ram-/, ""));
  return Number.isInteger(n) && n > 0 ? `slot-${n - 1}` : String(agent.id);
}

// ---------------------------------------------------------------------------
// The one authored motion: a new or changed line is printed, left to right, in steps.
// ---------------------------------------------------------------------------

function print(el) {
  if (reducedMotion.matches) return;
  el.classList.remove("printing");
  void el.offsetWidth; // restart if already printing
  el.classList.add("printing");
}
document.addEventListener("animationend", (e) => {
  if (e.target.classList && e.target.classList.contains("printing")) e.target.classList.remove("printing");
});

// Sets text only when it changed; returns whether it did.
function write(el, text) {
  if (el.textContent === text) return false;
  el.textContent = text;
  return true;
}

// A path like lanes/exploratory/candidates/sha256-r31/ may break after any slash, never
// inside a segment.
function writePath(el, path) {
  if (el.dataset.path === path) return false;
  el.dataset.path = path;
  el.textContent = "";
  const parts = String(path).split("/");
  parts.forEach((part, i) => {
    const segment = document.createElement("span");
    segment.className = "path-segment";
    segment.textContent = i < parts.length - 1 ? `${part}/` : part;
    el.append(segment);
    if (i < parts.length - 1) el.append(document.createElement("wbr"));
  });
  return true;
}

// The status line's three parts (glyph, word, clock) written into a container that holds
// .now-glyph / .now-word / .now-clock spans. Returns { statusChanged, freshWrite, seconds }.
function writeNowLine(parts, agent, prevSeconds) {
  const statusChanged = write(parts.word, STATUS_WORD[agent.status] || agent.status);
  if (statusChanged) {
    parts.glyph.innerHTML = glyph(agent.status);
    if (STATUS_FULL[agent.status]) parts.word.title = STATUS_FULL[agent.status];
    else parts.word.removeAttribute("title");
  }
  write(parts.clock, `written ${agent.updatedLabel}`);
  const seconds = secondsOf(agent);
  return { statusChanged, freshWrite: seconds < prevSeconds, seconds };
}

// The judge's column: HashSmash's review state, then their score. Only a handed-in
// candidate has either; every other row leaves it blank (an em dash).
function judgeMarkup(agent) {
  const judge = agent.judge !== undefined ? agent.judge : JUDGE_WORD[agent.status] || null;
  const score = scoreText(agent.log2T);
  const parts = [];
  if (judge) {
    const full = JUDGE_FULL[judge];
    parts.push(`<span class="judge-mark"${full ? ` title="${full}"` : ""}>${judge}</span>`);
  } else {
    parts.push(`<span class="judge-none" aria-hidden="true">—</span><span class="sr-only">nothing from the judge yet</span>`);
  }
  if (judge || score) {
    parts.push(
      `<span class="judge-score"><span class="judge-score-term">${SCORE_TERM}</span> ` +
        (score
          ? `<span class="judge-score-value">${score}</span>`
          : `<span class="judge-score-value" aria-hidden="true">—</span><span class="sr-only">not scored yet</span>`) +
        `</span>`
    );
  }
  return { key: `${judge}|${score}`, html: parts.join("") };
}

// ---------------------------------------------------------------------------
// Nav toggle (narrow widths)
// ---------------------------------------------------------------------------

const navToggle = $("nav-toggle");
const mainNav = $("main-nav");
function setNav(open) {
  mainNav.classList.toggle("is-open", open);
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}
navToggle.addEventListener("click", () => setNav(!mainNav.classList.contains("is-open")));
mainNav.addEventListener("click", (e) => {
  if (e.target.closest("a")) setNav(false);
});

// ---------------------------------------------------------------------------
// The fund lines (banner page)
// ---------------------------------------------------------------------------

let statsRenderedOnce = false;

function writeBlocks(el, total, on) {
  const key = `${total}/${on}`;
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const b = document.createElement("i");
    if (i < on) b.className = "on";
    el.append(b);
  }
}

async function renderStats() {
  const s = await RAMherdAPI.getStats();
  const first = !statsRenderedOnce;
  statsRenderedOnce = true;

  // The figures are visible from the first paint; only later writes are printed.
  const fees = $("stat-fees");
  if (write(fees, money(s.feesCollectedLifetime)) && !first) print(fees);

  const spent = $("stat-budget");
  if (write(spent, money(s.computeSpentEpoch)) && !first) print(spent);
  write($("stat-budget-total"), money(s.computeBudgetEpoch));
  write($("stat-epoch"), s.epochLabel);

  // The budget as a block bar: 24 blocks, the spent share filled from the left.
  const share = Math.min(1, s.computeSpentEpoch / s.computeBudgetEpoch);
  writeBlocks($("budget-blocks"), 24, Math.round(share * 24));

  write($("stat-slots"), `${s.slotsActive} of ${s.slotsMax}`);
  writeBlocks($("slot-blocks"), s.slotsMax, s.slotsActive);
}

// ---------------------------------------------------------------------------
// The board: one tile per RAM, diffed by id so a tick never re-renders the board
// ---------------------------------------------------------------------------

const tiles = new Map();

// Set at boot: whether this page is served by the API server (which answers /api/slots and
// /api/slots/:id/stream). A bare static server has no desk feed; every screen then simply
// shows "no desk running", without a single failed request. With the feed, one listing per
// poll tells every screen whether its slot exists and has a running sandbox; only then is
// that slot's stream asked for. See deskFeedAvailable() and createDeskDirectory().
let directory = null; // set at boot when the feed exists
const NO_FEED = async () => ({ state: "idle", enabled: false });
const deskLoad = (slotId) => (directory ? directory.load(slotId) : NO_FEED());

const TILE_COPY = {
  checking: (label) => `Checking ${label}'s desk…`,
  idle: (label) => `No desktop running for ${label}. It works on the host right now; when a sandbox is started for it, its screen shows here, watch-only.`,
  unreachable: (label) => `${label}'s desk feed could not be reached just now.`,
};

function buildTile(agent) {
  const art = document.createElement("article");
  art.className = "tile";
  art.id = `tile-${agent.id}`;
  const href = `#ram/${encodeURIComponent(agent.id)}`;
  art.innerHTML = `
    <div class="screen">
      <svg class="screen-idle" viewBox="0 0 30 30" aria-hidden="true"><use href="#hash-block"/></svg>
      <a class="screen-link" href="${href}"><span class="sr-only">Open ${agent.id}'s page</span></a>
    </div>
    <div class="tile-lines">
      <p class="tile-head"><a class="tile-id" href="${href}"></a><span class="now-line"><span class="now-glyph"></span><span class="now-word"></span><span class="now-clock"></span></span></p>
      <p class="tile-round"><span class="round-id"></span><span class="round-path"></span></p>
      <p class="tile-model"><span class="entrant-model"></span><span class="entrant-approach"></span></p>
      <p class="tile-activity"></p>
      <p class="tile-judge"></p>
    </div>`;
  const screen = art.querySelector(".screen");
  const desk = createDeskViewer({ ramLabel: agent.id, slotId: slotIdFor(agent), copy: TILE_COPY, load: deskLoad });
  screen.prepend(desk.el);
  return {
    el: art,
    desk,
    seconds: Infinity,
    judgeKey: null,
    id: art.querySelector(".tile-id"),
    now: { glyph: art.querySelector(".now-glyph"), word: art.querySelector(".now-word"), clock: art.querySelector(".now-clock"), line: art.querySelector(".now-line") },
    round: art.querySelector(".round-id"),
    path: art.querySelector(".round-path"),
    model: art.querySelector(".entrant-model"),
    approach: art.querySelector(".entrant-approach"),
    activity: art.querySelector(".tile-activity"),
    judge: art.querySelector(".tile-judge"),
  };
}

function updateTile(t, agent, first) {
  write(t.id, agent.id);
  write(t.round, roundShort(agent));
  writePath(t.path, agent.lanePath);
  writePath(t.model, agent.model || "");
  write(t.approach, agent.approach);
  const activityChanged = write(t.activity, agent.activity);

  const { statusChanged, freshWrite, seconds } = writeNowLine(t.now, agent, t.seconds);
  t.seconds = seconds;
  t.el.classList.toggle("stale", isStale(agent, seconds));

  const j = judgeMarkup(agent);
  if (j.key !== t.judgeKey) {
    t.judgeKey = j.key;
    t.judge.innerHTML = j.html;
  }

  if (!first && (statusChanged || activityChanged || freshWrite)) {
    print(t.now.line);
    if (activityChanged) print(t.activity);
  }
}

async function renderFleet() {
  const fleet = await RAMherdAPI.getFleet();
  const grid = $("tiles");
  const seen = new Set();

  for (const agent of fleet) {
    seen.add(agent.id);
    let t = tiles.get(agent.id);
    const first = !t;
    if (first) {
      t = buildTile(agent);
      tiles.set(agent.id, t);
      grid.appendChild(t.el);
      t.desk.refresh();
    }
    t.agent = agent;
    updateTile(t, agent, first);
  }
  for (const [id, t] of tiles) {
    if (!seen.has(id)) {
      t.desk.destroy();
      t.el.remove();
      tiles.delete(id);
    }
  }
  renderHerdLines(fleet);
  if (openPage && openPage.id) {
    const agent = fleet.find((a) => a.id === openPage.id);
    if (agent) updatePageNow(agent);
  }
}

// ---------------------------------------------------------------------------
// The Herder's panel: its summary, the herd by status, one line per RAM
// ---------------------------------------------------------------------------

const herdLines = new Map();

function renderHerdLines(fleet) {
  const list = $("herder-lines");
  const seen = new Set();
  for (const agent of fleet) {
    seen.add(agent.id);
    let h = herdLines.get(agent.id);
    const first = !h;
    if (first) {
      const li = document.createElement("li");
      li.innerHTML = `<a class="h-id" href="#ram/${encodeURIComponent(agent.id)}"></a><span class="now-line"><span class="now-glyph"></span><span class="now-word"></span></span><span class="h-text"></span>`;
      h = {
        el: li,
        seconds: Infinity,
        id: li.querySelector(".h-id"),
        now: { glyph: li.querySelector(".now-glyph"), word: li.querySelector(".now-word"), clock: document.createElement("span"), line: li.querySelector(".now-line") },
        text: li.querySelector(".h-text"),
      };
      herdLines.set(agent.id, h);
      list.append(li);
    }
    write(h.id, agent.id);
    const { statusChanged, freshWrite, seconds } = writeNowLine(h.now, agent, h.seconds);
    h.seconds = seconds;
    h.el.classList.toggle("stale", isStale(agent, seconds));
    const textChanged = write(h.text, agent.activity);
    h.text.title = agent.activity;
    if (!first && (statusChanged || textChanged || freshWrite)) print(h.text);
  }
  for (const [id, h] of herdLines) {
    if (!seen.has(id)) {
      h.el.remove();
      herdLines.delete(id);
    }
  }
}

let herderRenderedOnce = false;

async function renderHerder() {
  const [summary, stats] = await Promise.all([RAMherdAPI.getHerderSummary(), RAMherdAPI.getStats()]);
  const first = !herderRenderedOnce;
  herderRenderedOnce = true;

  const line = $("herder-summary");
  if (write(line, summary.summary) && !first) print(line);
  write($("herder-clock"), `updated ${summary.updatedLabel}`);

  const counts = $("herder-counts");
  const order = ["running", "thinking", "idle", "submitted"];
  const key = order.map((s) => stats.breakdown[s]).join("/");
  if (counts.dataset.key !== key) {
    counts.dataset.key = key;
    counts.innerHTML = order
      .map((s) => `<li>${glyph(s)}<span class="n">${stats.breakdown[s]}</span><span>${STATUS_WORD[s]}</span></li>`)
      .join("");
  }
}

// ---------------------------------------------------------------------------
// The Herder's log: a terminal, oldest at the top, the prompt at the bottom
// ---------------------------------------------------------------------------

const chatLog = $("chat-log");
const chatForm = $("chat-form");
const chatInput = $("chat-input");
const askButton = chatForm.querySelector("button");

function logEntry({ q, a, pending = false }) {
  const li = document.createElement("li");
  if (pending) li.className = "log-pending";
  li.innerHTML =
    `<span class="log-mark" aria-hidden="true">&gt;</span><p class="log-q"><span class="sr-only">You asked: </span></p>` +
    `<span class="log-mark" aria-hidden="true">H</span><p class="log-a"><span class="sr-only">The Herder: </span></p>`;
  li.querySelector(".log-q").append(q);
  li.querySelector(".log-a").append(a);
  chatLog.append(li);
  chatLog.scrollTop = chatLog.scrollHeight;
  return li;
}

function answerEntry(li, text) {
  li.classList.remove("log-pending");
  const a = li.querySelector(".log-a");
  a.innerHTML = `<span class="sr-only">The Herder: </span>`;
  a.append(text);
  print(a);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function seedChat() {
  const seed = await RAMherdAPI.getChatSeed();
  for (const pair of seed) logEntry(pair);
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;

  chatInput.value = "";
  chatInput.disabled = true;
  askButton.disabled = true;
  const li = logEntry({ q: question, a: "Writing…", pending: true });

  try {
    const { answer } = await RAMherdAPI.askCoordinator(question);
    answerEntry(li, answer);
  } catch {
    answerEntry(li, "The Herder could not be reached. Ask again in a moment.");
  } finally {
    chatInput.disabled = false;
    askButton.disabled = false;
    chatInput.focus();
  }
});

// ---------------------------------------------------------------------------
// The slip: ideas go to the human review queue, never straight to a RAM
// ---------------------------------------------------------------------------

const ideaForm = $("idea-form");
const ideaConfirm = $("idea-confirm");
const ideaConfirmText = $("idea-confirm-text");
const handInButton = ideaForm.querySelector("button[type=submit]");

ideaForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = new FormData(ideaForm);
  const payload = { track: data.get("track"), idea: data.get("idea"), contact: data.get("contact") };

  handInButton.disabled = true;
  handInButton.textContent = "Handing in…";

  try {
    const result = await RAMherdAPI.submitIdea(payload);
    ideaConfirmText.textContent = `Queued for human review, position ${result.queuePosition}. No RAM sees it until a reviewer approves it.`;
    ideaConfirm.classList.add("is-visible");
    ideaForm.reset();
  } catch {
    ideaConfirmText.textContent = "It did not go through. Your text is still in the form; try handing it in again.";
    ideaConfirm.classList.add("is-visible");
  } finally {
    handInButton.disabled = false;
    handInButton.textContent = "Hand in for review";
  }
});

// ---------------------------------------------------------------------------
// A RAM's full page: #ram/<id>. Its screen, larger, its facts, its whole history.
// Opened over the board (the board stays mounted and keeps ticking underneath).
// ---------------------------------------------------------------------------

const ramPage = $("ram-page");
const pageParts = {
  title: $("ram-page-title"),
  crumb: $("ram-page-crumb-id"),
  now: $("ram-page-now"),
  screen: $("ram-page-screen"),
  facts: $("ram-page-facts"),
  history: $("ram-page-history"),
};
const PAGE_COPY = {
  checking: (label) => `Checking ${label}'s desk…`,
  idle: (label) => `No desk running for ${label}. Its work runs on the host right now; when a sandbox is started for it, its screen shows here, watch-only.`,
  unreachable: (label) => `${label}'s desk feed could not be reached just now.`,
};
let openPage = null; // { id, desk, now, seconds, returnTo, scrollY }

function updatePageNow(agent) {
  if (!openPage) return;
  if (!openPage.now) {
    pageParts.now.innerHTML = `<span class="now-glyph"></span><span class="now-word"></span><span class="now-clock"></span>`;
    openPage.now = { glyph: pageParts.now.querySelector(".now-glyph"), word: pageParts.now.querySelector(".now-word"), clock: pageParts.now.querySelector(".now-clock"), line: pageParts.now };
    openPage.seconds = Infinity;
  }
  const first = openPage.seconds === Infinity;
  const r = writeNowLine(openPage.now, agent, openPage.seconds);
  openPage.seconds = r.seconds;
  if (!first && (r.statusChanged || r.freshWrite)) print(pageParts.now);
}

function renderFacts(detail) {
  const judge = detail.judge !== undefined ? detail.judge : JUDGE_WORD[detail.status] || null;
  const rows = [
    ["Model", detail.model, true],
    ["Approach", detail.approach],
    ["Round", `${roundShort(detail)} (${detail.trackLabel})`],
    ["Candidate path", detail.lanePath, true],
    ["HashSmash review", judge ? `<span class="judge-mark"${JUDGE_FULL[judge] ? ` title="${JUDGE_FULL[judge]}"` : ""}>${judge}</span>` : "nothing handed in yet"],
    [SCORE_TERM, scoreText(detail.log2T) ?? "not scored yet"],
    ["Server slot", slotIdFor(detail)],
  ];
  pageParts.facts.innerHTML = "";
  for (const [k, v, isPath] of rows) {
    const div = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    if (isPath) writePath(dd, v);
    else if (k === "HashSmash review") dd.innerHTML = v;
    else dd.textContent = v;
    div.append(dt, dd);
    pageParts.facts.append(div);
  }
}

function renderHistory(detail) {
  pageParts.history.innerHTML = "";
  detail.history.forEach((line, i) => {
    const li = document.createElement("li");
    if (i === 0) li.className = "is-now";
    li.innerHTML = `<span class="hist-at"></span><span class="hist-word">${glyph(line.status)}<span></span></span><p class="hist-text"></p>`;
    li.querySelector(".hist-at").textContent = line.label;
    li.querySelector(".hist-word span").textContent = STATUS_WORD[line.status] || line.status;
    li.querySelector(".hist-text").textContent = line.text;
    pageParts.history.append(li);
  });
}

async function openRamPage(id, returnTo) {
  if (openPage && openPage.id === id) return;
  if (openPage) closeRamPage(false);
  const detail = await RAMherdAPI.getRamDetail(id);
  if (!detail) {
    location.hash = "#board";
    return;
  }
  openPage = { id, desk: null, now: null, seconds: Infinity, returnTo: returnTo || null, scrollY: window.scrollY };
  pageParts.title.textContent = detail.id;
  pageParts.crumb.textContent = detail.id;
  updatePageNow(detail);
  renderFacts(detail);
  renderHistory(detail);

  const desk = createDeskViewer({ ramLabel: detail.id, slotId: slotIdFor(detail), copy: PAGE_COPY, load: deskLoad });
  pageParts.screen.prepend(desk.el);
  openPage.desk = desk;
  desk.refresh();

  document.title = `${detail.id}: ${roundShort(detail)}, ${STATUS_WORD[detail.status] || detail.status}. RAMherd`;
  ramPage.hidden = false;
  document.body.classList.add("page-open");
  window.scrollTo(0, 0);
  pageParts.title.setAttribute("tabindex", "-1");
  pageParts.title.focus({ preventScroll: true });
}

function closeRamPage(restoreFocus = true) {
  if (!openPage) return;
  const { desk, returnTo, scrollY } = openPage;
  openPage = null;
  if (desk) desk.destroy();
  pageParts.now.innerHTML = "";
  ramPage.hidden = true;
  document.body.classList.remove("page-open");
  document.title = "RAMherd: memecoin-funded cryptanalysis research, live";
  if (restoreFocus && returnTo && document.contains(returnTo)) {
    window.scrollTo(0, scrollY);
    returnTo.focus({ preventScroll: true });
  }
}

let lastClickedOpener = null;
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#ram/"]');
  if (a) lastClickedOpener = a;
});

function route() {
  const m = /^#ram\/([A-Za-z0-9_%-]+)$/.exec(location.hash);
  if (m) {
    openRamPage(decodeURIComponent(m[1]), lastClickedOpener);
    lastClickedOpener = null;
  } else {
    closeRamPage(true);
  }
}
window.addEventListener("hashchange", route);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPage) location.hash = "#board";
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  if (await deskFeedAvailable()) {
    directory = createDeskDirectory();
    await directory.refresh();
  }
  await Promise.all([renderStats(), renderFleet(), renderHerder(), seedChat()]);
  route();
  RAMherdAPI.subscribeLive(() => {
    renderStats();
    renderFleet();
    renderHerder();
  }, 4000);
  // Every screen re-checks its stream every 10s; the iframe is only touched when the
  // stream itself changes, so a poll never reloads a live desk.
  setInterval(async () => {
    if (directory) await directory.refresh();
    for (const t of tiles.values()) t.desk.refresh();
    if (openPage && openPage.desk) openPage.desk.refresh();
  }, DESK_POLL_MS);
}

boot();
