import test from 'node:test';
import assert from 'node:assert/strict';
import { createCostLedger } from '../server/lib/cost.js';

function usage({ promptTokens = 10, completionTokens = 5, totalTokens = 15, costUsd = 0.002 } = {}) {
  return { promptTokens, completionTokens, totalTokens, costUsd };
}

test('record requires a slotId and usage', () => {
  const ledger = createCostLedger();
  assert.throws(() => ledger.record({ usage: usage() }), TypeError);
  assert.throws(() => ledger.record({ slotId: 'slot-0' }), TypeError);
});

test('totals() sums tokens and cost across every recorded call', () => {
  const ledger = createCostLedger();
  ledger.record({ slotId: 'slot-0', model: 'anthropic/claude-opus-5.5', usage: usage({ costUsd: 0.01 }) });
  ledger.record({ slotId: 'slot-1', model: 'anthropic/claude-fable-5.1', usage: usage({ costUsd: 0.02 }) });
  const totals = ledger.totals();
  assert.equal(totals.calls, 2);
  assert.equal(totals.promptTokens, 20);
  assert.equal(totals.completionTokens, 10);
  assert.equal(totals.totalTokens, 30);
  assert.equal(totals.costUsd, 0.03);
  assert.equal(totals.costUnknownCalls, 0);
});

test('a call with no reported cost (costUsd null) counts as unknown, not zero', () => {
  const ledger = createCostLedger();
  ledger.record({ slotId: 'slot-0', model: 'm', usage: usage({ costUsd: null }) });
  ledger.record({ slotId: 'slot-0', model: 'm', usage: usage({ costUsd: 0.01 }) });
  const totals = ledger.totals();
  assert.equal(totals.costUsd, 0.01); // only the known one is summed
  assert.equal(totals.costUnknownCalls, 1); // but the gap isn't silently hidden as "$0 spent"
  assert.equal(totals.calls, 2);
});

test('forSlot() isolates one slot\'s entries and totals', () => {
  const ledger = createCostLedger();
  ledger.record({ slotId: 'slot-0', model: 'm', usage: usage({ costUsd: 0.01 }) });
  ledger.record({ slotId: 'slot-1', model: 'm', usage: usage({ costUsd: 0.05 }) });
  const only0 = ledger.forSlot('slot-0');
  assert.equal(only0.entries.length, 1);
  assert.equal(only0.totals.costUsd, 0.01);
  assert.equal(ledger.forSlot('slot-9').entries.length, 0);
});

test('forRam() isolates one owned RAM\'s entries, ignoring roster slots with no ramId', () => {
  const ledger = createCostLedger();
  ledger.record({ slotId: 'slot-0', ramId: null, model: 'm', usage: usage({ costUsd: 0.01 }) });
  ledger.record({ slotId: 'slot-1', ramId: 'ram-0001', model: 'm', usage: usage({ costUsd: 0.03 }) });
  const ram = ledger.forRam('ram-0001');
  assert.equal(ram.entries.length, 1);
  assert.equal(ram.totals.costUsd, 0.03);
  assert.equal(ledger.forRam('ram-does-not-exist').entries.length, 0);
});

test('byModel() groups totals per model, including calls with no model as "unknown"', () => {
  const ledger = createCostLedger();
  ledger.record({ slotId: 'slot-0', model: 'anthropic/claude-opus-5.5', usage: usage({ costUsd: 0.01 }) });
  ledger.record({ slotId: 'slot-1', model: 'anthropic/claude-opus-5.5', usage: usage({ costUsd: 0.02 }) });
  ledger.record({ slotId: 'slot-2', model: null, usage: usage({ costUsd: 0.04 }) });
  const byModel = Object.fromEntries(ledger.byModel().map((m) => [m.model, m.totals]));
  assert.equal(byModel['anthropic/claude-opus-5.5'].costUsd, 0.03);
  assert.equal(byModel['anthropic/claude-opus-5.5'].calls, 2);
  assert.equal(byModel.unknown.costUsd, 0.04);
});

test('entries are append-only: list() reflects every record() call in order and nothing mutates past entries', () => {
  const ledger = createCostLedger();
  ledger.record({ slotId: 'slot-0', model: 'm', usage: usage() });
  ledger.record({ slotId: 'slot-0', model: 'm', usage: usage() });
  const list = ledger.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => e.seq), [0, 1]);
  list[0].usage.costUsd = 999; // mutate the returned copy
  assert.notEqual(ledger.list()[0].usage.costUsd, 999); // the ledger's own copy is untouched
});

test('mock-mode usage (all zero, cost null) sums to an honest zero, not a fabricated figure', () => {
  const ledger = createCostLedger();
  ledger.record({ slotId: 'slot-0', model: null, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: null } });
  const totals = ledger.totals();
  assert.equal(totals.totalTokens, 0);
  assert.equal(totals.costUsd, 0);
  assert.equal(totals.costUnknownCalls, 1);
});
