// HashRammers: Logs (/logs). Real commits to this site -- frontend and backend -- each
// linking to its own real GitHub commit on HashSmashLord/RamTheHashSmasher. Straight off
// GET /api/changelog (server/lib/changelog.js's own cached GitHub read); unlike mock-data.js's
// RAMherdAPI, there is no mock fallback here -- there is no honest placeholder for a real
// commit history, so a fetch failure just says so instead of inventing one.

import { initNav } from "./nav.js";
import { $ } from "./ui.js";

initNav();

const status = $("changelog-status");
const groups = $("changelog-groups");

/** The commit's own date, as a calendar-day key (its UTC date, same as GitHub shows it on the repo's commit list). */
function dayKey(iso) {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "undated";
}

function dayHeading(key) {
  if (key === "undated") return "Undated";
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  return date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function commitLine(commit) {
  const li = document.createElement("li");
  li.className = "changelog-line";

  const subject = document.createElement("p");
  subject.className = "changelog-subject";
  const link = document.createElement("a");
  link.href = commit.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = commit.message?.subject || "(no commit message)";
  subject.append(link);
  const sr = document.createElement("span");
  sr.className = "sr-only";
  sr.textContent = " (opens its real commit on GitHub in a new tab)";
  link.append(sr);

  const meta = document.createElement("p");
  meta.className = "changelog-meta";
  const sha = document.createElement("span");
  sha.className = "changelog-sha";
  sha.textContent = commit.shortSha || "";
  const author = document.createElement("span");
  author.textContent = commit.author || "unknown";
  meta.append(sha, author);
  if (commit.date) {
    const time = document.createElement("time");
    time.dateTime = commit.date;
    time.textContent = new Date(commit.date).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" });
    meta.append(time);
  }

  li.append(subject, meta);

  if (commit.message?.body) {
    const body = document.createElement("p");
    body.className = "changelog-body";
    body.textContent = commit.message.body;
    li.append(body);
  }
  return li;
}

/** Groups already-newest-first commits by UTC day, keeping that same newest-first order. */
function groupByDay(commits) {
  const byDay = new Map();
  for (const commit of commits) {
    const key = dayKey(commit.date);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(commit);
  }
  return byDay;
}

function render(commits) {
  groups.replaceChildren();
  if (!commits.length) {
    const empty = document.createElement("p");
    empty.className = "changelog-empty";
    empty.textContent = "No commits to show yet.";
    groups.append(empty);
    return;
  }
  for (const [key, dayCommits] of groupByDay(commits)) {
    const section = document.createElement("div");
    section.className = "changelog-day";
    const head = document.createElement("h3");
    head.className = "changelog-day-head";
    head.textContent = dayHeading(key);
    const ul = document.createElement("ul");
    ul.className = "changelog-lines";
    ul.append(...dayCommits.map(commitLine));
    section.append(head, ul);
    groups.append(section);
  }
}

async function load() {
  try {
    const res = await fetch("/api/changelog");
    const body = await res.json();
    if (!res.ok || body?.ok === false) throw new Error(body?.message || `HTTP ${res.status}`);
    const changelog = body.changelog || {};
    render(changelog.commits || []);
    status.textContent = changelog.updatedAt
      ? `Last checked ${new Date(changelog.updatedAt).toLocaleString()} — server/lib/changelog.js polls GitHub's real commit history every 10 minutes.`
      : "Checking GitHub for the first time — try again in a moment.";
  } catch (err) {
    console.error("Logs fetch failed:", err);
    status.textContent = "Could not load the log right now. Try again shortly.";
  }
}

await load();
