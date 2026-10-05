// Launchpad RAM registry: user-created RAMs and their lifecycle.
//
//   draft               validated request stored; owner = the user's wallet
//     -> awaiting-signature   the unsigned launch transaction was built for a
//                             mint public key the user's browser generated
//     -> active               the operator confirmed the launch landed AND
//                             approved the owner's brief; the RAM's owned slot
//                             and its funding account now exist
//   draft | awaiting-signature -> cancelled
//
// What "confirmed" means today: the operator records the launch transaction's
// signature by hand (admin route). There is no automatic on-chain launch
// verifier yet, so nothing here claims the chain was checked. Wallet ownership
// itself is only ever proven by the wallet signing the launch transaction; a
// draft is just a request and costs nothing.
//
// Money: the RAM's funding account (ramfunds.js) gets the 0.2 SOL create fee
// on activation and any creator fees later reported for its token; a judged
// HashSmash win writes an owed payout to the owner's wallet (payouts.js).
// Nothing here can send, sign or claim anything.

import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { CREATE_FEE_LAMPORTS, DEFAULT_TREASURY } from './launchtx.js';

export const RAM_STATUSES = Object.freeze(['draft', 'awaiting-signature', 'active', 'cancelled']);

/** pump.fun's create_v2 metadata URI limit. */
export const MAX_URI_LENGTH = 200;

function isSignature(value) {
  if (typeof value !== 'string') return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   slotManager: { createOwnedSlot: Function },
 *   funds: ReturnType<typeof import('./ramfunds.js').createRamFunds>,
 *   payouts: ReturnType<typeof import('./payouts.js').createPayoutBook>,
 *   publicBaseUrl: string,
 *   treasury?: string,
 *   createFeeLamports?: number,
 *   now?: () => string,
 *   idPrefix?: string,
 *   pinata?: ReturnType<typeof import('./pinata.js').createPinataClient>|null,
 * }} opts
 */
export function createRamRegistry({ slotManager, funds, payouts, publicBaseUrl, treasury = DEFAULT_TREASURY, createFeeLamports = CREATE_FEE_LAMPORTS, now = () => new Date().toISOString(), idPrefix = 'ram', pinata = null }) {
  if (typeof publicBaseUrl !== 'string' || !/^https?:\/\//.test(publicBaseUrl)) throw new TypeError('publicBaseUrl must be an http(s) URL');
  const base = publicBaseUrl.replace(/\/+$/, '');
  /** @type {Map<string, any>} */
  const rams = new Map();
  const mintsInUse = new Map();
  /** @type {Map<string, Promise<void>>} test-awaitable: see waitForMetadataPin() */
  const pinPromises = new Map();
  let seq = 0;

  const copy = (r) => JSON.parse(JSON.stringify(r));

  function mustGet(id) {
    const ram = rams.get(id);
    if (!ram) throw new RangeError(`unknown RAM id: ${id}`);
    return ram;
  }

  function touch(ram, status) {
    ram.history.push({ ts: now(), from: ram.status, to: status });
    ram.status = status;
    ram.updatedAt = now();
  }

  /** @param {ReturnType<typeof import('./launchpad.js').validateCreateRequest>['value']} value - already validated */
  function createDraft(value) {
    const id = `${idPrefix}-${String(++seq).padStart(4, '0')}`;
    const uri = `${base}/api/launchpad/rams/${id}/metadata.json`;
    if (uri.length > MAX_URI_LENGTH) throw new RangeError(`metadata URI is longer than ${MAX_URI_LENGTH} characters`);
    const ram = {
      id,
      owner: value.owner,
      hashFamily: value.hashFamily,
      track: value.track,
      rounds: value.rounds,
      approach: value.approach,
      approachDetail: value.approachDetail,
      model: value.model,
      token: { name: value.tokenName, symbol: value.tokenSymbol, uri, mint: null },
      treasury,
      createFeeLamports,
      status: 'draft',
      briefApproved: false,
      launchSignature: null,
      slotId: null,
      history: [],
      createdAt: now(),
      updatedAt: now(),
    };
    rams.set(id, ram);
    // Pinata, if configured: pin the real metadata JSON to IPFS and swap the
    // token's uri from this server's own endpoint to the pinned gateway URL.
    // Fire-and-forget on purpose -- createDraft stays synchronous (callers
    // and every existing test are unaffected), and a Pinata hiccup (rate
    // limit, network) never blocks or fails a draft: the self-hosted URI it
    // already has keeps working. waitForMetadataPin(id) lets a test or an
    // operator await the real outcome deterministically instead of racing it.
    if (pinata) {
      const pinned = pinata
        .pinJson(metadata(id), { name: `${ram.token.symbol}-${id}-metadata` })
        .then(({ cid, uri }) => {
          if (uri.length <= MAX_URI_LENGTH) {
            ram.token.uri = uri;
            ram.token.metadataCid = cid;
            ram.updatedAt = now();
          }
          // A pinned URI over the limit is silently skipped (self-hosted URI
          // keeps serving); that should never actually happen at this
          // payload size, but create_v2 would reject it outright if it did.
        })
        .catch(() => {
          // Pinata failed: the self-hosted metadata.json URI this draft
          // already has keeps working. Nothing here is user-facing yet
          // (LAUNCHPAD_LIVE is false), so there is no feed to report it to.
        });
      pinPromises.set(id, pinned);
    }
    return copy(ram);
  }

  /** Test/operator hook: resolves once this RAM's Pinata pin attempt has finished (success or
   * failure), or immediately if Pinata isn't configured or this RAM was never drafted with it. */
  async function waitForMetadataPin(id) {
    await (pinPromises.get(id) || Promise.resolve());
  }

  /**
   * Records the mint public key the user's browser generated for this launch.
   * Re-preparing with a fresh mint is allowed until the launch is confirmed
   * (e.g. the user closed Phantom and starts over).
   */
  function prepareLaunch(id, mint) {
    const ram = mustGet(id);
    if (ram.status !== 'draft' && ram.status !== 'awaiting-signature') throw new Error(`RAM ${id} is ${ram.status}; it cannot be launched`);
    let key;
    try {
      key = new PublicKey(mint);
    } catch {
      throw new TypeError('mint is not a valid Solana public key');
    }
    if (key.toBase58() !== mint || !PublicKey.isOnCurve(key.toBytes())) throw new TypeError('mint must be the public key of a fresh keypair');
    if (mint === ram.owner || mint === treasury) throw new TypeError('mint must be a fresh key');
    const holder = mintsInUse.get(mint);
    if (holder && holder !== id) throw new Error('that mint is already used by another RAM');
    if (ram.token.mint && ram.token.mint !== mint) mintsInUse.delete(ram.token.mint);
    ram.token.mint = mint;
    mintsInUse.set(mint, id);
    if (ram.status === 'draft') touch(ram, 'awaiting-signature');
    else ram.updatedAt = now();
    return copy(ram);
  }

  /**
   * Operator-only. Records that the launch landed (signature entered by the
   * operator, NOT verified on chain from here) and that the operator approved
   * the owner's brief. Opens the funding account with the create fee and
   * creates the RAM's owned slot.
   */
  function confirmLaunch(id, { signature, briefApproved }) {
    const ram = mustGet(id);
    if (ram.status !== 'awaiting-signature') throw new Error(`RAM ${id} is ${ram.status}; only a RAM awaiting its signature can be confirmed`);
    if (!isSignature(signature)) throw new TypeError('signature must be a base58 transaction signature');
    if (briefApproved !== true) throw new Error("the operator must approve the owner's brief (briefApproved: true) before the RAM runs");
    if ([...rams.values()].some((r) => r.launchSignature === signature)) throw new Error('that signature is already recorded for a RAM');

    funds.open(id, ram.owner);
    funds.credit(id, { kind: 'create-fee', lamports: ram.createFeeLamports, ref: signature, note: 'RAM create fee, paid in the launch transaction' });
    const slot = slotManager.createOwnedSlot({ ramId: id, owner: ram.owner, track: ram.track, approach: ram.approach, model: ram.model, brief: ram.approachDetail });
    ram.launchSignature = signature;
    ram.briefApproved = true;
    ram.slotId = slot.id;
    touch(ram, 'active');
    return copy(ram);
  }

  function cancel(id) {
    const ram = mustGet(id);
    if (ram.status !== 'draft' && ram.status !== 'awaiting-signature') throw new Error(`RAM ${id} is ${ram.status}; it cannot be cancelled`);
    if (ram.token.mint) mintsInUse.delete(ram.token.mint);
    touch(ram, 'cancelled');
    return copy(ram);
  }

  /** Operator-only: creator fees reported for this RAM's token, credited to it alone. */
  function recordCreatorFees(id, { lamports, ref, note }) {
    const ram = mustGet(id);
    if (ram.status !== 'active') throw new Error(`RAM ${id} is not active`);
    return funds.credit(id, { kind: 'creator-fees', lamports, ref, note });
  }

  /**
   * Operator-only: this RAM's submission was ACCEPTED in HashSmash's judged
   * review. Writes an owed payout to the owner's wallet. Sends nothing.
   */
  function recordWin(id, { candidateRef, verdict, prizeLamports, evidence }) {
    const ram = mustGet(id);
    if (ram.status !== 'active') throw new Error(`RAM ${id} is not active`);
    return payouts.recordOwed({ ramId: id, wallet: ram.owner, lamports: prizeLamports, track: ram.track, candidateRef, verdict, evidence });
  }

  /** Token metadata JSON served at the RAM's metadata URI. */
  function metadata(id) {
    const ram = mustGet(id);
    if (ram.status === 'cancelled') throw new RangeError(`RAM ${id} was cancelled`);
    return {
      name: ram.token.name,
      symbol: ram.token.symbol,
      description: `RAMherd RAM ${ram.id}: an AI agent working on ${ram.hashFamily} (${ram.track}) with ${ram.model}. 100% of creator fees fund this RAM's compute via the RAMherd treasury.`,
      external_url: `${base}/api/launchpad/rams/${ram.id}`,
      attributes: [
        { trait_type: 'hash_family', value: ram.hashFamily },
        { trait_type: 'track', value: ram.track },
        { trait_type: 'approach', value: ram.approach },
        { trait_type: 'model', value: ram.model },
      ],
    };
  }

  function get(id) {
    return rams.has(id) ? copy(rams.get(id)) : undefined;
  }

  function list({ owner } = {}) {
    return [...rams.values()].filter((r) => !owner || r.owner === owner).map(copy);
  }

  return { createDraft, prepareLaunch, confirmLaunch, cancel, recordCreatorFees, recordWin, metadata, waitForMetadataPin, get, list };
}
