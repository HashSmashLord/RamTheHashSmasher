// A real `FeeSource` (ledger.js) that reads pump.fun's own real creator-fee
// payments to the treasury wallet, instead of the mock/admin-set number every
// deploy used before this file existed. Two real, separate mechanisms,
// confirmed live against the real treasury 2026-10-06, both counted here:
//
//   1. DistributeCreatorFees (bonding-curve era), paid in native SOL straight
//      into the treasury's own balance -- see creatorFeeLamportsOf.
//   2. CollectCoinCreatorFee (after a token migrates off the bonding curve to
//      pump's own AMM), paid in THAT TOKEN ITSELF into a token account the
//      treasury owns, not SOL -- see creatorFeeTokenDeltasOf. Found live
//      2026-10-06 after the operator reported real fees well above what
//      mechanism 1 alone was reporting; every launched RAM's own token (and
//      $RAM itself) can pay fees this way once it migrates, each in its own
//      mint, each needing its own real USD price (createJupiterPriceSource).
//
// Neither is the 0.01 SOL launch create-fee transfer (CreateV2, see
// launchverify.js) that also lands in this same wallet -- only these two real
// instructions ever count here, so a RAM's own launch fee is never double-
// counted as a "creator fee".
//
// Honesty: a signature whose transaction failed on chain (`err` set) is
// skipped, never counted. Unknown/unparseable transactions count for 0, not
// a guess. Real USD prices come from real `PriceSource`s (CoinGecko for SOL/
// ZEC, Jupiter per-mint for collected tokens); if the SOL price fails,
// fetchTotal() throws rather than silently using a stale or invented price --
// a single mint's price failing skips only that mint's contribution this
// refresh (logged), so one illiquid or delisted token can never block every
// other real fee from being counted.

import { PublicKey } from '@solana/web3.js';
import { readJsonFile, writeJsonFileAtomic } from './persist.js';

/** pump.fun's real fee-sharing program (bonding-curve era), confirmed from a live transaction's own logs. */
export const PUMP_FEE_SHARING_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DISTRIBUTE_LOG = 'Instruction: DistributeCreatorFees';

/** pump's AMM program (post-migration), confirmed the same way. */
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const COLLECT_LOG = 'Instruction: CollectCoinCreatorFee';

function hasLog(tx, needle) {
  const logs = tx?.meta?.logMessages ?? [];
  return logs.some((l) => typeof l === 'string' && l.includes(needle));
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
  if (!hasLog(tx, DISTRIBUTE_LOG)) return 0;
  const i = accountKeysOf(tx).indexOf(treasury);
  if (i < 0) return 0;
  const pre = tx.meta?.preBalances?.[i];
  const post = tx.meta?.postBalances?.[i];
  if (typeof pre !== 'number' || typeof post !== 'number') return 0;
  return Math.max(0, post - pre);
}

/**
 * The real token(s) (mint + raw amount, in that mint's own smallest unit) the
 * treasury actually gained in one real CollectCoinCreatorFee transaction --
 * paid in the migrated token itself, not SOL, into a token account the
 * treasury owns (identified by `owner`, not by address: real-tested 2026-10-06,
 * the token account's own address is just another PDA, never the treasury's
 * own pubkey). Read from the real pre/postTokenBalances, the authoritative
 * balance record, not the inner transferChecked instruction's own claimed
 * amount -- same "trust the real delta, not the parsed instruction args"
 * discipline creatorFeeLamportsOf already uses for the SOL case. Usually one
 * entry; an array because nothing rules out a transaction touching more than
 * one of the treasury's token accounts.
 * @param {any} tx
 * @param {string} treasury
 * @returns {{ mint: string, decimals: number, rawAmount: number }[]}
 */
export function creatorFeeTokenDeltasOf(tx, treasury) {
  if (!tx || tx.meta?.err) return [];
  if (!hasLog(tx, COLLECT_LOG)) return [];
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const preByIndex = new Map(pre.map((b) => [b.accountIndex, b]));
  const out = [];
  for (const p of post) {
    if (p.owner !== treasury) continue;
    const before = preByIndex.get(p.accountIndex);
    const preAmount = Number(before?.uiTokenAmount?.amount ?? 0);
    const postAmount = Number(p.uiTokenAmount?.amount ?? 0);
    const rawAmount = postAmount - preAmount;
    if (rawAmount > 0) out.push({ mint: p.mint, decimals: p.uiTokenAmount?.decimals ?? 0, rawAmount });
  }
  return out;
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
 * A real ZEC/USD price from CoinGecko's public (no-key) endpoint -- separate
 * call from the SOL price above (different id, cached independently by
 * whoever calls this; this function itself never caches), used only to show
 * the same real fee total a second way, in ZEC, never to track real ZEC
 * actually arriving anywhere (there is no ZEC-denominated FeeSource; this is
 * a display conversion of the one real USD figure pumpfee.js already has).
 */
export function createCoinGeckoZecPriceSource({ fetchImpl = fetch } = {}) {
  return {
    kind: 'coingecko',
    async fetchZecUsd() {
      const res = await fetchImpl('https://api.coingecko.com/api/v3/simple/price?ids=zcash&vs_currencies=usd');
      if (!res.ok) throw new Error(`CoinGecko ZEC price fetch failed: ${res.status}`);
      const body = await res.json();
      const price = body?.zcash?.usd;
      if (typeof price !== 'number' || !(price > 0)) throw new Error('CoinGecko returned no usable zcash.usd price');
      return price;
    },
  };
}

/**
 * A real per-mint USD price from Jupiter's public (no-key) price API --
 * unlike CoinGecko, this actually prices arbitrary pump.fun tokens (real-
 * tested 2026-10-06 against both $RAM's own mint and an unrelated migrated
 * token, both priced correctly from real DEX liquidity). Used only for
 * CollectCoinCreatorFee's token-denominated fees; the SOL and ZEC prices
 * above stay on CoinGecko, unchanged.
 */
export function createJupiterPriceSource({ fetchImpl = fetch } = {}) {
  return {
    kind: 'jupiter',
    async fetchTokenUsd(mint) {
      const res = await fetchImpl(`https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(mint)}`);
      if (!res.ok) throw new Error(`Jupiter price fetch failed for ${mint}: ${res.status}`);
      const body = await res.json();
      const price = body?.[mint]?.usdPrice;
      if (typeof price !== 'number' || !(price > 0)) throw new Error(`Jupiter returned no usable price for ${mint}`);
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
 * Persistence (opt-in, `persistPath`; same atomic-write pattern as
 * rams.js/moderation.js/persist.js): real bug, found 2026-10-06 -- without
 * this, `totalLamports`/`tokenTotals`/`newestSeenSignature`/`scannedAny` all
 * lived in plain in-memory variables, so every restart (every deploy) reset
 * `scannedAny` to false and forced the NEXT fetchTotal() back into the
 * bounded first-scan path (`maxSignaturesFirstScan`, newest-first) instead
 * of the real incremental one. For a treasury with more history than that
 * cap, that silently re-derived a smaller "lifetime" total than what had
 * already been correctly counted before the restart -- a real total that
 * should only ever grow instead visibly dropping (or recomputing to some
 * other value) on every deploy. Persisting the running totals + scan
 * position means a restart resumes the real incremental scan exactly where
 * it left off, never re-walks capped history, and the lifetime figure never
 * regresses.
 *
 * @param {{
 *   connection: { getSignaturesForAddress: Function, getTransaction: Function },
 *   treasury: string,
 *   priceSource: { fetchSolUsd: () => Promise<number> },
 *   tokenPriceSource?: { fetchTokenUsd: (mint: string) => Promise<number> },
 *   maxSignaturesFirstScan?: number,
 *   persistPath?: string|null,
 *   log?: (line: string) => void,
 * }} opts
 */
export function createPumpFeeSource({ connection, treasury, priceSource, tokenPriceSource = null, maxSignaturesFirstScan = 2000, persistPath = null, log = () => {} }) {
  if (!connection) throw new TypeError('createPumpFeeSource requires a connection');
  if (typeof treasury !== 'string' || !treasury) throw new TypeError('createPumpFeeSource requires a treasury address');
  if (!priceSource || typeof priceSource.fetchSolUsd !== 'function') throw new TypeError('createPumpFeeSource requires a priceSource');

  let totalLamports = 0;
  // mint -> raw token amount (that mint's own smallest unit), accumulated forever, same as
  // totalLamports -- converted to USD fresh every fetchTotal() call at whatever price is
  // current then, never compounded/rounded per-transaction.
  const tokenTotals = new Map(); // mint -> { rawAmount, decimals }
  let newestSeenSignature = null;
  let scannedAny = false;

  // Rehydrate the real scan state, if any, so a restart resumes the
  // incremental scan instead of starting the bounded first-scan path over.
  // A missing file (first boot, or no persistPath at all) or a corrupt one
  // both leave this exactly as it would be without persistence -- readJsonFile
  // has already logged the latter.
  if (persistPath) {
    const loaded = readJsonFile(persistPath, { log });
    if (loaded && typeof loaded.totalLamports === 'number' && Array.isArray(loaded.tokenTotals)) {
      totalLamports = loaded.totalLamports;
      newestSeenSignature = loaded.newestSeenSignature ?? null;
      scannedAny = Boolean(loaded.scannedAny);
      for (const [mint, entry] of loaded.tokenTotals) tokenTotals.set(mint, entry);
      log(`pumpfee: rehydrated a real scan state from ${persistPath} (totalLamports=${totalLamports}, ${tokenTotals.size} mint(s) tracked, scannedAny=${scannedAny}).`);
    } else if (loaded) {
      log(`pumpfee: ${persistPath} did not have the expected shape, starting from an unscanned state.`);
    }
  }

  function persist() {
    if (!persistPath) return;
    writeJsonFileAtomic(
      persistPath,
      { version: 1, totalLamports, newestSeenSignature, scannedAny, tokenTotals: [...tokenTotals.entries()] },
      { log },
    );
  }

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
      if (tokenPriceSource) {
        for (const d of creatorFeeTokenDeltasOf(tx, treasury)) {
          const existing = tokenTotals.get(d.mint) ?? { rawAmount: 0, decimals: d.decimals };
          existing.rawAmount += d.rawAmount;
          tokenTotals.set(d.mint, existing);
        }
      }
    }
    totalLamports += newLamports;
    scannedAny = true;
    persist();
    const solUsd = await priceSource.fetchSolUsd();
    let totalUsd = (totalLamports / 1e9) * solUsd;
    for (const [mint, { rawAmount, decimals }] of tokenTotals) {
      if (rawAmount <= 0) continue;
      try {
        const tokenUsd = await tokenPriceSource.fetchTokenUsd(mint);
        totalUsd += (rawAmount / 10 ** decimals) * tokenUsd;
      } catch (err) {
        // One illiquid/delisted/rate-limited mint must never block every other real fee
        // (SOL-denominated or another mint) from being counted this refresh.
        log(`pumpfee: could not price ${mint}'s collected fee this refresh, skipping it: ${err?.message || err}`);
      }
    }
    return Math.round(totalUsd * 100) / 100;
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
