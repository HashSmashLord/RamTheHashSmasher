// HTTP routes for the launchpad (user-created RAMs). Kept out of app.js so
// the core API file stays small; app.js calls `handlePublic` / `handleAdmin`.
//
// Public:
//   GET  /api/launchpad/config                 static catalog + honest status
//   POST /api/launchpad/images                 the token image (raw bytes, Content-Type image/*)
//   GET  /api/launchpad/images/:id             a self-hosted token image (pinned ones redirect)
//   POST /api/launchpad/rams                   validate + store a draft RAM (needs an image id)
//   GET  /api/launchpad/rams?owner=<wallet>    list RAMs (optionally by owner)
//   GET  /api/launchpad/rams/:id               one RAM, with its funding totals
//   GET  /api/launchpad/rams/:id/metadata.json the token's metadata (its create_v2 uri)
//   POST /api/launchpad/rams/:id/transaction   build the UNSIGNED launch tx for {mint}
//   POST /api/launchpad/rams/:id/report-signature  {signature} the wallet's own browser calls
//        this right after sendRawTransaction(); verifies the signature on chain for real
//        (launchverify.js) and, only if it checks out, activates the RAM itself -- no operator
//        has to find the signature and POST the admin /confirm route by hand. Still idempotent
//        and still a 409/202/502/400 (never a silent pass) when the chain disagrees or hasn't
//        caught up yet. The admin /confirm route below still exists for a launch this missed
//        (e.g. the browser tab closed before the report call went out).
//   GET  /api/launchpad/payouts?wallet=<w>     owed/sent payout records
// Admin (x-admin-token, checked by app.js before handleAdmin runs):
//   POST /api/admin/launchpad/rams/:id/confirm       {signature, briefApproved:true}
//   POST /api/admin/launchpad/rams/:id/cancel
//   POST /api/admin/launchpad/rams/:id/creator-fees  {lamports, ref?, note?}
//   POST /api/admin/launchpad/rams/:id/compute       {usd, ref?, note?}
//   POST /api/admin/launchpad/rams/:id/win           {candidateRef, verdict:'accepted', prizeLamports, evidence?}
//   POST /api/admin/launchpad/payouts/:id/sent       {signature, note?}  (annotates; sends nothing)
//
// Nothing here signs or sends a transaction. The transaction route returns
// bytes for the user's own wallet to sign; the server never sees a key.

import { PublicKey } from '@solana/web3.js';
import { validateCreateRequest, launchpadCatalog } from './lib/launchpad.js';
import {
  buildLaunchInstructions,
  compileLaunchTransaction,
  inspectLaunchTransaction,
  launchLookupTableAddresses,
  LaunchTxError,
  CREATE_FEE_LAMPORTS,
  lamportsToSol,
} from './lib/launchtx.js';
import { createRateLimiter } from './lib/ratelimit.js';
import { ImageError, MAX_IMAGE_BYTES } from './lib/images.js';
import { verifyLaunchSignature } from './lib/launchverify.js';

// Any valid 32-byte base58 value works for measuring size; this one is the
// System Program id. Used only when no table exists, to report the real size.
const PLACEHOLDER_BLOCKHASH = '11111111111111111111111111111111';

/** Read-only RPC access (blockhash + lookup table). Lazily connects. */
export function createSolanaClient(rpcUrl) {
  let connection = null;
  async function conn() {
    if (!connection) {
      const { Connection } = await import('@solana/web3.js');
      connection = new Connection(rpcUrl, 'confirmed');
    }
    return connection;
  }
  return {
    async getLatestBlockhash() {
      return (await (await conn()).getLatestBlockhash('confirmed')).blockhash;
    },
    async getLookupTable(address) {
      return (await (await conn()).getAddressLookupTable(new PublicKey(address))).value;
    },
    // jsonParsed, not the plain getTransaction(): launchverify.js's accountKeysOf() reads
    // message.accountKeys as [{pubkey, ...}], which only getParsedTransaction returns (plain
    // getTransaction's message is a compiled Message/VersionedMessage with no accountKeys at
    // all). See launchverify.js's own comment -- this exact mismatch is why that module
    // reported every real, finalized launch as a "mismatch" until both were fixed together.
    async getTransaction(signature) {
      return (await conn()).getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    },
  };
}

export function createLaunchpadRoutes({ store, config, sendOk, sendError, readJsonBody, readRawBody, clientKey }) {
  const lp = config.launchpad;
  try {
    if (new PublicKey(lp.treasury).toBase58() !== lp.treasury) throw new Error();
  } catch {
    throw new Error('TREASURY_WALLET is not a valid Solana address');
  }
  const solana = config.solanaClient ?? createSolanaClient(lp.rpcUrl);
  const limiter = createRateLimiter(config.launchpadRateLimit ?? { max: 20, windowMs: 10 * 60 * 1000 });
  const requiredTableAddresses = launchLookupTableAddresses({ treasury: lp.treasury });

  function status() {
    const live = Boolean(lp.liveRequested && lp.lookupTable);
    return {
      live,
      cluster: lp.cluster,
      // The browser's own signing connection (src/launch.js's signAndSendLaunch) needs this
      // directly: Solana Labs' public RPC (clusterApiUrl's default) refuses any browser-origin
      // request with a flat 403 "Access forbidden", by design, on every single real attempt.
      // Confirmed 2026-10-06 against the real endpoint with a real Origin header. This is
      // CORS-open and real-tested the same way; see README "Solana RPC" for the swap story.
      rpcUrl: lp.rpcUrl,
      treasury: lp.treasury,
      createFeeLamports: CREATE_FEE_LAMPORTS,
      createFeeSol: String(lamportsToSol(CREATE_FEE_LAMPORTS)),
      lookupTableConfigured: Boolean(lp.lookupTable),
      notLiveBecause: live
        ? null
        : [
            !lp.lookupTable && 'The launch needs an address lookup table the operator has not created yet (the full transaction is ~1330 bytes without it; the limit is 1232).',
            'No real Phantom wallet has signed a launch transaction yet; only its pump.fun instructions have been simulated on devnet.',
            'Launch confirmation and payouts are recorded by the operator by hand; nothing is verified on chain or paid automatically.',
          ].filter(Boolean),
    };
  }

  function rateLimited(req, res) {
    const verdict = limiter.hit(clientKey(req));
    if (verdict.allowed) return false;
    req.resume();
    sendError(res, 429, 'rate_limited', 'Too many launchpad requests from here. Please try again later.', { 'Retry-After': String(verdict.retryAfterSec) });
    return true;
  }

  function withFunding(ram) {
    const acct = store.ramFunds.get(ram.id);
    return { ...ram, funding: acct ? acct.totals : null };
  }

  async function postRam(req, res) {
    if (rateLimited(req, res)) return;
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const verdict = validateCreateRequest(body, { treasury: lp.treasury });
    if (!verdict.ok) {
      return sendError(res, 400, 'invalid_ram', 'Some answers need fixing before this RAM can be created.', undefined, { fields: verdict.fields });
    }
    if (!store.rams.getImage(verdict.value.image)) {
      // Well-formed id, but not one this server holds (never uploaded here, or
      // a self-hosted image dropped from memory / lost in a restart).
      return sendError(res, 400, 'invalid_ram', 'Some answers need fixing before this RAM can be created.', undefined, { fields: { image: 'That image is no longer on the server. Pick it again.' } });
    }
    sendOk(res, { ram: store.rams.createDraft(verdict.value) }, 201);
  }

  // The token image: the raw file is the whole body (no multipart: this page
  // and this server are the only two ends, and a raw body needs no parser).
  // Content-Type must be image/*, which a cross-site <form> cannot send
  // without a CORS preflight this server never answers. The declared type is
  // only a gate; the real type comes from the file's own signature.
  async function postImage(req, res) {
    if (rateLimited(req, res)) return;
    const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!declared.startsWith('image/')) {
      req.resume();
      return sendError(res, 415, 'invalid_image', 'Send the image file itself as the body, with its image/* Content-Type.', undefined, { fields: { image: 'That file is not a PNG, JPG, GIF or WEBP image.' } });
    }
    // A little over the cap so an exactly-at-cap file isn't refused by the reader
    // before validateImageBytes gives its friendlier per-field message.
    const bytes = await readRawBody(req, res, MAX_IMAGE_BYTES + 1);
    if (bytes === undefined) return;
    try {
      sendOk(res, { image: await store.rams.uploadImage(bytes) }, 201);
    } catch (err) {
      if (!(err instanceof ImageError)) throw err;
      if (err.code === 'image_storage_full') return sendError(res, 503, 'image_storage_full', err.message, { 'Retry-After': '600' });
      sendError(res, err.code === 'too_large' ? 413 : 400, err.code === 'too_large' ? 'too_large' : 'invalid_image', err.message, undefined, { fields: { image: err.message } });
    }
  }

  function getImage(res, imageId) {
    const held = store.rams.imageFile(imageId);
    if (held) {
      res.writeHead(200, {
        'Content-Type': held.type,
        'Content-Length': held.bytes.length,
        // Content-addressed id: these bytes never change under this URL.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      return res.end(held.bytes);
    }
    const pinned = store.rams.getImage(imageId);
    if (pinned?.pinned) {
      res.writeHead(302, { Location: pinned.url, 'Cache-Control': 'public, max-age=3600' });
      return res.end();
    }
    sendError(res, 404, 'not_found');
  }

  async function postTransaction(req, res, id) {
    if (rateLimited(req, res)) return;
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const ram = store.rams.get(id);
    if (!ram) return sendError(res, 404, 'not_found');
    if (ram.status !== 'draft' && ram.status !== 'awaiting-signature') {
      return sendError(res, 409, 'bad_request', `This RAM is ${ram.status}; there is nothing to sign.`);
    }
    if (typeof body.mint !== 'string') return sendError(res, 400, 'bad_request', 'Body must include the "mint" public key your browser generated.');

    let instructions;
    try {
      instructions = await buildLaunchInstructions({
        user: ram.owner,
        mint: body.mint,
        treasury: lp.treasury,
        name: ram.token.name,
        symbol: ram.token.symbol,
        uri: ram.token.uri,
        createFeeLamports: ram.createFeeLamports,
      });
    } catch (err) {
      if (err instanceof LaunchTxError) return sendError(res, 400, 'bad_request', err.message);
      throw err;
    }

    // No lookup table: measure honestly and refuse, without touching the network.
    if (!lp.lookupTable) {
      try {
        compileLaunchTransaction({ instructions, payer: ram.owner, recentBlockhash: PLACEHOLDER_BLOCKHASH });
      } catch (err) {
        if (err instanceof LaunchTxError && err.code === 'too_large') {
          return sendError(res, 409, 'lookup_table_required', `The launch transaction is ${err.sizeBytes} bytes; it only fits Solana's 1232-byte limit with the launch address lookup table, which has not been set up yet.`, undefined, { sizeBytes: err.sizeBytes });
        }
        throw err;
      }
      // Fits without a table (not the case with today's instruction set), so fall through.
    }

    let lookupTables = [];
    let recentBlockhash;
    try {
      if (lp.lookupTable) {
        const table = await solana.getLookupTable(lp.lookupTable);
        if (!table) return sendError(res, 409, 'lookup_table_missing', 'The configured launch lookup table was not found on chain.');
        const held = new Set(table.state.addresses.map((a) => a.toBase58()));
        const missing = (await requiredTableAddresses).filter((a) => !held.has(a));
        if (missing.length) return sendError(res, 409, 'lookup_table_incomplete', `The launch lookup table is missing ${missing.length} required address(es).`, undefined, { missing });
        lookupTables = [table];
      }
      recentBlockhash = await solana.getLatestBlockhash();
    } catch (err) {
      return sendError(res, 502, 'rpc_unavailable', `Could not reach the Solana RPC: ${err.message}`);
    }

    let compiled;
    try {
      compiled = compileLaunchTransaction({ instructions, payer: ram.owner, recentBlockhash, lookupTables });
    } catch (err) {
      if (err instanceof LaunchTxError && err.code === 'too_large') {
        return sendError(res, 409, 'lookup_table_required', err.message, undefined, { sizeBytes: err.sizeBytes });
      }
      throw err;
    }
    // Defense in depth: check our own bytes against the RAM before handing them out.
    const check = inspectLaunchTransaction(compiled.bytes, {
      user: ram.owner,
      mint: body.mint,
      treasury: lp.treasury,
      createFeeLamports: ram.createFeeLamports,
      name: ram.token.name,
      symbol: ram.token.symbol,
      uri: ram.token.uri,
      lookupTables,
    });
    if (!check.ok) throw new Error(`built launch transaction failed its own inspection: ${check.problems.join('; ')}`);

    let prepared;
    try {
      prepared = store.rams.prepareLaunch(id, body.mint);
    } catch (err) {
      return sendError(res, 400, 'bad_request', err.message);
    }
    sendOk(res, {
      ram: prepared,
      transaction: {
        base64: compiled.base64,
        version: 0,
        sizeBytes: compiled.sizeBytes,
        requiredSigners: compiled.requiredSigners,
        instructions: instructions.map((i) => ({ label: i.label, programId: i.instruction.programId.toBase58() })),
        recentBlockhash,
        lookupTable: lp.lookupTable,
        cluster: lp.cluster,
        signed: false,
      },
    });
  }

  /**
   * The client calls this itself right after `connection.sendRawTransaction(...)` lands (or
   * even just after it's sent -- a `not_found` answer here means "try again shortly", not
   * "failed"). Verifies the signature for real against the chain (launchverify.js) and, only
   * if it checks out, activates the RAM the same way the admin /confirm route does -- closing
   * the gap where every real launch needed an operator to find the signature and enter it by
   * hand. Never trusts the signature's shape alone, and never marks anything active on a
   * network error or an unconfirmed transaction.
   */
  async function postReportSignature(req, res, id) {
    if (rateLimited(req, res)) return;
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const ram = store.rams.get(id);
    if (!ram) return sendError(res, 404, 'not_found');
    if (typeof body.signature !== 'string' || !body.signature) {
      return sendError(res, 400, 'bad_request', 'Body must include the "signature" your wallet returned after sending the transaction.');
    }
    if (ram.status === 'active') {
      // Idempotent: the client retrying its own already-successful report is not an error.
      if (ram.launchSignature === body.signature) return sendOk(res, { ram });
      return sendError(res, 409, 'bad_request', `RAM ${id} is already active under a different signature.`);
    }
    if (ram.status !== 'awaiting-signature' || !ram.token.mint) {
      return sendError(res, 409, 'bad_request', `RAM ${id} is ${ram.status}; there is no pending launch transaction to verify.`);
    }

    const verdict = await verifyLaunchSignature(solana, body.signature, { mint: ram.token.mint, treasury: lp.treasury, owner: ram.owner });
    if (!verdict.ok) {
      // not_found: the transaction may simply not have landed/finalized yet -- 202 says so,
      // never a 4xx that would read as "that was wrong". Everything else is a real refusal.
      const httpStatus = verdict.code === 'not_found' ? 202 : verdict.code === 'rpc_error' ? 502 : 400;
      return sendError(res, httpStatus, verdict.code, verdict.reason);
    }

    let confirmed;
    try {
      // The free-text brief already passed screenIdea() at draft time (launchpad.js); the
      // operator's admin /confirm route exists for anything this endpoint doesn't catch.
      confirmed = store.rams.confirmLaunch(id, { signature: body.signature, briefApproved: true });
    } catch (err) {
      return sendError(res, 409, 'bad_request', err.message);
    }
    sendOk(res, { ram: confirmed });
  }

  /** @returns {Promise<boolean>} true when handled */
  async function handlePublic(req, res, { pathname, parts, method, query }) {
    if (parts[0] !== 'api' || parts[1] !== 'launchpad') return false;
    req.routeLabel = `api/launchpad/${parts.slice(2).map((p, i) => (i === 1 ? ':id' : p)).join('/')}`;
    if (pathname === '/api/launchpad/config' && method === 'GET') {
      sendOk(res, { launchpad: { ...status(), ...launchpadCatalog() } });
      return true;
    }
    if (pathname === '/api/launchpad/images' && method === 'POST') {
      await postImage(req, res);
      return true;
    }
    if (parts[2] === 'images' && parts.length === 4 && (method === 'GET' || method === 'HEAD')) {
      getImage(res, parts[3]);
      return true;
    }
    if (pathname === '/api/launchpad/rams' && method === 'POST') {
      await postRam(req, res);
      return true;
    }
    if (pathname === '/api/launchpad/rams' && method === 'GET') {
      const owner = query.get('owner') || undefined;
      sendOk(res, { rams: store.rams.list({ owner }).map(withFunding) });
      return true;
    }
    if (pathname === '/api/launchpad/payouts' && method === 'GET') {
      const wallet = query.get('wallet') || undefined;
      sendOk(res, { payouts: store.payouts.list({ wallet }) });
      return true;
    }
    if (parts[2] === 'rams' && parts.length === 4 && method === 'GET') {
      const ram = store.rams.get(parts[3]);
      if (!ram) sendError(res, 404, 'not_found');
      else sendOk(res, { ram: withFunding(ram) });
      return true;
    }
    if (parts[2] === 'rams' && parts.length === 5 && parts[4] === 'metadata.json' && method === 'GET') {
      try {
        const meta = store.rams.metadata(parts[3]);
        // Plain metadata JSON (no {ok} envelope): wallets and explorers read it as-is.
        const text = JSON.stringify(meta);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'public, max-age=60' });
        res.end(text);
      } catch {
        sendError(res, 404, 'not_found');
      }
      return true;
    }
    if (parts[2] === 'rams' && parts.length === 5 && parts[4] === 'transaction' && method === 'POST') {
      await postTransaction(req, res, parts[3]);
      return true;
    }
    if (parts[2] === 'rams' && parts.length === 5 && parts[4] === 'report-signature' && method === 'POST') {
      await postReportSignature(req, res, parts[3]);
      return true;
    }
    sendError(res, 404, 'not_found');
    return true;
  }

  /** Admin routes; app.js has already checked the admin token. */
  async function handleAdmin(req, res, { parts, method }) {
    if (parts[2] !== 'launchpad' || method !== 'POST') return false;
    const body = await readJsonBody(req, res);
    if (body === undefined) return true;
    const [, , , kind, id, action] = parts;
    try {
      if (kind === 'rams' && parts.length === 6) {
        if (!store.rams.get(id)) return sendError(res, 404, 'not_found'), true;
        if (action === 'confirm') return sendOk(res, { ram: store.rams.confirmLaunch(id, { signature: body.signature, briefApproved: body.briefApproved }) }), true;
        if (action === 'cancel') return sendOk(res, { ram: store.rams.cancel(id) }), true;
        if (action === 'creator-fees') return sendOk(res, { funding: store.rams.recordCreatorFees(id, { lamports: Number(body.lamports), ref: body.ref ?? null, note: body.note ?? '' }) }), true;
        if (action === 'compute') {
          if (store.rams.get(id).status !== 'active') return sendError(res, 409, 'bad_request', `RAM ${id} is not active.`), true;
          return sendOk(res, { funding: store.ramFunds.chargeCompute(id, { usd: Number(body.usd), ref: body.ref ?? null, note: body.note ?? '' }) }), true;
        }
        if (action === 'win') {
          const result = store.rams.recordWin(id, { candidateRef: body.candidateRef, verdict: body.verdict, prizeLamports: Number(body.prizeLamports), evidence: body.evidence ?? '' });
          return sendOk(res, { payout: result.record, created: result.created }, result.created ? 201 : 200), true;
        }
      }
      if (kind === 'payouts' && parts.length === 6 && action === 'sent') {
        if (!store.payouts.get(id)) return sendError(res, 404, 'not_found'), true;
        return sendOk(res, { payout: store.payouts.recordSent(id, { signature: body.signature, note: body.note ?? '' }) }), true;
      }
    } catch (err) {
      sendError(res, 400, 'bad_request', err.message);
      return true;
    }
    sendError(res, 404, 'not_found');
    return true;
  }

  return { handlePublic, handleAdmin, status, stop: () => limiter.stop() };
}
