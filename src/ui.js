// HashRammers: the listing's primitives, shared by every page that prints a line.
// The status words, the pixel glyphs, the judge's column, the one motion (the print),
// and the small writers that only touch the DOM when a value actually changed.
// No data access here: every page gets its data through RAMherdAPI (mock-data.js).

// The exact words the herd writes, one per status. "Submitted" carries its fuller form as a
// tooltip: the screen shows the short word, the key spells it out.
export const STATUS_WORD = { idle: "Idle", thinking: "Thinking", running: "Running an experiment", submitted: "Submitted", validated: "Validated", failed: "Failed" };
export const STATUS_FULL = {
  submitted: "Submitted to HashSmash",
  validated: "Passed HashSmash's real local intake (mechanical checks only) — not judged, not submitted",
  failed: "This attempt did not produce a usable result",
};
export const STATUS_ORDER = ["running", "thinking", "idle", "submitted", "validated", "failed"];

// Where a handed-in candidate stands with HashSmash's review. The feed sends `judge`
// ("in review" or null); if it does not, a submitted slot falls back to "in review", HashSmash's
// intake state ("In review — Awaiting manual review" on their results page). "accepted" only
// ever comes from their judge, never from this site: nothing from the herd has been accepted.
export const JUDGE_WORD = { submitted: "in review" };
export const JUDGE_FULL = { "in review": "In review — Awaiting manual review" };

// HashSmash's score: log₂(T), total charged computation, lower is better. Written only once
// their judge has scored a candidate; until then an em dash, exactly as their frontier reads.
export const SCORE_TERM = "log₂(T)";

// A RAM nobody has heard from for this long dims. A submitted RAM is waiting on HashSmash's
// judge, not silent, so it never dims however long the review takes.
export const STALE_AFTER_SECONDS = 300;
export const isStale = (agent, seconds) => seconds > STALE_AFTER_SECONDS && agent.status !== "submitted" && agent.status !== "validated";

// Pixel status glyphs on an 8×8 grid. Running has two frames (the burst) and blinks between them.
const GLYPH = {
  running: '<path class="f1" d="M3 3h2v2h-2zM1 1h1v1h-1zM6 1h1v1h-1zM1 6h1v1h-1zM6 6h1v1h-1z"/><path class="f2" d="M3 3h2v2h-2zM3 0h2v1h-2zM3 7h2v1h-2zM0 3h1v2h-1zM7 3h1v2h-1z"/>',
  thinking: '<path d="M0 3h2v2h-2zM3 3h2v2h-2zM6 3h2v2h-2z"/>',
  idle: '<path d="M1 1h6v1h-6zM1 6h6v1h-6zM1 2h1v4h-1zM6 2h1v4h-1z"/>',
  submitted: '<path d="M0 4h1v1h-1zM1 5h1v1h-1zM2 6h1v1h-1zM3 5h1v1h-1zM4 4h1v1h-1zM5 3h1v1h-1zM6 2h1v1h-1zM7 1h1v1h-1z"/>',
};
GLYPH.validated = GLYPH.submitted; // passed a real mechanical check, same "checkmark" shape
GLYPH.failed = GLYPH.idle; // distinguished by its word and dim state, not a bespoke glyph yet
export const glyph = (status) =>
  `<svg class="glyph${status === "running" ? " glyph-run" : ""}" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">${GLYPH[status] || GLYPH.idle}</svg>`;

export const money = (n) => `$${n.toFixed(2)}`;
export const $ = (id) => document.getElementById(id);
export const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// "SHA-256 r31": the feed's roundLabel, or derived from "SHA-256 · r31 · exploratory".
export function roundShort(agent) {
  if (agent.roundLabel) return agent.roundLabel;
  const [target, round] = String(agent.trackLabel).split(" · ");
  return round ? `${target} ${round}` : agent.trackLabel;
}

// A log₂(T) value as HashSmash prints it (125.99, 41.500001): the number as sent, never rounded.
export function scoreText(log2T) {
  return log2T == null || log2T === "" ? null : String(log2T);
}

// "8s ago" / "41m ago" / "1h 2m ago" -> seconds. Fallback when the feed sends no raw number.
function parseSeconds(label) {
  const h = /(\d+)h/.exec(label);
  const m = /(\d+)m/.exec(label);
  const s = /(\d+)s/.exec(label);
  return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s ? +s[1] : 0);
}

export function secondsOf(agent) {
  return typeof agent.updatedSecondsAgo === "number" ? agent.updatedSecondsAgo : parseSeconds(agent.updatedLabel || "");
}

// Server slots are `slot-0`, `slot-1`, ... in roster order (RAM 1 = slot-0).
// The mock herd has no slot ids yet, so derive it; a real feed should send `slotId`.
export function slotIdFor(agent) {
  if (agent.slotId) return agent.slotId;
  const n = Number(String(agent.id).replace(/^ram-/, ""));
  return Number.isInteger(n) && n > 0 ? `slot-${n - 1}` : String(agent.id);
}

// A RAM's page lives on the herd page, over the board: /herd#ram/<id>. From the herd
// page itself the hash alone is enough (and keeps the opener for focus restore).
export const ramHref = (id, { samePage = false } = {}) => `${samePage ? "" : "/herd"}#ram/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------
// The one authored motion: a new or changed line is printed, left to right, in steps.
// ---------------------------------------------------------------------------

export function print(el) {
  if (reducedMotion.matches) return;
  el.classList.remove("printing");
  void el.offsetWidth; // restart if already printing
  el.classList.add("printing");
}
document.addEventListener("animationend", (e) => {
  if (e.target.classList && e.target.classList.contains("printing")) e.target.classList.remove("printing");
});

// Sets text only when it changed; returns whether it did.
export function write(el, text) {
  if (el.textContent === text) return false;
  el.textContent = text;
  return true;
}

// A path like lanes/exploratory/candidates/sha256-r31/ may break after any slash, never
// inside a segment.
export function writePath(el, path) {
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
export function writeNowLine(parts, agent, prevSeconds) {
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

// The herd by status: a glyph, a count and the word, one per status, in a .herd-counts list.
// Rewritten only when a count changed.
export function writeCounts(el, breakdown) {
  const key = STATUS_ORDER.map((s) => breakdown[s]).join("/");
  if (el.dataset.key === key) return false;
  el.dataset.key = key;
  el.innerHTML = STATUS_ORDER.map((s) => `<li>${glyph(s)}<span class="n">${breakdown[s]}</span><span>${STATUS_WORD[s]}</span></li>`).join("");
  return true;
}

// The judge's column: HashSmash's review state, then their score. Only a handed-in
// candidate has either; every other row leaves it blank (an em dash).
export function judgeMarkup(agent) {
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
