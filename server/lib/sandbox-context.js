// The always-visible "what am I looking at" banner on a RAM's desktop sandbox.
//
// Someone who opens a RAM's live stream mid-session sees a desktop and maybe a
// terminal. This module puts a two-line strip across the top of that desktop,
// for the whole life of the sandbox, saying which RAM it is and what it is
// doing:
//
//   [LIVE RAM] RAM slot-0 · SHA-256, 31 rounds · literature-replication approach · model anthropic/claude-opus-5.5
//   Status: thinking · latest (21:15:02 UTC): Desktop terminal: `git clone ...` (exit 0)
//
// Line 1 comes from the slot's real assignment (targets.js shape). Line 2 is
// the slot's real status plus its real LATEST FEED ENTRY, verbatim (trimmed to
// fit): the same append-only feed the site shows. Nothing is invented: when the
// feed has nothing new, the line keeps showing the last real entry and its time.
//
// How it is drawn (checked against the real E2B `desktop` template, 2026-10-05):
// the template has NO ImageMagick, PIL, tkinter, feh, wmctrl, conky or xterm,
// but it does have python3 3.10 with PyGObject + GTK 3 (`gi`), xprop, xdotool
// and xfwm4/xfdesktop. So the banner is a tiny GTK window:
//   - type hint DOCK, undecorated, keep-above, sticky, never takes focus;
//   - placed at the top of the current work area (read from _NET_WORKAREA, so
//     just under the Xfce top panel), full screen width, BANNER_HEIGHT tall;
//   - it sets _NET_WM_STRUT / _NET_WM_STRUT_PARTIAL with xprop, so xfwm4 shrinks
//     the work area: a maximized window (the workbench terminal is launched
//     --maximize) is laid out BELOW the banner instead of covering it, whether
//     the terminal opened before or after the banner (both orders checked on a
//     real sandbox with screenshots);
//   - every second it re-reads CONTEXT_FILE (a small JSON {header, now}) and
//     updates its two labels if the file changed. The host rewrites that file
//     (atomically: write .tmp, mv) whenever the slot's feed gets a new entry.
// A wallpaper was the other candidate, but the maximized workbench terminal
// covers the wallpaper entirely, and nothing on the template can render text
// to an image except GTK itself, so a strut-reserving dock window it is.
//
// Everything goes through the sandbox's authenticated command channel
// (sbx.commands.run; the SDK sets DISPLAY=:0). Text reaches the sandbox only
// base64-encoded inside single quotes, so no feed text is ever parsed by a
// shell. No secret goes in: only the assignment and public feed lines.

export const CONTEXT_DIR = '/tmp/ramctx';
export const CONTEXT_FILE = `${CONTEXT_DIR}/context.json`;
export const BANNER_SCRIPT = `${CONTEXT_DIR}/banner.py`;
export const BANNER_PID_FILE = `${CONTEXT_DIR}/banner.pid`;
export const BANNER_LOG = `${CONTEXT_DIR}/banner.log`;
export const BANNER_TITLE = 'RAM context';
export const BANNER_HEIGHT = 64;
/** Longest feed message shown (GTK also ellipsizes to the screen width). */
export const MAX_NOW_CHARS = 280;

/** Friendlier names for feed entry types; unknown types are shown as-is. */
const TYPE_LABELS = {
  activated: 'Activated',
  thinking: 'Thinking',
  'running-experiment': 'Experiment',
  validated: 'Validated',
  submitted: 'Drafted',
  failed: 'Failed',
  'cycle-reset': 'New cycle',
  'suggestion-attached': 'Viewer suggestion',
  'sandbox-starting': 'Desktop',
  'sandbox-started': 'Desktop',
  'sandbox-task-started': 'Workbench',
  'sandbox-task-step': 'Workbench',
  'sandbox-task-done': 'Workbench',
  'sandbox-task-error': 'Workbench',
  'sandbox-context-started': 'Desktop',
};

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Line 1: who this RAM is, from its real assignment.
 * @param {{ slotId: string, ramId?: string|null, assignment: { hashFunction: string, rounds: number, track: string, approach: string, model: string } }} p
 */
export function contextHeader({ slotId, ramId = null, assignment }) {
  const a = assignment ?? {};
  const who = ramId ? `RAM ${ramId} (${slotId})` : `RAM ${slotId}`;
  return oneLine(`${who} · ${a.hashFunction}, ${a.rounds} ${a.rounds === 1 ? 'round' : 'rounds'} · ${a.approach} approach · model ${a.model}`);
}

/**
 * Line 2: the slot's real status and its latest real feed entry.
 * @param {{ status: string, feed: Array<{ ts: string, type: string, message: string }> }} p
 */
export function contextNowLine({ status, feed }) {
  const last = Array.isArray(feed) && feed.length ? feed[feed.length - 1] : null;
  if (!last) return `Status: ${status} · no activity yet`;
  const time = /^\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d)/.exec(String(last.ts ?? ''))?.[1];
  const label = TYPE_LABELS[last.type] ?? last.type;
  return `Status: ${status} · latest${time ? ` (${time} UTC)` : ''}: ${label}: ${clip(oneLine(last.message), MAX_NOW_CHARS)}`;
}

/** The JSON the banner reads. Built from a slot's real state only. */
export function contextPayload({ slotId, ramId = null, assignment, status, feed }) {
  return { header: contextHeader({ slotId, ramId, assignment }), now: contextNowLine({ status, feed }) };
}

function b64(text) {
  return Buffer.from(String(text), 'utf8').toString('base64');
}

/** Writes `content` to `path` atomically; content travels base64 inside single quotes. */
export function writeFileCommand(path, content) {
  return `mkdir -p ${CONTEXT_DIR} && printf %s '${b64(content)}' | base64 -d > ${path}.tmp && mv -f ${path}.tmp ${path}`;
}

/** The command that (re)writes the banner's context file. */
export function writeContextCommand(payload) {
  return writeFileCommand(CONTEXT_FILE, JSON.stringify({ header: String(payload.header ?? ''), now: String(payload.now ?? '') }));
}

/** Python/GTK3 source of the banner window (runs inside the sandbox). */
export function bannerScript() {
  return `# RAM context banner (server/lib/sandbox-context.js). Shows ${CONTEXT_FILE}.
import json, os, subprocess, sys
import gi
gi.require_version('Gtk', '3.0'); gi.require_version('Gdk', '3.0'); gi.require_version('GdkX11', '3.0')
from gi.repository import Gtk, Gdk, GLib, GdkX11, Pango
PATH = sys.argv[1]; HEIGHT = int(sys.argv[2])

def workarea_top():
    try:
        out = subprocess.run(['xprop', '-root', '_NET_WORKAREA'], capture_output=True, text=True, timeout=5).stdout
        return int(out.split('=')[1].split(',')[1])
    except Exception:
        return 0

top = workarea_top()
screen = Gdk.Screen.get_default()
geo = Gdk.Display.get_default().get_monitor(0).get_geometry()
width = geo.width
css = Gtk.CssProvider()
css.load_from_data(b"""
window { background: #0d1117; border-bottom: 3px solid #f0b429; }
#head { color: #ffffff; font: bold 17px 'DejaVu Sans'; }
#now { color: #c9d1d9; font: 14px 'DejaVu Sans'; }
#tag { color: #0d1117; background: #f0b429; font: bold 12px 'DejaVu Sans Mono'; padding: 2px 8px; border-radius: 3px; }
""")
Gtk.StyleContext.add_provider_for_screen(screen, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
w = Gtk.Window(title='${BANNER_TITLE}')
w.set_type_hint(Gdk.WindowTypeHint.DOCK); w.set_decorated(False); w.set_keep_above(True)
w.set_skip_taskbar_hint(True); w.set_skip_pager_hint(True); w.set_accept_focus(False); w.stick()
w.set_default_size(width, HEIGHT); w.set_size_request(width, HEIGHT); w.move(0, top)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
box.set_margin_start(14); box.set_margin_end(14); box.set_margin_top(8)
row = Gtk.Box(spacing=10)
tag = Gtk.Label(label='LIVE RAM'); tag.set_name('tag')
head = Gtk.Label(xalign=0); head.set_name('head'); head.set_ellipsize(Pango.EllipsizeMode.END)
row.pack_start(tag, False, False, 0); row.pack_start(head, True, True, 0)
now = Gtk.Label(xalign=0); now.set_name('now'); now.set_ellipsize(Pango.EllipsizeMode.END)
box.pack_start(row, False, False, 0); box.pack_start(now, False, False, 0); w.add(box)
last = [None]

def refresh():
    try:
        m = os.stat(PATH).st_mtime_ns
        if m != last[0]:
            with open(PATH, encoding='utf-8') as f:
                d = json.load(f)
            head.set_text(str(d.get('header', ''))); now.set_text(str(d.get('now', '')))
            last[0] = m
    except Exception:
        pass
    return True

def reserve(*_):
    # Reserve the strip so maximized windows are laid out below it, not over it.
    xid = str(w.get_window().get_xid()); b = top + HEIGHT
    subprocess.run(['xprop', '-id', xid, '-f', '_NET_WM_STRUT', '32c', '-set', '_NET_WM_STRUT', f'0,0,{b},0'])
    subprocess.run(['xprop', '-id', xid, '-f', '_NET_WM_STRUT_PARTIAL', '32c', '-set', '_NET_WM_STRUT_PARTIAL', f'0,0,{b},0,0,0,0,0,0,{width - 1},0,0'])
    return False

w.connect('map-event', reserve)
refresh(); GLib.timeout_add(1000, refresh)
w.show_all(); Gtk.main()
`;
}

/** Stops a previous banner (by its pid file, never by pattern: pkill -f would match its own shell). */
export const STOP_BANNER_COMMAND = `if [ -f ${BANNER_PID_FILE} ]; then kill $(cat ${BANNER_PID_FILE}) 2>/dev/null; rm -f ${BANNER_PID_FILE}; sleep 0.5; fi; true`;

/** Launches the banner; it records its own pid. Run with { background: true }. */
export function launchBannerCommand(height = BANNER_HEIGHT) {
  return `echo $$ > ${BANNER_PID_FILE} && exec python3 ${BANNER_SCRIPT} ${CONTEXT_FILE} ${Number(height)} > ${BANNER_LOG} 2>&1`;
}

export const FIND_BANNER_COMMAND = `timeout 15 xdotool search --sync --onlyvisible --name '^${BANNER_TITLE}$' 2>/dev/null | head -n 1 || true`;

/**
 * Puts the banner on the sandbox desktop showing `payload`, and checks that its
 * window really appeared. Throws if it did not.
 *
 * @param {any} sbx - a started @e2b/desktop Sandbox
 * @param {{ header: string, now: string }} payload
 * @returns {Promise<{ windowId: string }>}
 */
export async function startContextBanner(sbx, payload) {
  const run = (cmd, opts) => sbx.commands.run(cmd, opts);
  await run(STOP_BANNER_COMMAND);
  await run(writeFileCommand(BANNER_SCRIPT, bannerScript()));
  await run(writeContextCommand(payload));
  await run(launchBannerCommand(), { background: true, timeoutMs: 0 });
  const found = await run(FIND_BANNER_COMMAND, { timeoutMs: 25_000 });
  const windowId = String(found?.stdout ?? '').trim();
  if (!/^\d+$/.test(windowId)) {
    const log = await run(`tail -n 5 ${BANNER_LOG} 2>/dev/null || true`).catch(() => null);
    const why = oneLine(log?.stdout ?? '');
    throw new Error(`context banner window did not appear${why ? `: ${clip(why, 200)}` : ''}`);
  }
  return { windowId };
}

/** Rewrites the banner's context file; the banner picks it up within a second. */
export async function updateContextBanner(sbx, payload) {
  await sbx.commands.run(writeContextCommand(payload));
}

/** What store.js hands to createSlotManager as `sandboxContext`. */
export const contextBanner = Object.freeze({ start: startContextBanner, update: updateContextBanner });
