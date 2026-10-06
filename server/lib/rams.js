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
// Money: the RAM's funding account (ramfunds.js) gets the 0.01 SOL create fee
// on activation and any creator fees later reported for its token; a judged
// HashSmash win writes an owed payout to the owner's wallet (payouts.js).
// Nothing here can send, sign or claim anything.
//
// Persistence (opt-in with `persistPath`): the `rams` Map and `mintsInUse`
// are written to one JSON file on every real mutation and reloaded on
// construction, so a launched RAM survives a restart — see persist.js for the
// atomic-write mechanics and fly.toml for why this exists (two real launched
// tokens were silently wiped by routine restarts before this). Deliberately
// NOT persisted here, and still reset by a restart same as today:
//   - ramFunds / payouts (the RAM's funding account and any owed payouts):
//     out of scope for this pass; the RAM record itself (status, launch
//     signature, token info) survives, its money bookkeeping doesn't yet.
//   - slots.js's slot/sandbox state (feed history, pipeline, sandbox): pure
//     runtime state, never persisted. On reload, every rehydrated `active`
//     RAM gets a FRESH owned slot recreated via slotManager.createOwnedSlot
//     (idle, empty feed, no sandbox) so the RAM still resolves to a real
//     slot (src/ram-resolve.js expects an active RAM to always have one) and
//     the honest "no desk running, never started" messaging that already
//     exists (src/sandbox-viewer.js deskWhy) covers the rest correctly.
//   - unpinned (self-hosted) token images: images.js holds their bytes only
//     in memory and does not persist either, so a self-hosted image's URL
//     will 404 after a restart even though the RAM record survives; a
//     Pinata-pinned image's URL is external (IPFS gateway) and keeps working
//     regardless. metadata() below falls back to the RAM's own stored
//     token.image URL when the (also in-memory, unpersisted) images store no
//     longer has the id, so a pinned image's URL still reaches real clients
//     even though the images Map itself was never asked to survive a restart.

import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { CREATE_FEE_LAMPORTS, DEFAULT_TREASURY } from './launchtx.js';
import { createRateLimiter } from './ratelimit.js';
import { createImageStore, DEFAULT_IMAGE_PIN_RATE_LIMIT, DEFAULT_MAX_HELD_IMAGE_BYTES } from './images.js';
import { readJsonFile, writeJsonFileAtomic } from './persist.js';

export const RAM_STATUSES = Object.freeze(['draft', 'awaiting-signature', 'active', 'cancelled']);

/** pump.fun's create_v2 metadata URI limit. */
export const MAX_URI_LENGTH = 200;

// Global (all clients together, one fixed key) cap on Pinata pins. Every draft
// would otherwise pin attacker-chosen text to the operator's real Pinata
// account, limited only per IP. 20 per hour is far above real use today (the
// launchpad isn't live; a real launch is a 0.01 SOL, wallet-signed action) but
// stops an IP-rotating flood from burning the account's pin quota. A draft
// over the cap is still created; it just keeps its self-hosted metadata URI,
// exactly as when a pin fails.
export const DEFAULT_PIN_RATE_LIMIT = Object.freeze({ max: 20, windowMs: 60 * 60 * 1000 });

// Cap on non-active RAM records held in memory (drafts cost nothing to make).
// Past it, the oldest non-active record is evicted: draft/cancelled first,
// awaiting-signature only if nothing else is left; an `active` RAM (launched,
// paid for, has a slot and funding account) is never evicted.
export const DEFAULT_MAX_INACTIVE_RAMS = 1000;

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
 *   pinRateLimit?: { max: number, windowMs: number, now?: () => number },
 *   imagePinRateLimit?: { max: number, windowMs: number },
 *   maxHeldImageBytes?: number,
 *   maxInactiveRams?: number,
 *   onActivated?: (ram: object) => void,
 *   persistPath?: string|null,
 *   log?: (line: string) => void,
 * }} opts
 */
export function createRamRegistry({ slotManager, funds, payouts, publicBaseUrl, treasury = DEFAULT_TREASURY, createFeeLamports = CREATE_FEE_LAMPORTS, now = () => new Date().toISOString(), idPrefix = 'ram', pinata = null, pinRateLimit = DEFAULT_PIN_RATE_LIMIT, imagePinRateLimit = DEFAULT_IMAGE_PIN_RATE_LIMIT, maxHeldImageBytes = DEFAULT_MAX_HELD_IMAGE_BYTES, maxInactiveRams = DEFAULT_MAX_INACTIVE_RAMS, onActivated = null, persistPath = null, log = () => {} }) {
  if (typeof publicBaseUrl !== 'string' || !/^https?:\/\//.test(publicBaseUrl)) throw new TypeError('publicBaseUrl must be an http(s) URL');
  const base = publicBaseUrl.replace(/\/+$/, '');
  /** @type {Map<string, any>} */
  const rams = new Map();
  const mintsInUse = new Map();
  /** @type {Map<string, Promise<void>>} test-awaitable: see waitForMetadataPin() */
  const pinPromises = new Map();
  let seq = 0;
  if (!Number.isInteger(maxInactiveRams) || maxInactiveRams <= 0) throw new RangeError('maxInactiveRams must be a positive integer');
  // countDenied:false keeps this one global key's timestamp list at most `max` long under a flood.
  const pinLimiter = pinata ? createRateLimiter({ ...pinRateLimit, countDenied: false }) : null;
  // Token images (images.js): pinned with the same Pinata client under their
  // own global cap, or held here and self-hosted when they can't be.
  const images = createImageStore({ publicBaseUrl: base, pinata, pinRateLimit: imagePinRateLimit, maxHeldBytes: maxHeldImageBytes, now });

  const copy = (r) => JSON.parse(JSON.stringify(r));

  /**
   * Writes the full current state (every RAM record, the mint reservations,
   * and the id counter) to `persistPath` as one JSON file, atomically.
   * No-op when `persistPath` is null (persistence not configured — the
   * default, and every existing test). Called after every mutation below;
   * see the module header for exactly what is, and isn't, included.
   */
  function persist() {
    if (!persistPath) return;
    writeJsonFileAtomic(persistPath, { version: 1, seq, rams: [...rams.values()], mintsInUse: [...mintsInUse.entries()] }, { log });
  }

  // Rehydrate from disk, if configured, before anything else below touches
  // `rams`/`mintsInUse`/`seq`. A missing file (first boot, or local dev with
  // no data dir) or a corrupt/foreign one both leave this registry exactly
  // as empty as it is without persistence at all — readJsonFile has already
  // logged the latter loudly; never a reason to fail construction.
  if (persistPath) {
    const loaded = readJsonFile(persistPath, { log });
    if (loaded && Array.isArray(loaded.rams)) {
      for (const ram of loaded.rams) {
        if (ram && typeof ram.id === 'string') rams.set(ram.id, ram);
      }
      for (const entry of Array.isArray(loaded.mintsInUse) ? loaded.mintsInUse : []) {
        const [mint, id] = entry;
        if (typeof mint === 'string' && typeof id === 'string') mintsInUse.set(mint, id);
      }
      if (Number.isInteger(loaded.seq) && loaded.seq > seq) seq = loaded.seq;
      // Slots are pure runtime state and were never persisted (see header):
      // every rehydrated `active` RAM gets a fresh owned slot so it still
      // resolves to a real one (ram-resolve.js expects that), idle and with
      // no sandbox — the existing "no desk running, never started" messaging
      // (sandbox-viewer.js deskWhy) is honest for that on its own, with no
      // special-casing needed here. Funds/payouts intentionally stay as they
      // were (reset): recreating the slot must never replay confirmLaunch's
      // money side, so it calls the slot manager directly, not confirmLaunch.
      let recreated = 0;
      for (const ram of rams.values()) {
        if (ram.status !== 'active') continue;
        try {
          const slot = slotManager.createOwnedSlot({ ramId: ram.id, owner: ram.owner, track: ram.track, approach: ram.approach, model: ram.model, brief: ram.approachDetail });
          ram.slotId = slot.id;
          recreated++;
        } catch (err) {
          // One bad/inconsistent record must never block the rest from
          // rehydrating or stop the server booting: the RAM stays visible
          // (Discover, GET /api/launchpad/rams) with its real launch
          // signature; only its own slot page would 404 until fixed by hand.
          log(`rams: could not recreate the owned slot for ${ram.id} on boot, continuing without it: ${err?.message || err}`);
        }
      }
      log(`rams: rehydrated ${rams.size} RAM record(s) from ${persistPath} (${recreated} active slot(s) recreated).`);
      persist(); // write back the new slot ids (and seq) now, not only on the next mutation
    } else if (loaded) {
      log(`rams: ${persistPath} did not have the expected shape ({ rams: [...] }), starting empty.`);
    }
  }

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

  function evict(ram) {
    if (ram.token.mint && mintsInUse.get(ram.token.mint) === ram.id) mintsInUse.delete(ram.token.mint);
    pinPromises.delete(ram.id);
    rams.delete(ram.id);
  }

  /** Makes room for one more non-active record, never touching an active RAM. */
  function evictForNewDraft() {
    let inactive = 0;
    for (const r of rams.values()) if (r.status !== 'active') inactive++;
    while (inactive >= maxInactiveRams) {
      let victim = null;
      let fallback = null;
      for (const r of rams.values()) {
        if (r.status === 'draft' || r.status === 'cancelled') { victim = r; break; }
        if (!fallback && r.status === 'awaiting-signature') fallback = r;
      }
      victim = victim || fallback;
      if (!victim) break;
      evict(victim);
      inactive--;
    }
  }

  /** @param {ReturnType<typeof import('./launchpad.js').validateCreateRequest>['value']} value - already validated */
  function createDraft(value) {
    // Every pump.fun token needs an image, uploaded first (uploadImage) so the
    // metadata pinned below already carries it. Checked before an id is used.
    if (typeof value.image !== 'string' || !value.image) throw new TypeError('a token image is required');
    const image = images.get(value.image);
    if (!image) throw new RangeError(`unknown image id: ${value.image}`);
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
      token: { name: value.tokenName, symbol: value.tokenSymbol, uri, mint: null, imageId: image.id, image: image.url },
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
    evictForNewDraft();
    rams.set(id, ram);
    images.claim(image.id, 'drafted');
    // Pinata, if configured: pin the real metadata JSON to IPFS and swap the
    // token's uri from this server's own endpoint to the pinned gateway URL.
    // Fire-and-forget on purpose -- createDraft stays synchronous (callers
    // and every existing test are unaffected), and a Pinata hiccup (rate
    // limit, network) never blocks or fails a draft: the self-hosted URI it
    // already has keeps working. waitForMetadataPin(id) lets a test or an
    // operator await the real outcome deterministically instead of racing it.
    if (pinata && pinLimiter.hit('pinata').allowed) {
      const pinned = pinata
        .pinJson(metadata(id), { name: `${ram.token.symbol}-${id}-metadata` })
        .then(({ cid, uri }) => {
          if (uri.length <= MAX_URI_LENGTH) {
            ram.token.uri = uri;
            ram.token.metadataCid = cid;
            ram.updatedAt = now();
            persist(); // the metadata URI changed after createDraft's own persist() already ran
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
    persist();
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
    persist();
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
    images.claim(ram.token.imageId, 'kept');
    // Store hook (store.js raises the roster ceiling by one per confirmed
    // launch). Runs only after the RAM is fully active; a throwing hook must
    // never undo or fail a launch that already happened, so it is contained.
    if (onActivated) {
      try {
        onActivated(copy(ram));
      } catch {
        // The launch stands; the hook's own state is the hook's problem.
      }
    }
    persist();
    return copy(ram);
  }

  function cancel(id) {
    const ram = mustGet(id);
    if (ram.status !== 'draft' && ram.status !== 'awaiting-signature') throw new Error(`RAM ${id} is ${ram.status}; it cannot be cancelled`);
    if (ram.token.mint) mintsInUse.delete(ram.token.mint);
    touch(ram, 'cancelled');
    persist();
    return copy(ram);
  }

  /** Operator-only: creator fees reported for this RAM's token, credited to it alone. */
  function recordCreatorFees(id, { lamports, ref, note }) {
    const ram = mustGet(id);
    if (ram.status !== 'active') throw new Error(`RAM ${id} is not active`);
    const result = funds.credit(id, { kind: 'creator-fees', lamports, ref, note });
    persist(); // funds/payouts aren't persisted (see header), but matches the spec's write-through list
    return result;
  }

  /**
   * Operator-only: this RAM's submission was ACCEPTED in HashSmash's judged
   * review. Writes an owed payout to the owner's wallet. Sends nothing.
   */
  function recordWin(id, { candidateRef, verdict, prizeLamports, evidence }) {
    const ram = mustGet(id);
    if (ram.status !== 'active') throw new Error(`RAM ${id} is not active`);
    const result = payouts.recordOwed({ ramId: id, wallet: ram.owner, lamports: prizeLamports, track: ram.track, candidateRef, verdict, evidence });
    persist(); // funds/payouts aren't persisted (see header), but matches the spec's write-through list
    return result;
  }

  /**
   * The token's "website": this RAM's own page on the herd board. Keyed by the
   * launchpad RAM id (e.g. ram-0001), NOT its slot id, on purpose: metadata is
   * built (and, with Pinata, pinned immutably to IPFS) at draft time, but the
   * slot id only exists once confirmLaunch creates the owned slot. The herd
   * page resolves a launchpad id itself (src/ram-resolve.js): before launch it
   * shows an honest "not launched yet" page, after launch it settles on the
   * real slot's page. So this one link is right before and after confirmation.
   */
  function pageUrl(id) {
    return `${base}/herd#ram/${encodeURIComponent(id)}`;
  }

  /** True for this server's own self-hosted image URL shape (never for a Pinata gateway URL). */
  const isSelfHostedImageUrl = (url) => typeof url === 'string' && url.startsWith(`${base}/api/launchpad/images/`);

  /**
   * Token metadata JSON served at the RAM's metadata URI. `image` is the
   * token's logo: the Pinata gateway URL when the image was pinned, else this
   * server's own /api/launchpad/images/<id>. Looked up from the (in-memory,
   * never persisted) images store first, so an in-process eviction (memory
   * pressure, see images.js) is reflected at once. If that store doesn't
   * have it — after a restart, images.js's whole Map is always empty
   * regardless of pinned/self-hosted (see rams.js's header), since it is
   * never persisted either — falls back to the RAM record's own stored
   * token.image, but ONLY when that URL is an external (Pinata) one: a
   * self-hosted URL is never resurrected from the record, pinned or not,
   * because the bytes behind it are genuinely gone and it would just 404.
   * That keeps a Pinata-pinned image's real, always-valid URL in the
   * metadata after a restart, while staying exactly as honest as before
   * about a self-hosted image that no longer has bytes to serve.
   */
  function metadata(id) {
    const ram = mustGet(id);
    if (ram.status === 'cancelled') throw new RangeError(`RAM ${id} was cancelled`);
    const image = ram.token.imageId ? images.get(ram.token.imageId) : undefined;
    const imageUrl = image ? image.url : (!isSelfHostedImageUrl(ram.token.image) ? ram.token.image : undefined);
    return {
      name: ram.token.name,
      symbol: ram.token.symbol,
      description: `HashRammers RAM ${ram.id}: an AI agent working on ${ram.hashFamily} (${ram.track}) with ${ram.model}. 100% of creator fees fund this RAM's compute via the HashRammers treasury.`,
      ...(imageUrl ? { image: imageUrl } : {}),
      external_url: pageUrl(ram.id),
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

  return {
    createDraft,
    prepareLaunch,
    confirmLaunch,
    cancel,
    recordCreatorFees,
    recordWin,
    metadata,
    waitForMetadataPin,
    get,
    list,
    /** Validates + stores a token image (images.js); throws ImageError on a refusal. */
    uploadImage: (bytes) => images.upload(bytes),
    getImage: (imageId) => images.get(imageId),
    imageFile: (imageId) => images.file(imageId),
    /** Where this registry persists (null = in-memory only, every restart resets it). */
    persistPath,
    stop: () => {
      pinLimiter?.stop();
      images.stop();
    },
  };
}
