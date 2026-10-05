// Fee ledger: tracks a running "fees collected" total.
//
// This module never signs, claims, or moves funds. It only *reads* a number
// from a `FeeSource` and keeps a timestamped history of what the total was
// each time it changed. That's a hard line, not a style choice: every
// source implementation below exposes a read method and nothing else that
// could move money, and the mock source's mutators only ever move its own
// in-memory counter.
//
// Swapping in a real on-chain fee reader later means writing one more
// `FeeSource` (anything with an async `fetchTotal()`) and passing it to
// `createFeeLedger` instead of the mock — the ledger, the budget allocator,
// and the HTTP layer never change.

/**
 * @typedef {object} FeeSource
 * @property {'mock'|'onchain'|string} kind
 * @property {() => Promise<number>} fetchTotal - current total fees collected, in USD.
 */

/**
 * A fee source driven entirely by admin/test calls, simulating what a real
 * pump.fun (or similar) creator-fee feed would eventually report. Holds its
 * own history so an admin view can show how the mock total got where it is.
 *
 * @param {{ initialUsd?: number }} [opts]
 * @returns {FeeSource & {
 *   add: (amountUsd: number, note?: string) => number,
 *   set: (amountUsd: number, note?: string) => number,
 *   getHistory: () => Array<{ ts: string, totalUsd: number, deltaUsd: number, note: string }>,
 * }}
 */
export function createMockFeeSource({ initialUsd = 0 } = {}) {
  if (!Number.isFinite(initialUsd) || initialUsd < 0) {
    throw new RangeError('initialUsd must be a non-negative finite number');
  }
  let total = initialUsd;
  const history = [];

  function record(deltaUsd, note) {
    history.push({ ts: new Date().toISOString(), totalUsd: total, deltaUsd, note: note || '' });
    // Bounded history: this is a mock/test aid, not a ledger of record.
    if (history.length > 1000) history.shift();
  }

  return {
    kind: 'mock',
    async fetchTotal() {
      return total;
    },
    /** Simulates fees arriving (e.g. a pump.fun fee-claim poll reporting new fees). */
    add(amountUsd, note) {
      if (!Number.isFinite(amountUsd)) throw new RangeError('amountUsd must be a finite number');
      total = Math.max(0, total + amountUsd);
      record(amountUsd, note);
      return total;
    },
    /** Sets the total outright (e.g. test setup, or correcting the simulation). */
    set(amountUsd, note) {
      if (!Number.isFinite(amountUsd) || amountUsd < 0) {
        throw new RangeError('amountUsd must be a non-negative finite number');
      }
      const delta = amountUsd - total;
      total = amountUsd;
      record(delta, note);
      return total;
    },
    getHistory() {
      return history.slice();
    },
  };
}

/**
 * Wraps a `FeeSource` with a cached, timestamped snapshot. The ledger itself
 * has no admin mutators — those live on the source (mock-only today) so a
 * real read-only on-chain source can never be asked to "add" or "set" fees
 * by anything that only has a `FeeLedger` handle.
 *
 * @param {{ source: FeeSource }} opts
 */
export function createFeeLedger({ source }) {
  if (!source || typeof source.fetchTotal !== 'function') {
    throw new TypeError('createFeeLedger requires a source with fetchTotal()');
  }
  let snapshot = { totalUsd: 0, updatedAt: null, sourceKind: source.kind };

  async function refresh() {
    const totalUsd = await source.fetchTotal();
    snapshot = { totalUsd, updatedAt: new Date().toISOString(), sourceKind: source.kind };
    return getSnapshot();
  }

  function getSnapshot() {
    return { ...snapshot };
  }

  return {
    refresh,
    getSnapshot,
    sourceKind: source.kind,
  };
}
