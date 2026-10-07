// The visible side of a RAM's always-on research loop (slots.js "Active loop").
//
// After the one-time workbench intro (sandbox-task.js), slots.js keeps calling
// the slot's REAL `advance()` (idle -> thinking -> running-experiment ->
// validated|submitted|failed -> idle -> ...), back to back, for as long as the
// sandbox is up. This module is what each of those steps looks like on the
// desktop:
//   - a real text editor (Mousepad) with a notes file, into which the exact
//     feed line(s) that step produced are TYPED, keystroke by keystroke, then
//     saved; the saved file is read back so "it was typed" is observed, not
//     assumed;
//   - occasionally, when the RAM's own model asked for a literature search
//     (a final "SEARCH: <query>" line on a thinking step), the real Google
//     Chrome on the desktop is pointed at the IACR ePrint archive's search for
//     that query (typed into the address bar), and the result list's real
//     paper ids and titles are read back so the RAM's next thinking step can
//     use them;
//   - on a running-experiment step, a real terminal (xfce4-terminal) opens
//     (or is reused) and TYPES a real, cycling command that looks at the
//     SAME real clone the one-time workbench intro made (`~/hash-smash`):
//     `git log`, `ls` the candidate directory, `cat claim.json`, `cat
//     proof.md`, `cat TASK.md`. The exact output is read back too, so what a
//     viewer sees typed and what gets reported honestly are the same real
//     thing — never a fabricated result or an invented busywork command.
//   - occasionally, when the RAM's own model asked to see how other real
//     competitors on its own track are doing (a final "PEERS: <reason>"
//     line on a thinking step), the same real terminal types a real,
//     unauthenticated, read-only GitHub API call against the real, public,
//     official competition repo (Layr-Labs/hash-smash): the open pull
//     requests, filtered to ones whose own title/body actually mentions
//     this RAM's track. Those are OTHER COMPETITORS' OWN CLAIMS — an open PR
//     is a self-reported "claimed score", not yet validated by anyone, and
//     may still be rejected or wrong — never trusted, never copied, treated
//     exactly like an ePrint paper's title: real, citable material to read
//     and reason about, not proof of anything.
//   - (2026-10-07) when the RAM's own model asked to READ one specific IACR
//     ePrint paper (a final "READ: <id>" line), Chrome is pointed at that
//     paper's own page (typed into the address bar) and the same page is
//     fetched with curl and parsed for its real title, authors, abstract and
//     keywords (readPaper / parseEprintPaperPage) — the fix for the loop's
//     long-flagged title-only literature access. Only ever
//     https://eprint.iacr.org/<YYYY>/<N>, built from a validated id; the PDF
//     body is not read and nothing says it was.
//
// Checked against the real E2B `desktop` template on 2026-10-05 (a probe
// sandbox, `command -v` + /usr/share/applications): Mousepad 0.5.8, gedit and
// gnome-text-editor are installed (leafpad, nano, vim are not); Google Chrome
// 150 is installed (`google-chrome`; the `firefox` binary is not on PATH, only
// a firefox-esr .desktop entry); xfce4-terminal, xdotool, xprop and curl are
// present, and the sandbox reaches eprint.iacr.org (HTTP 200) and
// api.github.com (unauthenticated, read-only, no token needed for a public
// repo's open PRs). Mousepad is used because it is Xfce's own editor (the
// desktop is Xfce) and starts fast.
//
// Everything goes through the sandbox's authenticated command channel. Text
// reaches the sandbox only as single-quoted (shQuote) xdotool arguments or
// base64; search queries are reduced to [A-Za-z0-9 .+-] before they are put
// into a URL. No secret is ever typed: only public feed lines and queries.

import { shQuote, checkAssignment, REPO_DIR as WORKBENCH_REPO_DIR } from './sandbox-task.js';

export const NOTES_DIR = '/tmp/ramnotes';
export const CHROME_PROFILE_DIR = '/tmp/ramchrome';
export const EPRINT_SEARCH_URL = 'https://eprint.iacr.org/search?q=';
/** The real, public, official HashSmash competition repo (Layr-Labs/hash-smash). */
export const HASHSMASH_GITHUB_REPO = 'Layr-Labs/hash-smash';
/** How many of a track's matching open PRs are surfaced per PEERS lookup: "a handful", not all of them. */
export const MAX_PEER_RESULTS = 5;

/** Pause between two advance() steps, seconds. The loop never waits longer than MAX. */
export const DEFAULT_STEP_PAUSE_SEC = 5;
export const MIN_STEP_PAUSE_SEC = 2;
export const MAX_STEP_PAUSE_SEC = 30;
/** A browse happens on at most one in every `browseEvery` thinking steps (and only when the model asked). */
export const DEFAULT_BROWSE_EVERY = 2;
/**
 * A real competitor-PR lookup (PEERS:) happens on at most one in every
 * `peersEvery` thinking steps, same shape as `browseEvery` for ePrint
 * searches, and only when the model asked. Slightly rarer than literature
 * search by default: it is a secondary grounding activity, not meant to
 * become the loop's dominant one.
 */
export const DEFAULT_PEERS_EVERY = 3;
/** Hard cap on real thinking (LLM) calls one sandbox session may make before the loop stops. */
export const DEFAULT_MAX_THINKING_PER_SESSION = 60;
/**
 * Hard cap, per slot, on how many times the loop makes a dedicated "do you
 * really have something to draft" call (slots.js's runLoopDraftAttempt).
 * Deliberately small and separate from DEFAULT_MAX_THINKING_PER_SESSION:
 * most cycles should never even reach this, and this cap keeps it that way
 * even if a model gets enthusiastic about proposing drafts.
 */
export const DEFAULT_MAX_DRAFT_ATTEMPTS_PER_SESSION = 3;
/**
 * The real research tools (2026-10-07): bounded EXPERIMENT / VERIFY runs
 * (research-tools.js, host CPU only, no paid call) and READ of one ePrint
 * paper page. Each is still rate limited and capped per session, same shape
 * as SEARCH/PEERS, so no single tool can take over the loop.
 */
export const DEFAULT_EXPERIMENT_EVERY = 1;
export const DEFAULT_MAX_EXPERIMENTS_PER_SESSION = 20;
export const DEFAULT_MAX_VERIFIES_PER_SESSION = 20;
export const DEFAULT_READ_EVERY = 1;
export const DEFAULT_MAX_READS_PER_SESSION = 12;
/** max_tokens for the dedicated drafting call (slots.js's LOOP_DRAFT_SYSTEM). */
export const LOOP_DRAFT_MAX_TOKENS = 700;
/** max_tokens for the adversarial verification call (slots.js's LOOP_VERIFY_SYSTEM) -- a two-line verdict, no reasoning dump needed. */
export const LOOP_VERIFY_MAX_TOKENS = 200;
/**
 * max_tokens for a loop thinking call. Measured on the real roster model
 * (anthropic/claude-opus-5.5 via OpenRouter, 2026-10-05): reasoning is
 * mandatory on that endpoint and used all of the default 300 tokens, leaving
 * an empty answer; with 800 it finished (about 200 reasoning tokens) with a
 * full answer and its SEARCH line, for about $0.008. A ceiling, not a spend.
 */
export const LOOP_THINKING_MAX_TOKENS = 800;
/** The idle ceiling the loop is built to: never this long between two steps unless one is mid-call. */
export const MAX_IDLE_MS = 60_000;

/** Longest text typed per step (the feed keeps the full message). Keeps one step's typing near 15 s. */
export const MAX_TYPED_CHARS = 600;

const ASCII_MAP = { '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u2248': '~', '\u00d7': 'x', '\u2192': '->', '\u2264': '<=', '\u2265': '>=', '\u00a0': ' ' };

/** Plain printable ASCII (xdotool types it reliably), newlines kept. */
export function asciiText(text) {
  return String(text ?? '')
    .replace(/[\u2018\u2019\u201c\u201d\u2013\u2014\u2026\u2248\u00d7\u2192\u2264\u2265\u00a0]/g, (c) => ASCII_MAP[c])
    .normalize('NFKD')
    .replace(/[^\x20-\x7e\n]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Splits a model's thinking text into the note and its optional trailing
 * signal lines: a "SEARCH: ..." query, a "PEERS: ..." request to look at
 * real competitors' own open submissions on this track, a "DRAFT: ..."
 * line the model uses only when it believes its real research this session
 * gives it something specific and disclosed to propose as an improved
 * candidate claim, and (2026-10-07, the real research tools) an
 * "EXPERIMENT: ..." request for a real bounded computation against this
 * track's exact target (research-tools.js), a "VERIFY: ..." request to
 * recompute a candidate pair under the target for real, and a "READ: ..."
 * request to fetch one IACR ePrint paper's own page (title, authors,
 * abstract). slots.js's active loop then decides, with its own real gates
 * and rate limits, whether to act on any of these — this function only
 * extracts what was said. READ only ever yields a bare ePrint id (the URL
 * is built from it later, on the one allowed domain); anything else is null.
 */
export function parseThinking(text) {
  const lines = String(text ?? '').split('\n');
  let search = null;
  let peers = null;
  let draft = null;
  let experiment = null;
  let verify = null;
  let read = null;
  const kept = [];
  for (const line of lines) {
    const m = /^\s*\**\s*(SEARCH|PEERS|DRAFT|EXPERIMENT|VERIFY|READ)\s*:\**\s*(.+)$/i.exec(line);
    if (!m) { kept.push(line); continue; }
    const value = m[2].replace(/\*+\s*$/, '');
    switch (m[1].toUpperCase()) {
      case 'SEARCH': search = value; break;
      case 'PEERS': peers = value; break;
      case 'DRAFT': draft = value; break;
      case 'EXPERIMENT': experiment = value; break;
      case 'VERIFY': verify = value; break;
      default: read = value;
    }
  }
  const query = search ? search.replace(/[^A-Za-z0-9 .+-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const peersReason = peers ? peers.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const reason = draft ? draft.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const experimentText = experiment ? experiment.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const verifyText = verify ? verify.replace(/\s+/g, ' ').trim().slice(0, 2 * 2 * 4096 + 8) : '';
  return {
    note: kept.join('\n').trim(),
    search: query.length >= 3 ? query : null,
    peersReason: peersReason.length >= 5 ? peersReason : null,
    draftReason: reason.length >= 5 ? reason : null,
    experiment: experimentText.length >= 5 ? experimentText : null,
    verify: verifyText.length >= 4 ? verifyText : null,
    read: read ? eprintIdFrom(read) : null,
  };
}

/**
 * The one form a READ request may take: an IACR ePrint id (YYYY/N), given
 * bare, as "ePrint YYYY/N", or as that paper's own eprint.iacr.org URL.
 * Anything else — another domain, a path, a query string — is null: there
 * is no open browsing here, only this one archive's paper pages.
 */
export function eprintIdFrom(text) {
  const t = String(text ?? '').trim();
  const m = /^(?:e?print\s+|https?:\/\/eprint\.iacr\.org\/)?(\d{4})\/(\d{1,6})(?:\.pdf)?\/?$/i.exec(t);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1996 || year > 2100) return null;
  return `${m[1]}/${Number(m[2])}`;
}

/**
 * Parses the strict plain-text answer format of the dedicated drafting call
 * (slots.js's LOOP_DRAFT_SYSTEM): "ATTEMPT: yes|no" plus, only when yes, a
 * fixed set of labeled fields. Deliberately forgiving about surrounding text
 * (a model may add stray words despite the instruction) but strict about
 * what each field actually contains: a label not found is `null`, never a
 * guess. Numeric fields are parsed as plain numbers only; non-numeric text
 * in a numeric field becomes `null`, which validateLoopAttempt (hashsmash.js)
 * then correctly rejects rather than silently coercing to 0.
 *
 * This never decides whether a drafted claim is honest or valid — that is
 * entirely hashsmash.js's validateLoopAttempt, against real, independent
 * session state (the real last search results). This function only turns
 * text into fields.
 */
export function parseDraftAttempt(text) {
  const raw = String(text ?? '');
  const field = (label) => {
    const m = new RegExp(`^\\s*\\**\\s*${label}\\s*:\\s*(.+)$`, 'im').exec(raw);
    return m ? m[1].trim().replace(/\*+$/, '').trim() : null;
  };
  const attemptLine = (field('ATTEMPT') ?? '').toLowerCase();
  if (!attemptLine.startsWith('yes')) return { attempt: false };
  const num = (s) => {
    if (s === null) return null;
    const n = Number(String(s).match(/-?\d+(\.\d+)?/)?.[0] ?? '');
    return Number.isFinite(n) ? n : null;
  };
  return {
    attempt: true,
    timeLog2: num(field('TIME_LOG2')),
    memoryLog2Bytes: num(field('MEMORY_LOG2_BYTES')),
    successProbability: num(field('SUCCESS_PROBABILITY')),
    heuristicId: field('HEURISTIC_ID'),
    citedPaperId: field('CITED_PAPER_ID'),
    experimentId: field('EXPERIMENT_ID'),
    statement: field('STATEMENT'),
    scope: field('SCOPE'),
    extrapolation: field('EXTRAPOLATION'),
    limitations: field('LIMITATIONS'),
  };
}

/**
 * Parses a VERDICT: PASS|FAIL / REASON: ... response from the real
 * adversarial verification call (slots.js LOOP_VERIFY_SYSTEM) -- a second,
 * independent model call whose only job is to try to find something wrong
 * with another model's own drafted attempt, before that attempt is ever
 * allowed to leave the forced draft/supporting state. Same discipline as
 * parseDraftAttempt: a label not found is null, never guessed; anything
 * other than a verdict line starting with "pass" is treated as a fail (the
 * safe default), not a silent pass.
 */
export function parseVerifyVerdict(text) {
  const raw = String(text ?? '');
  const field = (label) => {
    const m = new RegExp(`^\\s*\\**\\s*${label}\\s*:\\s*(.+)$`, 'im').exec(raw);
    return m ? m[1].trim().replace(/\*+$/, '').trim() : null;
  };
  const verdictLine = (field('VERDICT') ?? '').toLowerCase();
  return {
    pass: verdictLine.startsWith('pass'),
    reason: field('REASON'),
  };
}

export function eprintSearchUrl(query) {
  return `${EPRINT_SEARCH_URL}${encodeURIComponent(query).replace(/%20/g, '+')}`;
}

export function notesFile(assignment) {
  const { target } = checkAssignment(assignment);
  return `${NOTES_DIR}/ram-notes-${target}.txt`;
}

/** The block typed for one step: a time/status header, then the step's real feed line(s). */
export function noteBlock({ ts, statusBefore, statusAfter, entries }) {
  const time = /T(\d\d:\d\d:\d\d)/.exec(String(ts ?? ''))?.[1] ?? '';
  const head = `[${time} UTC] ${statusBefore} -> ${statusAfter}`;
  let body = entries.map((e) => asciiText(e.message)).filter(Boolean).join('\n');
  if (body.length > MAX_TYPED_CHARS) body = `${body.slice(0, MAX_TYPED_CHARS - 3)}...`;
  return `\n${head}\n${body}\n`;
}

/** Python run inside the sandbox: real ePrint result ids + titles from a search page. */
const PARSE_EPRINT_PY = String.raw`import re,sys,html
t=sys.stdin.read()
for m in list(re.finditer(r'class="paperlink" href="/(\d{4}/\d+)".*?<strong>(.*?)</strong>',t,re.S))[:5]:
  print(m.group(1)+'\t'+html.unescape(re.sub(r'<[^>]+>','',m.group(2))).strip())`;

export const MOUSEPAD_SETTINGS_COMMAND = 'gsettings set org.xfce.mousepad.preferences.view word-wrap true; '
  + 'gsettings set org.xfce.mousepad.preferences.view use-default-monospace-font false; '
  + "gsettings set org.xfce.mousepad.preferences.view font-name 'DejaVu Sans Mono 12'";

function workareaCommand() {
  return "xprop -root _NET_WORKAREA | sed 's/.*= //' | cut -d, -f1-4 | tr -d ' '";
}

/**
 * Opens (or re-finds) the notes editor window. Returns its X window id.
 * @param {any} sbx
 * @param {{ assignment: any, windowId?: string|null }} p
 */
export async function ensureNotepad(sbx, { assignment, windowId = null }) {
  const run = (cmd, opts) => sbx.commands.run(cmd, opts);
  const file = notesFile(assignment);
  const name = file.split('/').pop();
  if (windowId) {
    const still = await run(`xdotool getwindowname ${windowId} 2>/dev/null || true`);
    if (String(still?.stdout ?? '').includes(name)) return windowId;
  }
  const header = `RAM research notes - ${assignment.track} (${assignment.approach}), model ${assignment.model}\n`
    + 'Each entry below is typed live, as it happens: the RAM\'s real status change and its real feed line.\n';
  await run(`mkdir -p ${NOTES_DIR} && [ -f ${file} ] || printf %s ${shQuote(header)} > ${file}`);
  // Word wrap + a readable font (Mousepad 0.5's own GSettings keys; best effort).
  await run(`${MOUSEPAD_SETTINGS_COMMAND} >/dev/null 2>&1 || true`);
  await run(`mousepad --disable-server ${file}`, { background: true, timeoutMs: 0 });
  const found = await run(`timeout 20 xdotool search --sync --onlyvisible --name ${shQuote(name.replace(/\./g, '\\.'))} 2>/dev/null | head -n 1 || true`, { timeoutMs: 30_000 });
  const id = String(found?.stdout ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('notes editor window did not appear on the sandbox desktop');
  // Fill the work area (below the context banner's reserved strip).
  const wa = String((await run(workareaCommand()))?.stdout ?? '').trim().split(',').map(Number);
  if (wa.length === 4 && wa.every(Number.isFinite)) {
    await run(`xdotool windowmove ${id} ${wa[0]} ${wa[1]} windowsize ${id} ${wa[2]} ${Math.max(200, wa[3] - 30)} >/dev/null 2>&1 || true`);
  }
  return id;
}

/** One shell command that types `text` line by line, pressing Return between lines. */
export function typeLinesCommand(text, typeDelayMs = 18) {
  return String(text).split('\n')
    .map((line, i) => `${i ? 'xdotool key Return' : 'true'}${line ? ` && xdotool type --delay ${Number(typeDelayMs)} -- ${shQuote(line)}` : ''}`)
    .join(' && ');
}

/**
 * Types `block` at the end of the notes file in the editor, saves, and reads
 * the file back. Returns whether the saved file really ends with the block.
 */
export async function typeIntoNotepad(sbx, { assignment, windowId, block, typeDelayMs = 18 }) {
  const run = (cmd, opts) => sbx.commands.run(cmd, opts);
  const file = notesFile(assignment);
  await run(`xdotool windowactivate --sync ${windowId} >/dev/null 2>&1 || true`);
  await run('xdotool key --clearmodifiers ctrl+End');
  // Line by line with real Return keys: a "\n" inside `xdotool type` is dropped by Mousepad
  // (seen on the real template: every entry ran into the previous line).
  await run(typeLinesCommand(block, typeDelayMs), { timeoutMs: 90_000 });
  await run('xdotool key --clearmodifiers ctrl+s && sleep 0.6');
  const back = await run(`tail -c ${block.length + 200} ${file} 2>/dev/null || true`);
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  return { verified: norm(back?.stdout ?? '').endsWith(norm(block)) };
}

/**
 * Points the desktop's Chrome at an ePrint search (typed into the address
 * bar), waits for the page, and reads the real result list. Returns
 * { windowId, url, pageTitle, results: [{ id, title }] }.
 */
export async function browseLiterature(sbx, { query, windowId = null, typeDelayMs = 25 }) {
  const run = (cmd, opts) => sbx.commands.run(cmd, opts);
  const url = eprintSearchUrl(query);
  let id = windowId;
  if (id) {
    const still = await run(`xdotool getwindowname ${id} 2>/dev/null || echo GONE`);
    if (String(still?.stdout ?? '').trim() === 'GONE') id = null;
  }
  if (!id) {
    await run(`google-chrome --no-first-run --no-default-browser-check --password-store=basic --disable-features=Translate --user-data-dir=${CHROME_PROFILE_DIR} --start-maximized about:blank >/dev/null 2>&1`, { background: true, timeoutMs: 0 });
    const found = await run(`timeout 25 xdotool search --sync --onlyvisible --class google-chrome 2>/dev/null | tail -n 1 || true`, { timeoutMs: 35_000 });
    id = String(found?.stdout ?? '').trim();
    if (!/^\d+$/.test(id)) throw new Error('browser window did not appear on the sandbox desktop');
    await run('sleep 2');
  }
  await run(`xdotool windowactivate --sync ${id} >/dev/null 2>&1 || true`);
  await run('xdotool key --clearmodifiers ctrl+l');
  await run(`xdotool type --delay ${typeDelayMs} -- ${shQuote(url)} && xdotool key Return`, { timeoutMs: 30_000 });
  const title = await run(`for i in $(seq 1 40); do n=$(xdotool getwindowname ${id} 2>/dev/null); case "$n" in *"Search results"*) echo "$n"; exit 0;; esac; sleep 0.5; done; xdotool getwindowname ${id} 2>/dev/null || true`, { timeoutMs: 40_000 });
  const listed = await run(`curl -sS -m 20 ${shQuote(url)} | python3 -c ${shQuote(PARSE_EPRINT_PY)} || true`, { timeoutMs: 40_000 });
  const results = String(listed?.stdout ?? '').split('\n').map((l) => l.split('\t')).filter(([pid, t]) => /^\d{4}\/\d+$/.test(pid ?? '') && t).map(([pid, t]) => ({ id: pid, title: t.slice(0, 200) }));
  return { windowId: id, url, pageTitle: String(title?.stdout ?? '').trim().slice(0, 200), results };
}

/**
 * A second, honest desktop activity for the running-experiment step: a real
 * terminal that looks at the SAME real clone the workbench intro made
 * (`~/hash-smash`, sandbox-task.js), instead of the loop's only visible
 * action being the notes editor and an occasional browser tab. Nothing here
 * is fabricated: every command reads a real file or real git history that
 * is actually in that clone, or says plainly it is not there yet — never a
 * pretend result.
 */
export function researchTerminalTitle(track) {
  return `RAM research terminal - ${track}`;
}

/**
 * Real commands cycled so a viewer watching for a while sees different real
 * material each time, not the same thing on repeat. Absolute paths (under
 * `~/hash-smash`) so they work regardless of the terminal's own cwd.
 */
export function repoInspectSteps(assignment) {
  const { track, editablePath } = checkAssignment(assignment);
  const dir = `${WORKBENCH_REPO_DIR}/${editablePath}`;
  return [
    { label: 'the cloned repo\'s recent commit history', command: `cd ${WORKBENCH_REPO_DIR} && git log --oneline -8` },
    { label: `${track}'s candidate directory`, command: `ls -la ${dir} ${dir}/certificates 2>/dev/null || echo 'candidate directory not in this clone yet'` },
    { label: `${track}'s current claim.json`, command: `cat ${dir}/claim.json 2>/dev/null || echo 'claim.json not in this clone yet'` },
    { label: `${track}'s proof notes`, command: `sed -n '1,60p' ${dir}/proof.md 2>/dev/null || echo 'proof.md not in this clone yet'` },
    { label: `${track}'s task definition`, command: `cat ${WORKBENCH_REPO_DIR}/tracks/${track}/TASK.md 2>/dev/null || echo 'TASK.md not in this clone yet'` },
  ];
}

/** Opens (or re-finds) the research terminal window: a plain reusable shell, found and reused like the notes editor. */
export async function ensureResearchTerminal(sbx, { assignment, windowId = null }) {
  const run = (cmd, opts) => sbx.commands.run(cmd, opts);
  const { track } = checkAssignment(assignment);
  const title = researchTerminalTitle(track);
  if (windowId) {
    const still = await run(`xdotool getwindowname ${windowId} 2>/dev/null || true`);
    if (String(still?.stdout ?? '').trim() === title) return windowId;
  }
  await run(`xfce4-terminal --disable-server --maximize --hide-menubar -T ${shQuote(title)}`, { background: true, timeoutMs: 0 });
  const found = await run(`timeout 20 xdotool search --sync --onlyvisible --name ${shQuote(`^${title}$`)} 2>/dev/null | head -n 1 || true`, { timeoutMs: 30_000 });
  const id = String(found?.stdout ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('research terminal window did not appear on the sandbox desktop');
  const wa = String((await run(workareaCommand()))?.stdout ?? '').trim().split(',').map(Number);
  if (wa.length === 4 && wa.every(Number.isFinite)) {
    await run(`xdotool windowmove ${id} ${wa[0]} ${wa[1]} windowsize ${id} ${wa[2]} ${Math.max(200, wa[3] - 30)} >/dev/null 2>&1 || true`);
  }
  return id;
}

/**
 * Types one of `repoInspectSteps` into the research terminal (so a viewer
 * sees it run live), then independently reads back its real output — same
 * "typed, then verified by reading real state" discipline as typeIntoNotepad
 * and browseLiterature. `index` picks which step; callers rotate it (e.g.
 * once per running-experiment step) so the same command never repeats back
 * to back. Returns { windowId, label, command, output }.
 */
export async function inspectRepoFile(sbx, { assignment, windowId = null, index = 0, typeDelayMs = 20 }) {
  const run = (cmd, opts) => sbx.commands.run(cmd, opts);
  const steps = repoInspectSteps(assignment);
  const step = steps[((index % steps.length) + steps.length) % steps.length];
  const id = await ensureResearchTerminal(sbx, { assignment, windowId });
  await run(`xdotool windowactivate --sync ${id} >/dev/null 2>&1 || true`);
  await run(`xdotool type --delay ${typeDelayMs} -- ${shQuote(step.command)} && xdotool key Return`, { timeoutMs: 60_000 });
  await run('sleep 1');
  const out = await run(step.command, { timeoutMs: 20_000 });
  const output = asciiText(String(out?.stdout ?? out?.stderr ?? '')).slice(0, 400);
  return { windowId: id, label: step.label, command: step.command, output };
}

/**
 * A third honest desktop activity, parallel to `browseLiterature` (ePrint)
 * but for real OTHER COMPETITORS' submissions: open, unmerged pull requests
 * on the real, public, official HashSmash repository
 * (github.com/Layr-Labs/hash-smash). An open PR is a real competitor's own
 * self-reported "Validate submission <uuid>" entry — their claimed score and
 * notes are THEIR claim, not a verified result, and an open/unmerged PR may
 * still be rejected or wrong. This function never says otherwise: it only
 * surfaces exactly what the real GitHub API returned.
 *
 * Unauthenticated, read-only, public: `pulls?state=open` needs no token.
 * Matching is on the PR's own title+body text actually containing this
 * RAM's track id (e.g. "blake3-r1-exploratory") — the same real string a
 * submitter would write when claiming a track — never a guess at which PR
 * belongs to which track.
 */
export function peerSubmissionsUrl() {
  return `https://api.github.com/repos/${HASHSMASH_GITHUB_REPO}/pulls?state=open&per_page=100&sort=created&direction=desc`;
}

/**
 * Python run inside the sandbox: reads the real GitHub PR list JSON from
 * stdin, keeps only PRs whose own title or body text contains `track`
 * (argv[1], case-insensitive), and prints at most MAX_PEER_RESULTS of them
 * as one JSON array on stdout. Every field comes straight from the real API
 * response; nothing here invents or estimates a value. "claimed score" is
 * read out of the PR's own title/body with a plain regex because that is
 * literally how a submitter states it (self-reported, never recomputed or
 * checked here).
 *
 * Known, real limitation (checked against the live repo on 2026-10-06, e.g.
 * real PR #257): a submitter's free-text note sometimes discusses several
 * tracks in passing (e.g. explaining which ones it did NOT pick), so a text
 * match on `track` means "this PR's text mentions the track", not "this PR
 * is necessarily that track's own submission". This is the same shape of
 * imprecision as any text search (an ePrint title match isn't "this paper
 * is relevant" either) and is disclosed to the model the same honest way in
 * slots.js's feed/grounding text, rather than silently over-trusted.
 */
export const PARSE_PEERS_PY = String.raw`import json,re,sys
track=(sys.argv[1] if len(sys.argv)>1 else '').lower()
try:
  prs=json.load(sys.stdin)
except Exception:
  prs=[]
if not isinstance(prs,list):
  prs=[]
out=[]
for pr in prs:
  if not isinstance(pr,dict) or not track:
    continue
  title=str(pr.get('title') or '')
  body=str(pr.get('body') or '')
  combined=title+' '+body
  if track not in combined.lower():
    continue
  # Checked against the real repo (2026-10-06): a submitter's claimed score is
  # as likely to be stated in the PR's own title ("(claimed score: 1.5)") as
  # in its body, so both are searched; searching body alone silently missed it.
  m=re.search(r'claimed\s+score[:\s]+([0-9][0-9.]*)',combined,re.I)
  out.append({
    'number': pr.get('number'),
    'login': ((pr.get('user') or {}).get('login')),
    'title': title.strip()[:200],
    'claimedScore': m.group(1) if m else None,
    'note': re.sub(r'\s+',' ',body).strip()[:400],
    'url': pr.get('html_url'),
  })
  if len(out)>=${MAX_PEER_RESULTS}:
    break
print(json.dumps(out))`;

/**
 * Turns PARSE_PEERS_PY's stdout into a clean array, never throwing: a
 * missing/garbled/empty result (rate-limited, offline, API shape changed)
 * becomes `[]` — "no matching PRs found" honestly, not a fabricated list.
 */
export function parsePeerSubmissions(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout ?? '').trim() || '[]'); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((r) => r && typeof r === 'object' && Number.isInteger(r.number) && typeof r.title === 'string')
    .map((r) => ({
      number: r.number,
      login: typeof r.login === 'string' ? r.login : null,
      title: r.title,
      claimedScore: typeof r.claimedScore === 'string' ? r.claimedScore : null,
      note: typeof r.note === 'string' ? r.note : '',
      url: typeof r.url === 'string' ? r.url : null,
    }));
}

/** The one real shell command both typed live and independently re-run for its real output (same discipline as inspectRepoFile). */
export function peerSubmissionsCommand(track) {
  return `curl -sS -m 20 ${shQuote(peerSubmissionsUrl())} -H 'Accept: application/vnd.github+json' -H 'User-Agent: ramherd-research-loop' `
    + `| python3 -c ${shQuote(PARSE_PEERS_PY)} ${shQuote(track)}`;
}

/**
 * Types the real GitHub API lookup into the (shared) research terminal,
 * waits, then independently runs the exact same command to read back its
 * real output — same "typed, then verified" discipline as inspectRepoFile
 * and browseLiterature. Returns { windowId, url, track, results }.
 */
export async function browsePeerSubmissions(sbx, { assignment, windowId = null, typeDelayMs = 20 }) {
  const run = (cmd, opts) => sbx.commands.run(cmd, opts);
  const { track } = checkAssignment(assignment);
  const id = await ensureResearchTerminal(sbx, { assignment, windowId });
  const command = peerSubmissionsCommand(track);
  await run(`xdotool windowactivate --sync ${id} >/dev/null 2>&1 || true`);
  await run(`xdotool type --delay ${typeDelayMs} -- ${shQuote(command)} && xdotool key Return`, { timeoutMs: 60_000 });
  await run('sleep 1');
  const out = await run(command, { timeoutMs: 40_000 });
  return { windowId: id, url: peerSubmissionsUrl(), track, results: parsePeerSubmissions(out?.stdout) };
}

/**
 * Real full-page literature reading (2026-10-07; fixes the long-standing,
 * repeatedly flagged gap that the loop's ePrint access was title-only).
 *
 * Domain discipline, same as everything else here: the only URL this ever
 * fetches is `https://eprint.iacr.org/<YYYY>/<N>`, built from an id that
 * passed eprintIdFrom — never a model-supplied URL, never another site.
 * The page is fetched with the sandbox's own curl (the sandbox reaches
 * eprint.iacr.org, checked 2026-10-05) and parsed HERE, in Node, so the
 * parser is tested against a real recorded ePrint page. What comes back is
 * exactly what the paper's own page says: title, authors, abstract,
 * keywords, category, publication info, PDF link. The PDF body is NOT read
 * (no PDF text extraction is attempted; abstract-level text is what is
 * reported, and every downstream message says so).
 */
export const EPRINT_PAPER_BASE = 'https://eprint.iacr.org/';
/** Longest page body read back from the sandbox (a real ePrint paper page is ~17 KB). */
export const MAX_PAPER_PAGE_BYTES = 262_144;
/** Longest abstract kept per paper (real abstracts run ~1-2.5 KB). */
export const MAX_ABSTRACT_CHARS = 4000;

export function eprintPaperUrl(id) {
  const clean = eprintIdFrom(id);
  if (!clean) throw new RangeError(`not an IACR ePrint paper id: ${String(id).slice(0, 40)}`);
  return `${EPRINT_PAPER_BASE}${clean}`;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * Parses a real IACR ePrint paper page (the archive's own HTML, as fetched)
 * into its real fields. Prefers the page's own `citation_*` meta tags and
 * the visible "Abstract" block; a field the page does not have is null/[],
 * never a guess. A page with no title at all (e.g. the archive's 404 page,
 * whose <title> is empty) is reported as not found.
 */
export function parseEprintPaperPage(html, id) {
  const page = String(html ?? '');
  const metas = (name) => [...page.matchAll(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'gi'))].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
  const title = metas('citation_title')[0]
    || stripTags(/<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(page)?.[1] ?? '')
    || null;
  if (!title) return { found: false, id, url: `${EPRINT_PAPER_BASE}${id}` };
  const authors = metas('citation_author');
  const visibleAbstract = /<h5[^>]*>\s*Abstract\s*<\/h5>\s*<p[^>]*>([\s\S]*?)<\/p>/i.exec(page)?.[1];
  const ogAbstract = /<meta\s+property="og:description"\s+content="([^"]*)"/i.exec(page)?.[1];
  let abstract = visibleAbstract ? stripTags(visibleAbstract) : ogAbstract ? decodeEntities(ogAbstract).replace(/\s+/g, ' ').trim() : '';
  if (abstract.length > MAX_ABSTRACT_CHARS) abstract = `${abstract.slice(0, MAX_ABSTRACT_CHARS - 3)}...`;
  const keywordsBlock = /<dd\s+class="keywords">([\s\S]*?)<\/dd>/i.exec(page)?.[1] ?? '';
  const keywords = [...keywordsBlock.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => stripTags(m[1])).filter(Boolean);
  const dd = (label) => {
    const m = new RegExp(`<dt>\\s*${label}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`, 'i').exec(page);
    return m ? stripTags(m[1]) || null : null;
  };
  return {
    found: true,
    id,
    url: `${EPRINT_PAPER_BASE}${id}`,
    title: decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 300),
    authors: authors.slice(0, 20),
    abstract,
    keywords: keywords.slice(0, 12),
    category: dd('Category'),
    publicationInfo: dd('Publication info'),
    pdfUrl: metas('citation_pdf_url')[0] ?? null,
    bodyRead: false,
  };
}

/** The one real shell command that fetches a paper page inside the sandbox (fixed domain, id already validated). */
export function paperPageCommand(id) {
  return `curl -sS -m 20 -A 'ramherd-research-loop' ${shQuote(eprintPaperUrl(id))} | head -c ${MAX_PAPER_PAGE_BYTES}`;
}

/**
 * Points the desktop's Chrome at the paper's own ePrint page (typed into the
 * address bar, so a viewer sees which paper is being read), then fetches the
 * same page with the sandbox's curl and parses it here. Returns
 * { windowId, url, paper } where `paper` is parseEprintPaperPage's real
 * output (`found: false` if the archive has no such paper).
 */
export async function readPaper(sbx, { id, windowId = null, typeDelayMs = 25 }) {
  const run = (cmd, opts) => sbx.commands.run(cmd, opts);
  const clean = eprintIdFrom(id);
  if (!clean) throw new RangeError(`not an IACR ePrint paper id: ${String(id).slice(0, 40)}`);
  const url = eprintPaperUrl(clean);
  let wid = windowId;
  if (wid) {
    const still = await run(`xdotool getwindowname ${wid} 2>/dev/null || echo GONE`);
    if (String(still?.stdout ?? '').trim() === 'GONE') wid = null;
  }
  if (!wid) {
    await run(`google-chrome --no-first-run --no-default-browser-check --password-store=basic --disable-features=Translate --user-data-dir=${CHROME_PROFILE_DIR} --start-maximized about:blank >/dev/null 2>&1`, { background: true, timeoutMs: 0 });
    const found = await run(`timeout 25 xdotool search --sync --onlyvisible --class google-chrome 2>/dev/null | tail -n 1 || true`, { timeoutMs: 35_000 });
    wid = String(found?.stdout ?? '').trim();
    if (!/^\d+$/.test(wid)) throw new Error('browser window did not appear on the sandbox desktop');
    await run('sleep 2');
  }
  await run(`xdotool windowactivate --sync ${wid} >/dev/null 2>&1 || true`);
  await run('xdotool key --clearmodifiers ctrl+l');
  await run(`xdotool type --delay ${typeDelayMs} -- ${shQuote(url)} && xdotool key Return`, { timeoutMs: 30_000 });
  const fetched = await run(`${paperPageCommand(clean)} || true`, { timeoutMs: 40_000 });
  return { windowId: wid, url, paper: parseEprintPaperPage(fetched?.stdout ?? '', clean) };
}

/** What store.js hands to createSlotManager as `sandboxActivity`. */
export const desktopActivity = Object.freeze({
  ensureNotepad, typeIntoNotepad, browseLiterature, ensureResearchTerminal, inspectRepoFile, browsePeerSubmissions, readPaper,
});
