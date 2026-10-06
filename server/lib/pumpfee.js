// A real `FeeSource` (ledger.js) that reads pump.fun's own real creator-fee
// distributions to the treasury wallet, instead of the mock/admin-set number
// every deploy has used so far. Confirmed real 2026-10-06 against a live,
// finalized transaction at the real treasury address: its program logs read
// "Program log: Instruction: DistributeCreatorFees", invoked by pump.fun's
// own fee-sharing program (PUMP_FEE_SHARING_PROGRAM below), and the
// treasury's own preBalance -> postBalance delta in that same transaction is
// exactly the lamports it was paid. That is a different instruction than the
// 0.01 SOL launch create-fee transfer (CreateV2, see launchverify.js) that
// also lands in this same wallet -- only a DistributeCreatorFees transaction
// ever counts here, so a RAM's own launch fee is never double-counted as a
// "creator fee".
//
// Honesty: a signature whose transaction failed on chain (`err` set) is
// skipped, never counted. Unknown/unparseable transactions count for 0, not
// a guess. The real SOL/USD price comes from a real `PriceSource` (a
// CoinGecko fetch below); if that fails, fetchTotal() throws rather than
// silently using a stale or invented price.

import { PublicKey } from '@solana/web3.js';

/** pump.fun's real fee-sharing program, confirmed from a live transaction's own logs. */
export const PUMP_FEE_SHARING_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DISTRIBUTE_LOG = 'Instruction: DistributeCreatorFees';

function isDistributeCreatorFeesTx(tx) {
  const logs = tx?.meta?.logMessages ?? [];
  return logs.some((l) => typeof l === 'string' && l.includes(DISTRIBUTE_LOG));
}

/** jsonParsed accountKeys are [{pubkey, ...}, ...]; pubkey may be a string or a PublicKey (see launchverify.js's same gotcha). */
function accountKeysOf(tx) {
  return (tx?.transaction?.message?.accountKeys ?? []).map((k) => {
    const pk = typeof k === 'string' ? k : k?.pubkey;
    return typeof pk === 'string' ? pk : pk?.toBase58?.() ?? null;
  });
}

/**
 * Lamports the treasury actually gained in one real DistributeCreatorFees
 * transaction, or 0 for anything else (wrong instruction, treasury not in
 * the transaction, or missing balance data) -- never a guess.
 * @param {any} tx - a jsonParsed getTransaction result, or null
 * @param {string} treasury
 */
export function creatorFeeLamportsOf(tx, treasury) {
  if (!tx || tx.meta?.err) return 0;
  if (!isDistributeCreatorFeesTx(tx)) return 0;
  const i = accountKeysOf(tx).indexOf(treasury);
  if (i < 0) return 0;
  const pre = tx.meta?.preBalances?.[i];
  const post = tx.meta?.postBalances?.[i];
  if (typeof pre !== 'number' || typeof post !== 'number') return 0;
  return Math.max(0, post - pre);
}

/**
 * Thin adapter over a real @solana/web3.js Connection -- same pattern as
 * launchverify.js's connectionAdapter, and the same reason: a jsonParsed shape,
 * not the raw compiled-message one plain getTransaction returns.
 *
 * getTransaction itself goes around the library's own getParsedTransaction, not
 * through it: a real dry run against the real treasury 2026-10-06 hit real
 * transactions at version 1 that the installed @solana/web3.js (1.98.4) accepts
 * the RPC returning (maxSupportedTransactionVersion raised to 1 gets it past the
 * RPC) but then refuses itself -- its own response schema only knows the literal
 * versions "legacy" and 0, so it throws ("expected a union of literal | literal,
 * but received: 1") on the exact transactions this module most needs to count,
 * silently undercounting every real fee inside one. A raw JSON-RPC call bypasses
 * that client-side schema entirely; the real response shape (meta.preBalances,
 * meta.logMessages, transaction.message.accountKeys) is identical either way, and
 * `creatorFeeLamportsOf` above already reads exactly that shape.
 */
export function connectionAdapter(web3Connection, { fetchImpl = fetch } = {}) {
  return {
    // getSignaturesForAddress needs a real PublicKey instance, not a base58 string
    // (confirmed real 2026-10-06: a plain string throws "address.toBase58 is not a
    // function" from inside web3.js itself) -- callers of this adapter pass the
    // address as a plain string throughout this module, same as every other address
    // in this codebase, and this is the one place that converts it.
    async getSignaturesForAddress(address, opts) {
      const key = typeof address === 'string' ? new PublicKey(address) : address;
      return web3Connection.getSignaturesForAddress(key, opts);
    },
    async getTransaction(signature) {
      // The raw fetch below has none of @solana/web3.js's own built-in 429 retry/backoff
      // (that library-internal retry is exactly what made its getParsedTransaction slow
      // but resilient) -- real-tested 2026-10-06: without replacing it here, a public
      // RPC's rate limit turns into real, silent undercounting (one dry run lost 18 of
      // ~500 transactions to bare 429s in under 3 seconds, versus 2 lost to the version-1
      // schema bug before). maxRetries=5 with the same delay schedule web3.js itself logs
      // (500ms, 1s, 2s, 4s, 8s) buys back that resilience without this module depending on
      // the library's own retry internals.
      let res;
      for (let attempt = 0; ; attempt++) {
        res = await fetchImpl(web3Connection.rpcEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }],
          }),
        });
        if (res.status !== 429 || attempt >= 5) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
      if (!res.ok) throw new Error(`getTransaction RPC call failed: ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`getTransaction RPC error: ${body.error.message || JSON.stringify(body.error)}`);
      return body.result ?? null;
    },
  };
}

/** A real SOL/USD price from CoinGecko's public (no-key) endpoint. */
export function createCoinGeckoPriceSource({ fetchImpl = fetch } = {}) {
  return {
    kind: 'coingecko',
    async fetchSolUsd() {
      const res = await fetchImpl('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      if (!res.ok) throw new Error(`CoinGecko price fetch failed: ${res.status}`);
      const body = await res.json();
      const price = body?.solana?.usd;
      if (typeof price !== 'number' || !(price > 0)) throw new Error('CoinGecko returned no usable solana.usd price');
      return price;
    },
  };
}

/**
 * The real `FeeSource` (ledger.js). Scans the treasury's real transaction
 * history for DistributeCreatorFees payments and converts the lamport total
 * to USD at the real current SOL price. Incremental: after the first call
 * (bounded by `maxSignaturesFirstScan`, newest-first, so a very old treasury
 * is summarized rather than fully walked), later calls only ask the RPC for
 * signatures newer than the last one already counted (`until`), so a long-
 * running server does not re-scan its whole history on every refresh.
 *
 * @param {{
 *   connection: { getSignaturesForAddress: Function, getTransaction: Function },
 *   treasury: string,
 *   priceSource: { fetchSolUsd: () => Promise<number> },
 *   maxSignaturesFirstScan?: number,
 *   log?: (line: string) => void,
 * }} opts
 */
export function createPumpFeeSource({ connection, treasury, priceSource, maxSignaturesFirstScan = 2000, log = () => {} }) {
  if (!connection) throw new TypeError('createPumpFeeSource requires a connection');
  if (typeof treasury !== 'string' || !treasury) throw new TypeError('createPumpFeeSource requires a treasury address');
  if (!priceSource || typeof priceSource.fetchSolUsd !== 'function') throw new TypeError('createPumpFeeSource requires a priceSource');

  let totalLamports = 0;
  let newestSeenSignature = null;
  let scannedAny = false;

  async function collectSince(untilSignature, cap) {
    const out = [];
    let before;
    for (;;) {
      const page = await connection.getSignaturesForAddress(treasury, { limit: 1000, before, until: untilSignature ?? undefined });
      if (!page || page.length === 0) break;
      out.push(...page);
      if (out.length >= cap) return out.slice(0, cap);
      if (page.length < 1000) break; // short page = no more history
      before = page[page.length - 1].signature;
    }
    return out;
  }

  async function fetchTotal() {
    const untilSig = scannedAny ? newestSeenSignature : null;
    const cap = scannedAny ? Number.MAX_SAFE_INTEGER : maxSignaturesFirstScan;
    const sigs = await collectSince(untilSig, cap);
    if (sigs.length > 0) newestSeenSignature = sigs[0].signature; // newest-first
    let newLamports = 0;
    for (const s of sigs) {
      if (s.err) continue; // a failed transaction never moved real money
      let tx;
      try {
        tx = await connection.getTransaction(s.signature);
      } catch (err) {
        log(`pumpfee: could not fetch ${s.signature}, skipping this refresh: ${err?.message || err}`);
        continue;
      }
      newLamports += creatorFeeLamportsOf(tx, treasury);
    }
    totalLamports += newLamports;
    scannedAny = true;
    const solUsd = await priceSource.fetchSolUsd();
    return Math.round((totalLamports / 1e9) * solUsd * 100) / 100;
  }

  return { kind: 'onchain', fetchTotal };
}

/**
 * Opt-in gate for the real on-chain fee source. Off by default (the mock
 * stays the default source, same as every other opt-in feature in this
 * codebase); needs no secret -- the Solana RPC and CoinGecko endpoints this
 * uses are both public and keyless -- but is still gated the same way
 * everything else real here is, so a fresh deploy never silently starts
 * making outbound calls on a schedule without the operator asking for it.
 */
export function pumpFeePolicy(env = process.env) {
  return Object.freeze({ enabled: env.RAMHERD_FEE_SOURCE === 'onchain' });
}
