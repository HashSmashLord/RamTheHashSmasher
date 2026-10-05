// RAMherd: page wiring. Every piece of data comes through RAMherdAPI (mock-data.js).
// Swap point: nothing in this file changes when the real backend lands, only the
// method bodies inside RAMherdAPI do. See the header comment there.

import { RAMherdAPI } from "./mock-data.js";
import { createDeskViewer } from "./sandbox-viewer.js";

// The exact words the Now column writes, one per status. "Submitted" carries its fuller form
// as a tooltip: the board shows the short word, the key spells it out.
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

// A row nobody has written to for this long thins its ink.
const STALE_AFTER_SECONDS = 300;

const GLYPH = {
  running: '<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.6"/>',
  thinking: '<circle cx="8" cy="8" r="6"/><path d="M5.4 8h.01M8 8h.01M10.6 8h.01"/>',
  idle: '<circle cx="8" cy="8" r="6" stroke-dasharray="2.4 2.2"/>',
  submitted: '<circle cx="8" cy="8" r="6"/><path d="M5.3 8.3l1.9 1.9 3.6-4"/>',
};
const glyph = (status) =>
  `<svg class="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[status] || GLYPH.idle}</svg>`;

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

// ---------------------------------------------------------------------------
// The one authored motion: a changed cell is re-inked, left to right.
// ---------------------------------------------------------------------------

function ink(el) {
  if (reducedMotion.matches) return;
  el.classList.remove("writing");
  void el.offsetWidth; // restart the animation if it is already running
  el.classList.add("writing");
}
document.addEventListener("animationend", (e) => {
  if (e.target.classList && e.target.classList.contains("writing")) e.target.classList.remove("writing");
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
    segment.className = "path-segment"; // nowrap: a hyphen inside a segment is never a break
    segment.textContent = i < parts.length - 1 ? `${part}/` : part;
    el.append(segment);
    if (i < parts.length - 1) el.append(document.createElement("wbr"));
  });
  return true;
}

// ---------------------------------------------------------------------------
// Nav toggle (narrow widths)
// ---------------------------------------------------------------------------

const navToggle = $("nav-toggle");
const mainNav = $("main-nav");
navToggle.addEventListener("click", () => {
  const open = mainNav.classList.toggle("is-open");
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
});
mainNav.addEventListener("click", (e) => {
  if (e.target.closest("a")) {
    mainNav.classList.remove("is-open");
    navToggle.setAttribute("aria-expanded", "false");
    navToggle.setAttribute("aria-label", "Open menu");
  }
});

// ---------------------------------------------------------------------------
// Fund rows (header box)
// ---------------------------------------------------------------------------

let statsRenderedOnce = false;

async function renderStats() {
  const s = await RAMherdAPI.getStats();
  const first = !statsRenderedOnce;
  statsRenderedOnce = true;

  // The figures are visible from the first paint; only later writes are inked.
  const fees = $("stat-fees");
  if (write(fees, money(s.feesCollectedLifetime)) && !first) ink(fees);

  const spent = $("stat-budget");
  if (write(spent, money(s.computeSpentEpoch)) && !first) ink(spent);
  write($("stat-budget-total"), money(s.computeBudgetEpoch));
  write($("stat-epoch"), s.epochLabel);

  const share = Math.min(1, s.computeSpentEpoch / s.computeBudgetEpoch);
  const meter = $("stat-budget-meter");
  if (first) meter.classList.add("no-transition"); // the meter is drawn, not animated, on first paint
  meter.style.transform = `scaleX(${share.toFixed(4)})`;
  if (first) requestAnimationFrame(() => requestAnimationFrame(() => meter.classList.remove("no-transition")));

  write($("stat-slots"), `${s.slotsActive} of ${s.slotsMax}`);
}

// ---------------------------------------------------------------------------
// The board: one row per RAM, diffed by id so a tick never re-renders the sheet
// ---------------------------------------------------------------------------

const rows = new Map();

function buildRow() {
  const tr = document.createElement("tr");
  tr.setAttribute("role", "row");
  tr.innerHTML = `
    <td role="cell" class="c-entrant"><span class="entrant-id"></span><span class="entrant-model"></span><span class="entrant-approach"></span><button type="button" class="desk-toggle" aria-expanded="false">Watch desk</button></td>
    <td role="cell" class="c-round"><span class="round-id"></span><span class="round-path"></span></td>
    <td role="cell" class="c-now">
      <div class="now-line"><span class="now-glyph"></span><span class="now-word"></span><span class="now-clock"></span></div>
      <p class="now-activity"></p>
    </td>
    <td role="cell" class="c-judge"></td>`;
  return {
    tr,
    seconds: Infinity,
    judge: null,
    score: undefined,
    id: tr.querySelector(".entrant-id"),
    model: tr.querySelector(".entrant-model"),
    approach: tr.querySelector(".entrant-approach"),
    round: tr.querySelector(".round-id"),
    path: tr.querySelector(".round-path"),
    line: tr.querySelector(".now-line"),
    glyphEl: tr.querySelector(".now-glyph"),
    word: tr.querySelector(".now-word"),
    clock: tr.querySelector(".now-clock"),
    activity: tr.querySelector(".now-activity"),
    judgeCell: tr.querySelector(".c-judge"),
    deskToggle: tr.querySelector(".desk-toggle"),
    deskRow: null,
    desk: null,
  };
}

// ---------------------------------------------------------------------------
// A RAM's desk: its live desktop, view-only (sandbox-viewer.js), opened in a
// ruled row under its board row. Only the server's view-only stream is ever
// requested; there is no other stream for this page to get.
// ---------------------------------------------------------------------------

// Server slots are `slot-0`, `slot-1`, ... in roster order (RAM 1 = slot-0).
// The mock board has no slot ids yet, so derive it; a real feed should send `slotId`.
function slotIdFor(agent) {
  if (agent.slotId) return agent.slotId;
  const n = Number(String(agent.id).replace(/^ram-/, ""));
  return Number.isInteger(n) && n > 0 ? `slot-${n - 1}` : String(agent.id);
}

function toggleDesk(r, agent) {
  if (r.desk) {
    r.desk.destroy();
    r.deskRow.remove();
    r.desk = r.deskRow = null;
    r.deskToggle.setAttribute("aria-expanded", "false");
    r.deskToggle.textContent = "Watch desk";
    return;
  }
  const tr = document.createElement("tr");
  tr.className = "desk-row";
  tr.setAttribute("role", "row");
  const td = document.createElement("td");
  td.setAttribute("role", "cell");
  td.colSpan = 4;
  tr.append(td);
  const desk = createDeskViewer({ ramLabel: agent.id, slotId: slotIdFor(agent) });
  td.append(desk.el);
  td.id = `desk-${agent.id}`;
  r.deskToggle.setAttribute("aria-controls", td.id);
  r.tr.after(tr);
  r.deskRow = tr;
  r.desk = desk;
  r.deskToggle.setAttribute("aria-expanded", "true");
  r.deskToggle.textContent = "Close desk";
  desk.refresh();
}

function updateRow(r, agent, first) {
  write(r.id, agent.id);
  writePath(r.model, agent.model || "");
  write(r.approach, agent.approach);
  write(r.round, roundShort(agent));
  writePath(r.path, agent.lanePath);

  const statusChanged = write(r.word, STATUS_WORD[agent.status] || agent.status);
  if (statusChanged) {
    r.glyphEl.innerHTML = glyph(agent.status);
    if (STATUS_FULL[agent.status]) r.word.title = STATUS_FULL[agent.status];
    else r.word.removeAttribute("title");
  }
  const activityChanged = write(r.activity, agent.activity);
  write(r.clock, `written ${agent.updatedLabel}`);

  const seconds = typeof agent.updatedSecondsAgo === "number" ? agent.updatedSecondsAgo : parseSeconds(agent.updatedLabel);
  const freshWrite = seconds < r.seconds; // the clock went backwards: someone just wrote this row
  r.seconds = seconds;
  r.tr.classList.toggle("stale", seconds > STALE_AFTER_SECONDS);

  // Judge column: HashSmash's review state, then their score. Only a handed-in candidate has
  // either; every other row leaves the margin blank (an em dash).
  const judge = agent.judge !== undefined ? agent.judge : JUDGE_WORD[agent.status] || null;
  const score = scoreText(agent.log2T);
  if (judge !== r.judge || score !== r.score) {
    r.judge = judge;
    r.score = score;
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
    r.judgeCell.innerHTML = parts.join("");
  }

  if (!first && (statusChanged || activityChanged || freshWrite)) {
    ink(r.line);
    if (activityChanged) ink(r.activity);
  }
}

function renderByRound(fleet) {
  const groups = new Map();
  for (const agent of fleet) {
    const key = roundShort(agent);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(agent.id.replace(/^ram-/, ""));
  }
  const list = $("by-round");
  const signature = JSON.stringify([...groups]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;

  list.innerHTML = "";
  for (const [round, entrants] of groups) {
    const item = document.createElement("div");
    item.className = "by-round-item";
    const dt = document.createElement("dt");
    dt.textContent = round;
    const dd = document.createElement("dd");
    dd.textContent = entrants.join(", ");
    item.append(dt, dd);
    list.append(item);
  }
}

async function renderFleet() {
  const fleet = await RAMherdAPI.getFleet();
  const tbody = $("results-body");
  const seen = new Set();

  for (const agent of fleet) {
    seen.add(agent.id);
    let r = rows.get(agent.id);
    const first = !r;
    if (first) {
      r = buildRow();
      rows.set(agent.id, r);
      tbody.appendChild(r.tr);
      const row = r;
      row.deskToggle.addEventListener("click", () => toggleDesk(row, row.agent));
    }
    r.agent = agent;
    updateRow(r, agent, first);
  }
  for (const [id, r] of rows) {
    if (!seen.has(id)) {
      if (r.desk) toggleDesk(r, r.agent);
      r.tr.remove();
      rows.delete(id);
    }
  }
  renderByRound(fleet);
}

// ---------------------------------------------------------------------------
// Coordinator log: the question box sits on top, newest Q&A written first
// ---------------------------------------------------------------------------

const chatLog = $("chat-log");
const chatForm = $("chat-form");
const chatInput = $("chat-input");
const askButton = chatForm.querySelector("button");

function logEntry({ q, a, pending = false }) {
  const li = document.createElement("li");
  if (pending) li.className = "log-pending";
  li.innerHTML =
    `<span class="log-mark" aria-hidden="true">Q</span><p class="log-q"><span class="sr-only">You asked: </span></p>` +
    `<span class="log-mark" aria-hidden="true">A</span><p class="log-a"><span class="sr-only">Coordinator: </span></p>`;
  li.querySelector(".log-q").append(q);
  li.querySelector(".log-a").append(a);
  chatLog.prepend(li);
  return li;
}

function answerEntry(li, text) {
  li.classList.remove("log-pending");
  const a = li.querySelector(".log-a");
  a.innerHTML = `<span class="sr-only">Coordinator: </span>`;
  a.append(text);
  ink(a);
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
    answerEntry(li, "The coordinator could not be reached. Ask again in a moment.");
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
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  await Promise.all([renderStats(), renderFleet(), seedChat()]);
  RAMherdAPI.subscribeLive(() => {
    renderStats();
    renderFleet();
  }, 4000);
  // An open desk re-checks its stream every 10s (a sandbox may start or stop);
  // the iframe is only touched when the stream itself changes.
  setInterval(() => {
    for (const r of rows.values()) r.desk?.refresh();
  }, 10_000);
}

boot();
