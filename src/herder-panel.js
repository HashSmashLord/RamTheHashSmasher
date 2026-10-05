// HashRammers: the Herder's panel (/herder). Its summary, the herd by status, one line per
// RAM, and the chat: a terminal log, oldest at the top, the prompt at the bottom.
// Read-only by design: nothing typed here reaches a RAM. Data through RAMherdAPI only.

import { RAMherdAPI } from "./mock-data.js";
import { $, isStale, print, ramHref, write, writeCounts, writeNowLine } from "./ui.js";

export function mountHerderPanel() {
  // --- the herd view: summary, counts, one line per RAM -------------------------------

  const herdLines = new Map();
  let renderedOnce = false;

  function renderHerdLines(fleet) {
    const list = $("herder-lines");
    const seen = new Set();
    for (const agent of fleet) {
      seen.add(agent.id);
      let h = herdLines.get(agent.id);
      const first = !h;
      if (first) {
        const li = document.createElement("li");
        li.innerHTML = `<a class="h-id" href="${ramHref(agent.id)}"></a><span class="now-line"><span class="now-glyph"></span><span class="now-word"></span></span><span class="h-text"></span>`;
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

  async function render() {
    const [summary, stats, fleet] = await Promise.all([RAMherdAPI.getHerderSummary(), RAMherdAPI.getStats(), RAMherdAPI.getFleet()]);
    const first = !renderedOnce;
    renderedOnce = true;

    const line = $("herder-summary");
    if (write(line, summary.summary) && !first) print(line);
    write($("herder-clock"), `updated ${summary.updatedLabel}`);
    writeCounts($("herder-counts"), stats.breakdown);
    renderHerdLines(fleet);
  }

  // --- the chat --------------------------------------------------------------------------

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

  return { render, seedChat };
}
