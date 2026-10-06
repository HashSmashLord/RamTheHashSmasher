// Launchpad: verifies a REAL on-chain launch transaction, so a RAM can go active
// automatically instead of needing an operator to find and enter the signature by
// hand (server/lib/rams.js confirmLaunch() itself trusts whatever signature it is
// given — this module is what actually checks one against the chain first).
//
// What "verified" means here: a finalized, error-free transaction whose account
// keys include this RAM's own mint, the real treasury, and the RAM's own owner
// wallet, and whose program logs show the real pump.fun CreateV2 instruction ran.
// That's the same thing a human would check by reading the transaction (and is
// exactly what was done by hand for ram-0002/ram-0003, 2026-10-06, before this
// existed). It does not re-derive amounts or re-walk every instruction the way
// inspectLaunchTransaction() does for the unsigned bytes before signing — that
// already happened before the user ever saw this transaction; this step is
// "did this specific signature really pay this specific RAM's launch", not a
// second full audit of pump.fun's own instruction set.

export class LaunchVerifyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function accountKeysOf(tx) {
  // jsonParsed getTransaction: message.accountKeys is [{pubkey, signer, writable}, ...]
  // for legacy and v0 alike once maxSupportedTransactionVersion is passed. `pubkey` is a
  // PublicKey instance from @solana/web3.js's own getParsedTransaction, not a string --
  // real-tested 2026-10-06: without toBase58() here, every address comparison below silently
  // fails (a PublicKey object is never === a base58 string), so this verifier reported every
  // genuine, finalized launch as a "mismatch" no matter what. Also accept a plain string, for
  // callers (tests, or a raw RPC response) that already hand back base58 text.
  return (tx?.transaction?.message?.accountKeys ?? []).map((k) => {
    const pk = typeof k === 'string' ? k : k.pubkey;
    return typeof pk === 'string' ? pk : pk.toBase58();
  });
}

function logsOf(tx) {
  return tx?.meta?.logMessages ?? [];
}

/**
 * @param {{ getTransaction: (signature: string) => Promise<any|null> }} connection
 *   Anything with a getTransaction(signature) -> the real RPC's jsonParsed result
 *   (or null if not found yet). A thin wrapper over web3.Connection in production;
 *   a fake in tests, same pattern as the rest of this codebase's sandbox/E2B fakes.
 * @param {string} signature
 * @param {{ mint: string, treasury: string, owner: string }} expected
 * @returns {Promise<{ ok: true } | { ok: false, code: string, reason: string }>}
 */
export async function verifyLaunchSignature(connection, signature, expected) {
  let tx;
  try {
    tx = await connection.getTransaction(signature);
  } catch (err) {
    return { ok: false, code: 'rpc_error', reason: `Could not reach the Solana RPC: ${err.message}` };
  }
  if (!tx) {
    return { ok: false, code: 'not_found', reason: 'That signature was not found on chain yet. It may still be confirming; try again shortly.' };
  }
  if (tx.meta?.err) {
    return { ok: false, code: 'failed', reason: `That transaction landed but failed on chain: ${JSON.stringify(tx.meta.err)}` };
  }
  const keys = accountKeysOf(tx);
  for (const [label, address] of [['mint', expected.mint], ['treasury', expected.treasury], ['owner', expected.owner]]) {
    if (!address || !keys.includes(address)) {
      return { ok: false, code: 'mismatch', reason: `That transaction does not include this RAM's own ${label} (${address ?? 'unset'}).` };
    }
  }
  const logs = logsOf(tx);
  if (!logs.some((l) => l.includes('Instruction: CreateV2'))) {
    return { ok: false, code: 'mismatch', reason: 'That transaction does not contain a pump.fun CreateV2 instruction.' };
  }
  return { ok: true };
}

/**
 * Thin adapter over a real @solana/web3.js Connection.
 *
 * Must use getParsedTransaction, not getTransaction: the plain getTransaction()'s
 * `message` is a compiled Message/VersionedMessage (no `accountKeys` array at all --
 * only `staticAccountKeys` and a `getAccountKeys()` method that needs the lookup table
 * passed back in). getParsedTransaction() is the one that returns the jsonParsed shape
 * accountKeysOf() above actually reads. Confirmed real 2026-10-06: wired to plain
 * getTransaction, this adapter reported account keys as `undefined` for every real,
 * finalized transaction, so verifyLaunchSignature() failed 'mismatch' on all of them.
 */
export function connectionAdapter(web3Connection) {
  return {
    async getTransaction(signature) {
      return web3Connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    },
  };
}
