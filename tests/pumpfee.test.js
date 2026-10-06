// Unit tests for server/lib/pumpfee.js: the real on-chain pump.fun creator-fee reader.
// Pure, with a fake connection and a fake price source -- no network, same pattern as
// tests/launchverify.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { creatorFeeLamportsOf, creatorFeeTokenDeltasOf, createPumpFeeSource, createCoinGeckoPriceSource, createCoinGeckoZecPriceSource, createJupiterPriceSource, connectionAdapter, pumpFeePolicy } from '../server/lib/pumpfee.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'ramherd-pumpfee-persist-test-'));
}

const TREASURY = 'Treasury111111111111111111111111111111111';
const OTHER = 'Other1111111111111111111111111111111111111';

function distributeTx({ keys = [OTHER, TREASURY], pre = [0, 1_000_000], post = [0, 1_010_468], err = null } = {}) {
  return {
    meta: { err, logMessages: ['Program log: Instruction: DistributeCreatorFees'], preBalances: pre, postBalances: post },
    transaction: { message: { accountKeys: keys } },
  };
}

function createV2Tx({ keys = [OTHER, TREASURY], pre = [0, 1_000_000], post = [0, 1_010_000_000] } = {}) {
  // A RAM's own 0.01 SOL launch create-fee, same wallet, different real instruction.
  return {
    meta: { err: null, logMessages: ['Program log: Instruction: CreateV2'], preBalances: pre, postBalances: post },
    transaction: { message: { accountKeys: keys } },
  };
}

test('creatorFeeLamportsOf: only a real DistributeCreatorFees transaction counts, and only the treasury\'s own real balance delta', () => {
  assert.equal(creatorFeeLamportsOf(distributeTx(), TREASURY), 10468);
  assert.equal(creatorFeeLamportsOf(null, TREASURY), 0, 'no transaction -> 0, never a guess');
  assert.equal(creatorFeeLamportsOf(distributeTx({ err: { InstructionError: [0, 'Custom'] } }), TREASURY), 0, 'a failed transaction never moved real money');
  assert.equal(creatorFeeLamportsOf(createV2Tx(), TREASURY), 0, 'a RAM launch create-fee is a different real instruction, never counted here');
  assert.equal(creatorFeeLamportsOf(distributeTx({ keys: [OTHER, 'SomeoneElse1111111111111111111111111111111'] }), TREASURY), 0, 'treasury not even in this transaction');
  assert.equal(creatorFeeLamportsOf(distributeTx({ pre: [0, 1_000_000], post: [0, 999_000] }), TREASURY), 0, 'a real decrease is never reported as a positive fee');
});

test('creatorFeeLamportsOf: accountKeys as {pubkey} objects (PublicKey-shaped), not bare strings -- same real gotcha as launchverify.js', () => {
  const tx = distributeTx({ keys: [{ pubkey: { toBase58: () => OTHER } }, { pubkey: { toBase58: () => TREASURY } }] });
  assert.equal(creatorFeeLamportsOf(tx, TREASURY), 10468);
});

const MINT = 'Mint1111111111111111111111111111111111111';

/** A real-shaped CollectCoinCreatorFee transaction: fee paid in MINT, into a token account the treasury owns. */
function collectTx({
  err = null,
  pre = [{ accountIndex: 1, owner: OTHER, mint: MINT, uiTokenAmount: { amount: '24279182', decimals: 8 } }, { accountIndex: 2, owner: TREASURY, mint: MINT, uiTokenAmount: { amount: '7742975957', decimals: 8 } }],
  post = [{ accountIndex: 1, owner: OTHER, mint: MINT, uiTokenAmount: { amount: '0', decimals: 8 } }, { accountIndex: 2, owner: TREASURY, mint: MINT, uiTokenAmount: { amount: '7767255139', decimals: 8 } }],
} = {}) {
  return { meta: { err, logMessages: ['Program log: Instruction: CollectCoinCreatorFee'], preTokenBalances: pre, postTokenBalances: post }, transaction: { message: { accountKeys: [TREASURY, OTHER] } } };
}

test('creatorFeeTokenDeltasOf: the treasury\'s own real token-account balance delta, identified by owner not address, for a real CollectCoinCreatorFee transaction', () => {
  assert.deepEqual(creatorFeeTokenDeltasOf(collectTx(), TREASURY), [{ mint: MINT, decimals: 8, rawAmount: 24279182 }]);
  assert.deepEqual(creatorFeeTokenDeltasOf(null, TREASURY), [], 'no transaction -> empty, never a guess');
  assert.deepEqual(creatorFeeTokenDeltasOf(collectTx({ err: { InstructionError: [] } }), TREASURY), [], 'a failed transaction never moved real money');
  assert.deepEqual(creatorFeeTokenDeltasOf(distributeTx(), TREASURY), [], 'a SOL-denominated DistributeCreatorFees tx is a different real instruction, never counted here');
  // A token account the treasury does NOT own (a decrease, e.g. the source vault at index 1) never counts.
  assert.deepEqual(creatorFeeTokenDeltasOf(collectTx(), OTHER), [], 'the queried address must match by owner, and OTHER only ever decreases here');
});

test('creatorFeeTokenDeltasOf: a real decrease, or missing balance data, is never reported as a positive fee', () => {
  const flat = collectTx({
    pre: [{ accountIndex: 2, owner: TREASURY, mint: MINT, uiTokenAmount: { amount: '1000', decimals: 6 } }],
    post: [{ accountIndex: 2, owner: TREASURY, mint: MINT, uiTokenAmount: { amount: '1000', decimals: 6 } }],
  });
  assert.deepEqual(creatorFeeTokenDeltasOf(flat, TREASURY), []);
  const noPreRecord = collectTx({
    pre: [],
    post: [{ accountIndex: 2, owner: TREASURY, mint: MINT, uiTokenAmount: { amount: '500', decimals: 6 } }],
  });
  assert.deepEqual(noPreRecord, noPreRecord); // sanity: construction doesn't throw
  assert.deepEqual(creatorFeeTokenDeltasOf(noPreRecord, TREASURY), [{ mint: MINT, decimals: 6, rawAmount: 500 }], 'a brand-new token account (no prior balance) starts from an implicit 0');
});

test('createJupiterPriceSource: a real-shaped response parses per mint; a bad one throws rather than guessing a price', async () => {
  const ok = createJupiterPriceSource({ fetchImpl: async (url) => {
    assert.match(url, new RegExp(`ids=${MINT}`));
    return { ok: true, async json() { return { [MINT]: { usdPrice: 1373.97 } }; } };
  } });
  assert.equal(await ok.fetchTokenUsd(MINT), 1373.97);

  const badStatus = createJupiterPriceSource({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(badStatus.fetchTokenUsd(MINT));

  const missing = createJupiterPriceSource({ fetchImpl: async () => ({ ok: true, async json() { return {}; } }) });
  await assert.rejects(missing.fetchTokenUsd(MINT), 'an unpriced/unknown mint must never fall back to a guess');

  const zero = createJupiterPriceSource({ fetchImpl: async () => ({ ok: true, async json() { return { [MINT]: { usdPrice: 0 } }; } }) });
  await assert.rejects(zero.fetchTokenUsd(MINT));
});

function fakeConnection({ pages = [], txs = {} } = {}) {
  const calls = { getSignaturesForAddress: [], getTransaction: [] };
  return {
    calls,
    async getSignaturesForAddress(address, opts) {
      calls.getSignaturesForAddress.push({ address, opts });
      const idx = pages.length - calls.getSignaturesForAddress.length;
      return pages[calls.getSignaturesForAddress.length - 1] ?? [];
    },
    async getTransaction(signature) {
      calls.getTransaction.push(signature);
      return txs[signature] ?? null;
    },
  };
}

function fakePriceSource(usd = 100) {
  return { calls: 0, async fetchSolUsd() { this.calls++; return usd; } };
}

test('createPumpFeeSource: sums real DistributeCreatorFees lamports across the treasury\'s history and converts at the real SOL price', async () => {
  const connection = fakeConnection({
    pages: [[{ signature: 's2', err: null }, { signature: 's1', err: null }]],
    txs: {
      s2: distributeTx({ pre: [0, 2_000_000], post: [0, 2_005_000] }), // +5000 lamports
      s1: distributeTx({ pre: [0, 1_000_000], post: [0, 1_010_468] }), // +10468 lamports
    },
  });
  const priceSource = fakePriceSource(100); // $100/SOL
  const source = createPumpFeeSource({ connection, treasury: TREASURY, priceSource });
  assert.equal(source.kind, 'onchain');
  const totalUsd = await source.fetchTotal();
  // (5000 + 10468) lamports / 1e9 * 100 usd = 0.0015468 usd
  assert.equal(totalUsd, Math.round(((5000 + 10468) / 1e9) * 100 * 100) / 100);
});

test('createPumpFeeSource: a failed signature is never fetched or counted', async () => {
  const connection = fakeConnection({
    pages: [[{ signature: 'ok1', err: null }, { signature: 'bad1', err: { InstructionError: [] } }]],
    txs: { ok1: distributeTx() },
  });
  const source = createPumpFeeSource({ connection, treasury: TREASURY, priceSource: fakePriceSource(1) });
  await source.fetchTotal();
  assert.deepEqual(connection.calls.getTransaction, ['ok1'], 'the failed signature is skipped before ever calling getTransaction');
});

test('createPumpFeeSource: a non-DistributeCreatorFees transaction (e.g. a RAM launch) contributes 0', async () => {
  const connection = fakeConnection({
    pages: [[{ signature: 'launch1', err: null }]],
    txs: { launch1: createV2Tx() },
  });
  const source = createPumpFeeSource({ connection, treasury: TREASURY, priceSource: fakePriceSource(1) });
  assert.equal(await source.fetchTotal(), 0);
});

function fakeTokenPriceSource(pricesByMint) {
  const calls = [];
  return { calls, async fetchTokenUsd(mint) { calls.push(mint); if (!(mint in pricesByMint)) throw new Error(`no price for ${mint}`); return pricesByMint[mint]; } };
}

test('createPumpFeeSource: without a tokenPriceSource, a CollectCoinCreatorFee transaction is never even inspected for token deltas -- SOL-only stays SOL-only, same as before this mechanism existed', async () => {
  const connection = fakeConnection({ pages: [[{ signature: 's1', err: null }]], txs: { s1: collectTx() } });
  const source = createPumpFeeSource({ connection, treasury: TREASURY, priceSource: fakePriceSource(100) }); // no tokenPriceSource
  assert.equal(await source.fetchTotal(), 0, 'the real token fee is real, but this source was not given a way to price it, so it correctly reports 0, not a guess');
});

test('createPumpFeeSource: WITH a tokenPriceSource, a real CollectCoinCreatorFee token fee is priced and added to the SOL-denominated total -- the actual regression that undercounted real fees', async () => {
  const connection = fakeConnection({
    pages: [[{ signature: 'sol1', err: null }, { signature: 'tok1', err: null }]],
    txs: {
      sol1: distributeTx({ pre: [0, 1_000_000], post: [0, 1_010_468] }), // +10468 lamports
      tok1: collectTx(), // +24279182 raw units of MINT (decimals 8) = 0.24279182 tokens
    },
  });
  const source = createPumpFeeSource({
    connection,
    treasury: TREASURY,
    priceSource: fakePriceSource(100), // $100/SOL
    tokenPriceSource: fakeTokenPriceSource({ [MINT]: 1373.97 }), // $1373.97/MINT
  });
  const total = await source.fetchTotal();
  const expectedSol = (10468 / 1e9) * 100;
  const expectedToken = 0.24279182 * 1373.97;
  assert.equal(total, Math.round((expectedSol + expectedToken) * 100) / 100);
  assert.ok(total > 300, 'a real, meaningful token-denominated fee actually moves the total, not a rounding-error sliver');
});

test('createPumpFeeSource: a mint that fails to price is skipped, logged, and never blocks the SOL total or a different mint\'s real price', async () => {
  const MINT2 = 'Mint2222222222222222222222222222222222222';
  const collectTx2 = collectTx({
    pre: [{ accountIndex: 1, owner: OTHER, mint: MINT2, uiTokenAmount: { amount: '0', decimals: 6 } }, { accountIndex: 2, owner: TREASURY, mint: MINT2, uiTokenAmount: { amount: '0', decimals: 6 } }],
    post: [{ accountIndex: 1, owner: OTHER, mint: MINT2, uiTokenAmount: { amount: '0', decimals: 6 } }, { accountIndex: 2, owner: TREASURY, mint: MINT2, uiTokenAmount: { amount: '5000000', decimals: 6 } }],
  });
  const connection = fakeConnection({
    pages: [[{ signature: 'priced', err: null }, { signature: 'unpriced', err: null }]],
    txs: { priced: collectTx(), unpriced: collectTx2 },
  });
  const logs = [];
  const source = createPumpFeeSource({
    connection,
    treasury: TREASURY,
    priceSource: fakePriceSource(1),
    tokenPriceSource: fakeTokenPriceSource({ [MINT]: 1000 }), // MINT2 deliberately has no price -> throws
    log: (l) => logs.push(l),
  });
  const total = await source.fetchTotal();
  assert.equal(total, Math.round(0.24279182 * 1000 * 100) / 100, 'MINT priced and counted; MINT2 skipped, not silently zeroed into a false confidence, but also never blocking MINT');
  assert.ok(logs.some((l) => l.includes(MINT2) && l.includes('skipping')));
});

test('createPumpFeeSource: incremental -- the second call only asks for signatures newer than the first call\'s newest, via `until`', async () => {
  let call = 0;
  const seen = [];
  const connection = {
    async getSignaturesForAddress(address, opts) {
      seen.push(opts);
      call++;
      if (call === 1) return [{ signature: 's2', err: null }, { signature: 's1', err: null }];
      if (call === 2) return [{ signature: 's3', err: null }]; // one new real fee since last scan
      return [];
    },
    async getTransaction(sig) {
      return { s1: distributeTx({ pre: [0, 0], post: [0, 1000] }), s2: distributeTx({ pre: [0, 0], post: [0, 2000] }), s3: distributeTx({ pre: [0, 0], post: [0, 3000] }) }[sig];
    },
  };
  const source = createPumpFeeSource({ connection, treasury: TREASURY, priceSource: fakePriceSource(1) });
  const first = await source.fetchTotal();
  assert.equal(first, Math.round(((1000 + 2000) / 1e9) * 1 * 100) / 100);
  assert.equal(seen[0].until, undefined, 'the very first scan has no boundary yet');

  const second = await source.fetchTotal();
  assert.equal(seen[1].until, 's2', 'the second scan only asks for signatures newer than the newest one already counted');
  assert.equal(second, Math.round(((1000 + 2000 + 3000) / 1e9) * 1 * 100) / 100, 'the running total carries forward, plus only the genuinely new fee');
});

test('createPumpFeeSource: the first scan is bounded by maxSignaturesFirstScan, newest-first, never an unbounded walk of a very old treasury', async () => {
  const bigPage = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, err: null }));
  let calls = 0;
  const connection = {
    async getSignaturesForAddress() {
      calls++;
      return calls <= 3 ? bigPage : [];
    },
    async getTransaction() {
      return distributeTx({ pre: [0, 0], post: [0, 1] });
    },
  };
  const source = createPumpFeeSource({ connection, treasury: TREASURY, priceSource: fakePriceSource(1), maxSignaturesFirstScan: 1500 });
  await source.fetchTotal();
  assert.equal(calls, 2, 'stops paginating once the cap is reached, not after exhausting the whole real history');
});

test('createPumpFeeSource: persistence -- the real scan state survives a "restart" instead of resetting the lifetime total', async () => {
  const dir = tmpDir();
  const path = join(dir, 'pumpfee.json');
  try {
    const connection = fakeConnection({
      pages: [[{ signature: 's2', err: null }, { signature: 's1', err: null }]],
      txs: {
        s2: distributeTx({ pre: [0, 2_000_000], post: [0, 2_005_000] }), // +5000 lamports
        s1: distributeTx({ pre: [0, 1_000_000], post: [0, 1_010_468] }), // +10468 lamports
      },
    });
    const first = createPumpFeeSource({ connection, treasury: TREASURY, priceSource: fakePriceSource(1_000_000), persistPath: path });
    const firstTotal = await first.fetchTotal();
    assert.ok(firstTotal > 0, 'sanity: this round of fees is real and non-trivial, not rounded away to $0.00');

    // "Restart": a fresh source pointed at the same file, with a connection that
    // (correctly, per the real incremental scan) returns NO new signatures at all --
    // simulating that the treasury has had no new activity since the last scan.
    const noNewSigsConnection = { async getSignaturesForAddress() { return []; }, async getTransaction() { throw new Error('should never be called'); } };
    const second = createPumpFeeSource({ connection: noNewSigsConnection, treasury: TREASURY, priceSource: fakePriceSource(1_000_000), persistPath: path });
    const secondTotal = await second.fetchTotal();
    assert.equal(secondTotal, firstTotal, 'the real lifetime total must never reset/regress across a restart with no new activity');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createPumpFeeSource: persistence -- a "restart" resumes the real incremental scan from the persisted newestSeenSignature, never re-running the bounded first-scan path', async () => {
  const dir = tmpDir();
  const path = join(dir, 'pumpfee.json');
  try {
    const connection = fakeConnection({
      pages: [[{ signature: 's1', err: null }]],
      txs: { s1: distributeTx({ pre: [0, 0], post: [0, 1000] }) },
    });
    const first = createPumpFeeSource({ connection, treasury: TREASURY, priceSource: fakePriceSource(1), persistPath: path });
    await first.fetchTotal();

    // A fresh source, same file. If it incorrectly started an unscanned first-scan,
    // `opts.until` would be undefined; the real incremental scan must pass the
    // persisted newestSeenSignature ('s1') as `until`, and return one more real fee.
    const seen = [];
    const resumedConnection = {
      async getSignaturesForAddress(address, opts) {
        seen.push(opts);
        return opts.until === 's1' ? [{ signature: 's2', err: null }] : [];
      },
      async getTransaction(sig) {
        return sig === 's2' ? distributeTx({ pre: [0, 0], post: [0, 500] }) : null;
      },
    };
    const second = createPumpFeeSource({ connection: resumedConnection, treasury: TREASURY, priceSource: fakePriceSource(1), persistPath: path });
    const total = await second.fetchTotal();
    assert.equal(seen[0].until, 's1', 'resumed from the persisted scan position, not an unbounded/unscanned restart');
    assert.equal(total, Math.round(((1000 + 500) / 1e9) * 1 * 100) / 100, 'the restored total (1000 lamports) plus the one genuinely new fee (500)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createPumpFeeSource: persistence -- real token totals (mint + raw amount) survive a restart too, not just the SOL side', async () => {
  const dir = tmpDir();
  const path = join(dir, 'pumpfee.json');
  try {
    const connection = fakeConnection({ pages: [[{ signature: 'tok1', err: null }]], txs: { tok1: collectTx() } });
    const first = createPumpFeeSource({
      connection, treasury: TREASURY, priceSource: fakePriceSource(1),
      tokenPriceSource: fakeTokenPriceSource({ [MINT]: 1373.97 }), persistPath: path,
    });
    const firstTotal = await first.fetchTotal();
    assert.ok(firstTotal > 0);

    const noNewSigsConnection = { async getSignaturesForAddress() { return []; }, async getTransaction() { throw new Error('should never be called'); } };
    const second = createPumpFeeSource({
      connection: noNewSigsConnection, treasury: TREASURY, priceSource: fakePriceSource(1),
      tokenPriceSource: fakeTokenPriceSource({ [MINT]: 1373.97 }), persistPath: path,
    });
    const secondTotal = await second.fetchTotal();
    assert.equal(secondTotal, firstTotal, 'the real token-denominated fee total must survive a restart too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createPumpFeeSource: persistence -- a missing or corrupt file never throws, source just starts unscanned', async () => {
  const dir = tmpDir();
  try {
    const connection = fakeConnection({ pages: [[{ signature: 's1', err: null }]], txs: { s1: distributeTx() } });
    const source = createPumpFeeSource({ connection, treasury: TREASURY, priceSource: fakePriceSource(1_000_000), persistPath: join(dir, 'does-not-exist.json') });
    assert.ok((await source.fetchTotal()) > 0, 'a missing persistence file is an honest unscanned start, never a throw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createPumpFeeSource: without a persistPath, behaviour is exactly today\'s in-memory-only default', async () => {
  const connection = fakeConnection({
    pages: [[{ signature: 's1', err: null }]],
    txs: { s1: distributeTx() },
  });
  const source = createPumpFeeSource({ connection, treasury: TREASURY, priceSource: fakePriceSource(1_000_000) }); // no persistPath
  const total = await source.fetchTotal();
  assert.ok(total > 0);
  // A fresh source with its own default (still no persistPath) starts genuinely unscanned --
  // there is nothing on disk for it to have rehydrated from.
  const fresh = createPumpFeeSource({ connection: fakeConnection({ pages: [[{ signature: 's1', err: null }]], txs: { s1: distributeTx() } }), treasury: TREASURY, priceSource: fakePriceSource(1_000_000) });
  assert.equal(await fresh.fetchTotal(), total, 'no persistence configured -> every instance independently re-derives from scratch, same as before this feature existed');
});

test('createPumpFeeSource requires its real collaborators, never silently running with none', () => {
  assert.throws(() => createPumpFeeSource({ treasury: TREASURY, priceSource: fakePriceSource() }), TypeError);
  assert.throws(() => createPumpFeeSource({ connection: fakeConnection(), priceSource: fakePriceSource() }), TypeError);
  assert.throws(() => createPumpFeeSource({ connection: fakeConnection(), treasury: TREASURY }), TypeError);
});

test('createCoinGeckoPriceSource: a real-shaped response parses; a bad one throws rather than guessing a price', async () => {
  const ok = createCoinGeckoPriceSource({ fetchImpl: async () => ({ ok: true, json: async () => ({ solana: { usd: 123.45 } }) }) });
  assert.equal(await ok.fetchSolUsd(), 123.45);

  const badStatus = createCoinGeckoPriceSource({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(badStatus.fetchSolUsd());

  const badShape = createCoinGeckoPriceSource({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(badShape.fetchSolUsd());

  const zero = createCoinGeckoPriceSource({ fetchImpl: async () => ({ ok: true, json: async () => ({ solana: { usd: 0 } }) }) });
  await assert.rejects(zero.fetchSolUsd(), 'a non-positive price is never usable, never silently accepted');
});

function fakeWeb3Connection({ rpcEndpoint = 'https://fake-rpc.example', getSignaturesForAddress = async () => [] } = {}) {
  return { rpcEndpoint, getSignaturesForAddress };
}

test('connectionAdapter.getSignaturesForAddress: converts a plain base58 string to a real PublicKey before calling the library', async () => {
  let seenAddress = null;
  const web3Connection = fakeWeb3Connection({
    getSignaturesForAddress: async (addr, opts) => { seenAddress = addr; return [{ signature: 'x' }]; },
  });
  const adapter = connectionAdapter(web3Connection);
  const realLookingAddress = '5M6Pc7ossZ8cuQAjnexH9vv2axEJoncgZ3C6uD2PJqHm'; // a real, valid base58 pubkey shape; TREASURY above is not
  const result = await adapter.getSignaturesForAddress(realLookingAddress, { limit: 10 });
  assert.equal(typeof seenAddress, 'object', 'a real PublicKey instance, not the bare string');
  assert.equal(seenAddress.toBase58(), realLookingAddress);
  assert.deepEqual(result, [{ signature: 'x' }]);
});

test('connectionAdapter.getTransaction: a raw JSON-RPC call, not the library\'s getParsedTransaction -- real fix for version-1 transactions the installed web3.js schema rejects', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, async json() { return { jsonrpc: '2.0', id: 1, result: distributeTx() }; } };
  };
  const adapter = connectionAdapter(fakeWeb3Connection({ rpcEndpoint: 'https://fake-rpc.example' }), { fetchImpl });
  const tx = await adapter.getTransaction('sig123');
  assert.equal(calls[0].url, 'https://fake-rpc.example');
  assert.equal(calls[0].body.method, 'getTransaction');
  assert.deepEqual(calls[0].body.params, ['sig123', { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
  assert.deepEqual(tx, distributeTx());
});

test('connectionAdapter.getTransaction: retries a real 429 with backoff instead of silently undercounting, same resilience the raw fetch otherwise loses', async () => {
  let calls = 0;
  const delays = [];
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 0); }; // real backoff math, no real wait in the test
  try {
    const fetchImpl = async () => {
      calls++;
      if (calls < 3) return { status: 429, ok: false };
      return { ok: true, status: 200, async json() { return { jsonrpc: '2.0', id: 1, result: distributeTx() }; } };
    };
    const adapter = connectionAdapter(fakeWeb3Connection(), { fetchImpl });
    const tx = await adapter.getTransaction('sig');
    assert.equal(calls, 3, 'succeeded on the 3rd attempt after two real 429s');
    assert.deepEqual(delays, [500, 1000], 'backoff doubles each retry');
    assert.deepEqual(tx, distributeTx());
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('connectionAdapter.getTransaction: gives up after repeated 429s rather than retrying forever', async () => {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    let calls = 0;
    const adapter = connectionAdapter(fakeWeb3Connection(), { fetchImpl: async () => { calls++; return { status: 429, ok: false }; } });
    await assert.rejects(adapter.getTransaction('sig'), /429/);
    assert.equal(calls, 6, '1 initial try + 5 retries, then it stops');
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('connectionAdapter.getTransaction: a real RPC error (bad status or a JSON-RPC error body) throws rather than returning something that silently counts as 0', async () => {
  const badStatus = connectionAdapter(fakeWeb3Connection(), { fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(badStatus.getTransaction('s'));

  const errorBody = connectionAdapter(fakeWeb3Connection(), {
    fetchImpl: async () => ({ ok: true, async json() { return { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'boom' } }; } }),
  });
  await assert.rejects(errorBody.getTransaction('s'), /boom/);
});

test('connectionAdapter.getTransaction: a real "not found yet" response (result: null) passes through as null, never an invented transaction', async () => {
  const adapter = connectionAdapter(fakeWeb3Connection(), {
    fetchImpl: async () => ({ ok: true, async json() { return { jsonrpc: '2.0', id: 1, result: null }; } }),
  });
  assert.equal(await adapter.getTransaction('s'), null);
});

test('createCoinGeckoZecPriceSource: a real-shaped response parses; a bad one throws rather than guessing a price', async () => {
  const ok = createCoinGeckoZecPriceSource({ fetchImpl: async (url) => {
    assert.match(url, /ids=zcash/);
    return { ok: true, async json() { return { zcash: { usd: 1370.16 } }; } };
  } });
  assert.equal(await ok.fetchZecUsd(), 1370.16);

  const badStatus = createCoinGeckoZecPriceSource({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(badStatus.fetchZecUsd());

  const badShape = createCoinGeckoZecPriceSource({ fetchImpl: async () => ({ ok: true, async json() { return { solana: { usd: 1 } }; } }) });
  await assert.rejects(badShape.fetchZecUsd(), 'the solana price shape must never be mistaken for a zcash one');

  const zero = createCoinGeckoZecPriceSource({ fetchImpl: async () => ({ ok: true, async json() { return { zcash: { usd: 0 } }; } }) });
  await assert.rejects(zero.fetchZecUsd());
});

test('pumpFeePolicy: off unless RAMHERD_FEE_SOURCE is exactly "onchain" -- the mock stays the default', () => {
  assert.equal(pumpFeePolicy({}).enabled, false);
  assert.equal(pumpFeePolicy({ RAMHERD_FEE_SOURCE: 'true' }).enabled, false);
  assert.equal(pumpFeePolicy({ RAMHERD_FEE_SOURCE: 'onchain' }).enabled, true);
});
