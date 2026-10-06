// Tiny atomic JSON file persistence, zero dependencies beyond node:fs.
//
// Used by server/lib/rams.js to survive a restart without needing SQLite or
// any other dependency: the launchpad's whole RAM registry is a handful of
// records, so one JSON file is the right level of engineering (see rams.js's
// header and fly.toml for why).
//
// Both functions are synchronous on purpose. The data this guards is tiny
// (a few KB to maybe a few hundred KB for thousands of RAM records), so a
// blocking writeFileSync is a few milliseconds, not a stall; and synchronous
// code is far easier to reason about for "never leaves a half-written file
// visible to a reader" than juggling async writes against concurrent reads
// from the same process. Neither function ever throws: a failure is logged
// and the caller keeps running with whatever it already has in memory.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Reads and parses JSON from `path`.
 * Returns `undefined` if the file doesn't exist yet (first boot, or local
 * dev with no data dir) — not an error. Returns `undefined` and logs loudly
 * if the file exists but can't be read or parsed (corrupt/truncated/foreign
 * content) — also not an error the caller should throw on; the caller is
 * expected to start from empty state instead of refusing to boot.
 *
 * @param {string} path
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {any|undefined}
 */
export function readJsonFile(path, { log = () => {} } = {}) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    log(`persist: ${path} exists but could not be read as JSON, starting from empty state: ${err?.message || err}`);
    return undefined;
  }
}

/**
 * Writes `value` as JSON to `path`, atomically: the data is written to a
 * temp file in the SAME directory, then moved into place with a single
 * rename. A rename within one directory on one filesystem is atomic on
 * every platform this runs on (Linux, the real target: a Fly volume is one
 * local filesystem) — a concurrent reader always sees either the previous
 * complete file or the new complete file, never a partial write. The temp
 * file includes the pid so two processes (shouldn't happen for this store,
 * but cheap to make safe) never collide on the same temp name.
 *
 * Never throws: a write failure (disk full, permissions, missing volume) is
 * logged and swallowed, so a persistence problem can never crash the server
 * or fail the mutation that triggered it. The in-memory state the caller
 * already has is unaffected either way.
 *
 * @param {string} path
 * @param {any} value
 * @param {{ log?: (line: string) => void }} [opts]
 */
export function writeJsonFileAtomic(path, value, { log = () => {} } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    log(`persist: failed to write ${path}, continuing with in-memory state only: ${err?.message || err}`);
  }
}
