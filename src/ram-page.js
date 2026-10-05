// RAMherd: a RAM's full page, /herd#ram/<id>. Its screen, larger, its facts, its whole
// history. Opened over the board (the board stays mounted and keeps ticking underneath);
// Escape or the Back pill returns to the board with scroll and focus restored.
// Data through RAMherdAPI only; the desk stream through the board's shared feed.

import { RAMherdAPI } from "./mock-data.js";
import { createDeskViewer } from "./sandbox-viewer.js";
import { $, JUDGE_FULL, JUDGE_WORD, SCORE_TERM, STATUS_WORD, glyph, print, roundShort, scoreText, slotIdFor, writeNowLine, writePath } from "./ui.js";

const PAGE_COPY = {
  checking: (label) => `Checking ${label}'s desk…`,
  idle: (label) => `No desk running for ${label}. Its work runs on the host right now; when a sandbox is started for it, its screen shows here, watch-only.`,
  unreachable: (label) => `${label}'s desk feed could not be reached just now.`,
};

// Where the hash goes when the page closes: the board, on this same page.
const BOARD_HASH = "#board";

/**
 * @param {{ feed: { load: (slotId: string) => Promise<any> } }} opts
 */
export function mountRamPage({ feed }) {
  const ramPage = $("ram-page");
  const parts = {
    title: $("ram-page-title"),
    crumb: $("ram-page-crumb-id"),
    now: $("ram-page-now"),
    screen: $("ram-page-screen"),
    facts: $("ram-page-facts"),
    history: $("ram-page-history"),
  };
  const pageTitle = document.title;
  let open = null; // { id, desk, now, seconds, returnTo, scrollY }

  function updateNow(agent) {
    if (!open) return;
    if (!open.now) {
      parts.now.innerHTML = `<span class="now-glyph"></span><span class="now-word"></span><span class="now-clock"></span>`;
      open.now = { glyph: parts.now.querySelector(".now-glyph"), word: parts.now.querySelector(".now-word"), clock: parts.now.querySelector(".now-clock"), line: parts.now };
      open.seconds = Infinity;
    }
    const first = open.seconds === Infinity;
    const r = writeNowLine(open.now, agent, open.seconds);
    open.seconds = r.seconds;
    if (!first && (r.statusChanged || r.freshWrite)) print(parts.now);
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
    parts.facts.innerHTML = "";
    for (const [k, v, isPath] of rows) {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      if (isPath) writePath(dd, v);
      else if (k === "HashSmash review") dd.innerHTML = v;
      else dd.textContent = v;
      div.append(dt, dd);
      parts.facts.append(div);
    }
  }

  function renderHistory(detail) {
    parts.history.innerHTML = "";
    detail.history.forEach((line, i) => {
      const li = document.createElement("li");
      if (i === 0) li.className = "is-now";
      li.innerHTML = `<span class="hist-at"></span><span class="hist-word">${glyph(line.status)}<span></span></span><p class="hist-text"></p>`;
      li.querySelector(".hist-at").textContent = line.label;
      li.querySelector(".hist-word span").textContent = STATUS_WORD[line.status] || line.status;
      li.querySelector(".hist-text").textContent = line.text;
      parts.history.append(li);
    });
  }

  async function openPage(id, returnTo) {
    if (open && open.id === id) return;
    if (open) closePage(false);
    const detail = await RAMherdAPI.getRamDetail(id);
    if (!detail) {
      location.hash = BOARD_HASH;
      return;
    }
    open = { id, desk: null, now: null, seconds: Infinity, returnTo: returnTo || null, scrollY: window.scrollY };
    parts.title.textContent = detail.id;
    parts.crumb.textContent = detail.id;
    updateNow(detail);
    renderFacts(detail);
    renderHistory(detail);

    const desk = createDeskViewer({ ramLabel: detail.id, slotId: slotIdFor(detail), copy: PAGE_COPY, load: feed.load });
    parts.screen.prepend(desk.el);
    open.desk = desk;
    desk.refresh();

    document.title = `${detail.id}: ${roundShort(detail)}, ${STATUS_WORD[detail.status] || detail.status}. RAMherd`;
    ramPage.hidden = false;
    document.body.classList.add("page-open");
    window.scrollTo(0, 0);
    parts.title.setAttribute("tabindex", "-1");
    parts.title.focus({ preventScroll: true });
  }

  function closePage(restoreFocus = true) {
    if (!open) return;
    const { desk, returnTo, scrollY } = open;
    open = null;
    if (desk) desk.destroy();
    parts.now.innerHTML = "";
    ramPage.hidden = true;
    document.body.classList.remove("page-open");
    document.title = pageTitle;
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
      openPage(decodeURIComponent(m[1]), lastClickedOpener);
      lastClickedOpener = null;
    } else {
      closePage(true);
    }
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) location.hash = BOARD_HASH;
  });

  return {
    route,
    /** A fleet tick: keeps the open page's now-line current. */
    update(fleet) {
      if (!open) return;
      const agent = fleet.find((a) => a.id === open.id);
      if (agent) updateNow(agent);
    },
    refreshDesk() {
      if (open && open.desk) open.desk.refresh();
    },
  };
}
