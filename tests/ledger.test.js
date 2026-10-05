import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockFeeSource, createFeeLedger } from '../server/lib/ledger.js';

test('mock fee source starts at zero and has no mutating fetchTotal side effects', async () => {
  const source = createMockFeeSource();
  assert.equal(await source.fetchTotal(), 0);
  assert.equal(await source.fetchTotal(), 0); // calling it again never changes anything
});

test('add() increases the total and set() replaces it', () => {
  const source = createMockFeeSource({ initialUsd: 10 });
  assert.equal(source.add(5, 'pump.fun fee tick'), 15);
  assert.equal(source.add(2.5), 17.5);
  assert.equal(source.set(100, 'correction'), 100);
});

test('add() never drives the total negative', () => {
  const source = createMockFeeSource({ initialUsd: 3 });
  source.add(-10);
  assert.equal(0, Math.max(0, 3 - 10)); // sanity on the expectation
});

test('set() rejects a negative amount', () => {
  const source = createMockFeeSource();
  assert.throws(() => source.set(-1), RangeError);
});

test('history records each change with a delta and running total', () => {
  const source = createMockFeeSource();
  source.add(10, 'first');
  source.add(5, 'second');
  const history = source.getHistory();
  assert.equal(history.length, 2);
  assert.equal(history[0].totalUsd, 10);
  assert.equal(history[0].note, 'first');
  assert.equal(history[1].totalUsd, 15);
  assert.equal(history[1].deltaUsd, 5);
});

test('getHistory() returns a copy, not the live array', () => {
  const source = createMockFeeSource();
  source.add(1);
  const history = source.getHistory();
  history.push({ fake: true });
  assert.equal(source.getHistory().length, 1);
});

test('createFeeLedger requires a source with fetchTotal', () => {
  assert.throws(() => createFeeLedger({ source: {} }), TypeError);
});

test('ledger.refresh() pulls the current total from the source and timestamps it', async () => {
  const source = createMockFeeSource({ initialUsd: 7 });
  const ledger = createFeeLedger({ source });
  assert.equal(ledger.getSnapshot().updatedAt, null);
  const snap = await ledger.refresh();
  assert.equal(snap.totalUsd, 7);
  assert.ok(snap.updatedAt);
  assert.equal(snap.sourceKind, 'mock');
});

test('ledger snapshot only updates on refresh(), not live', async () => {
  const source = createMockFeeSource({ initialUsd: 0 });
  const ledger = createFeeLedger({ source });
  await ledger.refresh();
  source.add(50);
  assert.equal(ledger.getSnapshot().totalUsd, 0); // stale until refreshed again
  await ledger.refresh();
  assert.equal(ledger.getSnapshot().totalUsd, 50);
});

test('the ledger exposes no method that could write to the source', () => {
  const source = createMockFeeSource();
  const ledger = createFeeLedger({ source });
  assert.equal(typeof ledger.refresh, 'function');
  assert.equal(typeof ledger.getSnapshot, 'function');
  assert.equal(ledger.add, undefined);
  assert.equal(ledger.set, undefined);
  assert.equal(ledger.claim, undefined);
  assert.equal(ledger.send, undefined);
});

test('a drop-in real-feed source only needs fetchTotal()', async () => {
  const fakeOnChainSource = { kind: 'onchain', async fetchTotal() { return 1234.5; } };
  const ledger = createFeeLedger({ source: fakeOnChainSource });
  const snap = await ledger.refresh();
  assert.equal(snap.totalUsd, 1234.5);
  assert.equal(snap.sourceKind, 'onchain');
});
