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
//
// Checked against the real E2B `desktop` template on 2026-10-05 (a probe
// sandbox, `command -v` + /usr/share/applications): Mousepad 0.5.8, gedit and
// gnome-text-editor are installed (leafpad, nano, vim are not); Google Chrome
// 150 is installed (`google-chrome`; the `firefox` binary is not on PATH, only
// a firefox-esr .desktop entry); xfce4-terminal, xdotool, xprop and curl are
// present, and the sandbox reaches eprint.iacr.org (HTTP 200). Mousepad is
// used because it is Xfce's own editor (the desktop is Xfce) and starts fast.
//
// Everything goes through the sandbox's authenticated command channel. Text
// reaches the sandbox only as single-quoted (shQuote) xdotool arguments or
// base64; search queries are reduced to [A-Za-z0-9 .+-] before they are put
// into a URL. No secret is ever typed: only public feed lines and queries.

import { shQuote, checkAssignment, REPO_DIR as WORKBENCH_REPO_DIR } from './sandbox-task.js';

export const NOTES_DIR = '/tmp/ramnotes';
export const CHROME_PROFILE_DIR = '/tmp/ramchrome';
export const EPRINT_SEARCH_URL = 'https://eprint.iacr.org/search?q=';

/** Pause between two advance() steps, seconds. The loop never waits longer than MAX. */
export const DEFAULT_STEP_PAUSE_SEC = 5;
export const MIN_STEP_PAUSE_SEC = 2;
export const MAX_STEP_PAUSE_SEC = 30;
/** A browse happens on at most one in every `browseEvery` thinking steps (and only when the model asked). */
export const DEFAULT_BROWSE_EVERY = 2;
/** Hard cap on real thinking (LLM) calls one sandbox session may make before the loop stops. */
export const DEFAULT_MAX_THINKING_PER_SESSION = 60;
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
 * Splits a model's thinking text into the note and an optional search query
 * (its last "SEARCH: ..." line). The query is reduced to a safe charset.
 */
export function parseThinking(text) {
  const lines = String(text ?? '').split('\n');
  let search = null;
  const kept = [];
  for (const line of lines) {
    const m = /^\s*\**\s*SEARCH\s*:\s*(.+)$/i.exec(line);
    if (m) search = m[1];
    else kept.push(line);
  }
  const query = search ? search.replace(/[^A-Za-z0-9 .+-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return { note: kept.join('\n').trim(), search: query.length >= 3 ? query : null };
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

/** What store.js hands to createSlotManager as `sandboxActivity`. */
export const desktopActivity = Object.freeze({ ensureNotepad, typeIntoNotepad, browseLiterature, ensureResearchTerminal, inspectRepoFile });
