// Persistence for the human-moderated idea queue (server/lib/moderation.js's
// pending/approved/rejected Maps, written through server/lib/persist.js).
//
// Three things this file proves:
//   1. Records written by one queue instance are read back correctly by a
//      fresh instance pointed at the same file ("restart").
//   2. A missing or corrupt file never throws; the queue just starts empty.
//   3. reattachApproved replays every approved idea's real attachment onto
//      whatever slots exist NOW -- the real fix for the real bug (an
//      approved idea silently losing its attachment on every restart,
//      confirmed by three consecutive research-guidance reviews).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIdeaQueue } from '../server/lib/moderation.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'ramherd-idea-persist-test-'));
}

test('a submitted idea survives a "restart": a fresh queue pointed at the same file sees it', () => {
  const dir = tmpDir();
  const path = join(dir, 'ideas.json');
  try {
    const first = createIdeaQueue({ persistPath: path });
    const { id } = first.submit('a real, specific research suggestion for sha3-256-r5');
    assert.equal(first.listPending().length, 1);

    const second = createIdeaQueue({ persistPath: path });
    assert.equal(second.listPending().length, 1);
    assert.equal(second.listPending()[0].id, id);
    assert.equal(second.listPending()[0].text, 'a real, specific research suggestion for sha3-256-r5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an approved idea\'s real record (including its targetSlotIds) survives a "restart" -- the pending/approved/rejected transition is persisted too, not just the original submission', () => {
  const dir = tmpDir();
  const path = join(dir, 'ideas.json');
  try {
    const first = createIdeaQueue({ persistPath: path });
    const { id } = first.submit('a genuinely good, independently-verified finding');
    first.approve(id, { targetSlotIds: ['slot-6', 'slot-12'] });
    assert.equal(first.listApproved().length, 1);
    assert.equal(first.listPending().length, 0);

    const second = createIdeaQueue({ persistPath: path });
    assert.equal(second.listPending().length, 0, 'the approval, not just the original submission, survived');
    assert.equal(second.listApproved().length, 1);
    assert.deepEqual(second.listApproved()[0].targetSlotIds, ['slot-6', 'slot-12']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected idea and the seq counter both survive a "restart" -- the next id never collides with one already used', () => {
  const dir = tmpDir();
  const path = join(dir, 'ideas.json');
  try {
    const first = createIdeaQueue({ persistPath: path });
    const a = first.submit('idea A');
    first.reject(a.id, 'out of scope');
    const b = first.submit('idea B');

    const second = createIdeaQueue({ persistPath: path });
    assert.equal(second.listRejected().length, 1);
    assert.equal(second.listRejected()[0].id, a.id);
    const c = second.submit('idea C');
    assert.notEqual(c.id, a.id);
    assert.notEqual(c.id, b.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing persistence file is an honest empty queue, never a throw', () => {
  const dir = tmpDir();
  try {
    const queue = createIdeaQueue({ persistPath: join(dir, 'does-not-exist.json') });
    assert.deepEqual(queue.listPending(), []);
    assert.deepEqual(queue.listApproved(), []);
    assert.deepEqual(queue.listRejected(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt/foreign persistence file is logged and the queue starts empty, never throws', () => {
  const dir = tmpDir();
  const path = join(dir, 'ideas.json');
  writeFileSync(path, 'not json at all {{{');
  const logs = [];
  try {
    const queue = createIdeaQueue({ persistPath: path, log: (l) => logs.push(l) });
    assert.deepEqual(queue.listPending(), []);
    assert.ok(logs.some((l) => l.includes('could not be read as JSON')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a persistPath, behaviour is exactly today\'s in-memory-only default', () => {
  const queue = createIdeaQueue(); // no persistPath at all -- every existing test/caller
  const { id } = queue.submit('idea with no persistence configured');
  const record = queue.approve(id, { targetSlotIds: ['slot-0'] });
  assert.equal(record.status, 'approved');
  assert.equal(queue.listApproved().length, 1);
  // A fresh instance with its own default (still no persistPath) starts genuinely empty --
  // there is nothing on disk for it to have rehydrated from.
  const fresh = createIdeaQueue();
  assert.deepEqual(fresh.listApproved(), []);
});

test('reattachApproved: replays every approved idea\'s real attachment onto the slots that exist now -- the actual fix for the real bug', () => {
  const dir = tmpDir();
  const path = join(dir, 'ideas.json');
  try {
    const first = createIdeaQueue({ persistPath: path });
    const { id } = first.submit('real, verified finding for sha3-256-r6');
    const attachedFirstTime = [];
    first.approve(id, { targetSlotIds: ['slot-7', 'slot-13'], attach: (slotId, idea) => attachedFirstTime.push({ slotId, idea }) });
    assert.equal(attachedFirstTime.length, 2, 'attached immediately on approval, same as before this mechanism existed');

    // "Restart": a fresh queue, and a fresh (empty) record of what got reattached.
    const second = createIdeaQueue({ persistPath: path });
    const reattached = [];
    const result = second.reattachApproved((slotId, idea) => reattached.push({ slotId, idea }));
    assert.equal(result.reattached, 2);
    assert.equal(result.skipped, 0);
    assert.deepEqual(reattached.map((r) => r.slotId).sort(), ['slot-13', 'slot-7']);
    assert.equal(reattached[0].idea.text, 'real, verified finding for sha3-256-r6');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reattachApproved: a target slot that no longer exists is skipped and logged, never thrown -- one missing slot must not stop the rest', () => {
  const dir = tmpDir();
  const path = join(dir, 'ideas.json');
  try {
    const first = createIdeaQueue({ persistPath: path });
    const { id } = first.submit('finding for a slot that will be gone after restart');
    first.approve(id, { targetSlotIds: ['slot-7', 'slot-99-retired'], attach: () => {} });

    const logs = [];
    const second = createIdeaQueue({ persistPath: path, log: (l) => logs.push(l) });
    const attachedOk = [];
    const attach = (slotId) => {
      if (slotId === 'slot-99-retired') throw new RangeError(`unknown slot id: ${slotId}`);
      attachedOk.push(slotId);
    };
    const result = second.reattachApproved(attach);
    assert.deepEqual(attachedOk, ['slot-7']);
    assert.ok(logs.some((l) => l.includes('slot-99-retired') && l.includes('continuing')));
    assert.equal(result.reattached, 1);
    assert.equal(result.skipped, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reattachApproved with no attach function at all (or not a function) is a safe no-op, never throws', () => {
  const dir = tmpDir();
  const path = join(dir, 'ideas.json');
  try {
    const first = createIdeaQueue({ persistPath: path });
    const { id } = first.submit('an idea');
    first.approve(id, { targetSlotIds: ['slot-0'], attach: () => {} });
    const second = createIdeaQueue({ persistPath: path });
    assert.deepEqual(second.reattachApproved(undefined), { reattached: 0, skipped: 0 });
    assert.deepEqual(second.reattachApproved(null), { reattached: 0, skipped: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
