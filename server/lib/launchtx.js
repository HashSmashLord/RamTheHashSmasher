// Launchpad: builds the UNSIGNED atomic launch transaction a user's own wallet
// signs. Nothing in this module holds, loads, derives or asks for a private
// key, and nothing here signs, sends or broadcasts anything. It only turns
// public keys and strings into a transaction object (and back, for checking).
//
// The launch is one v0 transaction, in this order:
//   1. System transfer: user -> treasury, the 0.2 SOL RAM creation fee.
//   2. pump `create_v2`: the user's token, creator = the user, user = payer.
//   3. pump-fees `create_fee_sharing_config`: makes the coin's creator the
//      per-mint fee-sharing config (signed by the creator, i.e. the user).
//   4. pump-fees `update_fee_shares`: the only shareholder is the treasury at
//      10000 bps. pump.fun allows this once, so the routing is locked.
// Because the four are atomic, the coin can never exist with its creator fees
// routed anywhere but the treasury, and the fee is only paid if the coin is.
//
// Instruction encoding comes from pump.fun's official SDK (@pump-fun/pump-sdk,
// which encodes from pump's own IDLs), not from hand-written byte layouts.
// Required signers are exactly two: the user's wallet (Phantom) and the
// throwaway mint keypair, which the user's BROWSER generates and signs with.
// The server only ever sees the mint's public key.
//
// Size: the four instructions touch 27 accounts. As a plain message that is
// ~1310 bytes, over Solana's 1232-byte packet limit (measured; devnet's RPC
// refuses it). It fits only as a v0 message with an address lookup table
// holding the launch's static accounts (`launchLookupTableAddresses`).
// Creating that table is a one-time on-chain action the operator signs; it is
// out of scope here. Without a table, `compileLaunchTransaction` refuses with
// the measured size instead of returning something that cannot be sent.

import { createHash } from 'node:crypto';
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
  Keypair,
} from '@solana/web3.js';
import { PUMP_SDK, PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID } from '@pump-fun/pump-sdk';

/** The operator's treasury (docs/PRD.md, "Decided"). Public address only. */
export const DEFAULT_TREASURY = '5M6Pc7ossZ8cuQAjnexH9vv2axEJoncgZ3C6uD2PJqHm';
/** 0.2 SOL, in lamports. */
export const CREATE_FEE_LAMPORTS = 200_000_000;
/** Solana's max serialized transaction size (one packet). */
export const MAX_TX_BYTES = 1232;
/** Basis points that make 100%. */
export const FULL_SHARE_BPS = 10_000;
/**
 * name + symbol + uri byte total that makes the Token-2022 mint exactly 355
 * bytes, the SPL Multisig account size, which Token-2022 pads by one byte.
 * Observed on devnet (2026-10-05): at exactly this total, pump's create_v2
 * leaves the mint short of rent (InsufficientFundsForRent on the mint); 35,
 * 36, 38, 39 and 111 all simulate cleanly. Mint length = 318 + total there.
 */
export const MULTISIG_EDGE_METADATA_BYTES = 37;

/** Programs a launch transaction may invoke at the top level. Nothing else. */
export const ALLOWED_PROGRAMS = Object.freeze([
  SystemProgram.programId.toBase58(),
  PUMP_PROGRAM_ID.toBase58(),
  PUMP_FEE_PROGRAM_ID.toBase58(),
]);

export const LAUNCH_STEPS = Object.freeze(['create-fee', 'create_v2', 'create_fee_sharing_config', 'update_fee_shares']);

/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
export function anchorDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

const DISC = {
  create_v2: anchorDiscriminator('create_v2'),
  create_fee_sharing_config: anchorDiscriminator('create_fee_sharing_config'),
  update_fee_shares: anchorDiscriminator('update_fee_shares'),
};

export class LaunchTxError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LaunchTxError';
    this.code = code;
    Object.assign(this, details);
  }
}

function toKey(value, field) {
  if (value instanceof PublicKey) return value;
  try {
    return new PublicKey(value);
  } catch {
    throw new LaunchTxError('invalid_key', `${field} is not a valid Solana public key`);
  }
}

/**
 * Builds the four launch instructions, in order, labeled. Pure: public keys
 * and strings in, instructions out. No network, no keys.
 *
 * @param {{ user: string|PublicKey, mint: string|PublicKey, treasury?: string|PublicKey,
 *           name: string, symbol: string, uri: string, createFeeLamports?: number }} p
 * @returns {Promise<Array<{ label: string, instruction: import('@solana/web3.js').TransactionInstruction }>>}
 */
export async function buildLaunchInstructions({ user, mint, treasury = DEFAULT_TREASURY, name, symbol, uri, createFeeLamports = CREATE_FEE_LAMPORTS }) {
  const userKey = toKey(user, 'user');
  const mintKey = toKey(mint, 'mint');
  const treasuryKey = toKey(treasury, 'treasury');
  if (userKey.equals(treasuryKey)) throw new LaunchTxError('invalid_key', 'user must not be the treasury');
  if (mintKey.equals(userKey) || mintKey.equals(treasuryKey)) throw new LaunchTxError('invalid_key', 'mint must be a fresh key');
  if (!Number.isSafeInteger(createFeeLamports) || createFeeLamports <= 0) {
    throw new LaunchTxError('invalid_fee', 'createFeeLamports must be a positive integer');
  }
  for (const [field, value] of Object.entries({ name, symbol, uri })) {
    if (typeof value !== 'string' || !value.length) throw new LaunchTxError('invalid_meta', `${field} must be a non-empty string`);
  }
  if (Buffer.byteLength(name) + Buffer.byteLength(symbol) + Buffer.byteLength(uri) === MULTISIG_EDGE_METADATA_BYTES) {
    throw new LaunchTxError('invalid_meta', `name + symbol + uri must not total exactly ${MULTISIG_EDGE_METADATA_BYTES} bytes (pump's create_v2 under-funds that mint size)`);
  }

  return [
    {
      label: 'create-fee',
      instruction: SystemProgram.transfer({ fromPubkey: userKey, toPubkey: treasuryKey, lamports: createFeeLamports }),
    },
    {
      label: 'create_v2',
      instruction: await PUMP_SDK.createV2Instruction({
        mint: mintKey,
        name,
        symbol,
        uri,
        creator: userKey,
        user: userKey,
        mayhemMode: false,
      }),
    },
    {
      label: 'create_fee_sharing_config',
      instruction: await PUMP_SDK.createFeeSharingConfig({ creator: userKey, mint: mintKey, pool: null }),
    },
    {
      label: 'update_fee_shares',
      // Right after create_fee_sharing_config the creator is the only
      // shareholder (100%); that's the `currentShareholders` list. The new
      // list is the treasury alone, at 100%. Simulated on devnet: succeeds.
      instruction: await PUMP_SDK.updateFeeShares({
        authority: userKey,
        mint: mintKey,
        currentShareholders: [userKey],
        newShareholders: [{ address: treasuryKey, shareBps: FULL_SHARE_BPS }],
      }),
    },
  ];
}

/**
 * The accounts a launch lookup table must hold: every account that is the
 * same in every launch (programs' PDAs, global state, the treasury, token
 * programs...), found by building two launches for unrelated random keys and
 * keeping what they share. User-, mint- and per-coin PDAs differ per launch
 * and can never be in a static table. Top-level program ids are excluded by
 * the v0 compiler anyway (they must stay static).
 *
 * The random keys below are public keys of throwaway keypairs, used only as
 * placeholders. Their secret halves are discarded and never sign anything.
 *
 * @param {{ treasury?: string|PublicKey }} [p]
 * @returns {Promise<string[]>} base58 addresses, sorted.
 */
export async function launchLookupTableAddresses({ treasury = DEFAULT_TREASURY } = {}) {
  const sample = async () => {
    const ixs = await buildLaunchInstructions({
      user: Keypair.generate().publicKey,
      mint: Keypair.generate().publicKey,
      treasury,
      name: 'x',
      symbol: 'X',
      uri: 'x',
    });
    const keys = new Set();
    for (const { instruction } of ixs) for (const k of instruction.keys) if (!k.isSigner) keys.add(k.pubkey.toBase58());
    return keys;
  };
  const [a, b] = [await sample(), await sample()];
  const top = new Set(ALLOWED_PROGRAMS);
  return [...a].filter((k) => b.has(k) && !top.has(k)).sort();
}

/**
 * Wraps a table's addresses as the lookup-table account the v0 compiler wants.
 * The table's on-chain address is supplied by config once the operator has
 * created it; tests use a placeholder address with the same contents.
 */
export function lookupTableAccount(tableAddress, addresses) {
  return new AddressLookupTableAccount({
    key: toKey(tableAddress, 'lookupTable'),
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: addresses.map((a) => toKey(a, 'lookup table address')),
    },
  });
}

/**
 * Compiles labeled instructions into an UNSIGNED v0 transaction, fee payer =
 * the user. Refuses (LaunchTxError 'too_large') when the result would not fit
 * in one packet, reporting the measured size.
 *
 * @param {{ instructions: Array<{ label: string, instruction: any }>, payer: string|PublicKey,
 *           recentBlockhash: string, lookupTables?: AddressLookupTableAccount[] }} p
 */
export function compileLaunchTransaction({ instructions, payer, recentBlockhash, lookupTables = [] }) {
  if (typeof recentBlockhash !== 'string' || !recentBlockhash) {
    throw new LaunchTxError('invalid_blockhash', 'recentBlockhash is required');
  }
  const message = new TransactionMessage({
    payerKey: toKey(payer, 'payer'),
    recentBlockhash,
    instructions: instructions.map((i) => i.instruction),
  }).compileToV0Message(lookupTables);
  const transaction = new VersionedTransaction(message);
  // A VersionedTransaction serializes with zeroed signature slots: unsigned.
  const bytes = transaction.serialize();
  if (bytes.length > MAX_TX_BYTES) {
    throw new LaunchTxError('too_large', `launch transaction is ${bytes.length} bytes, over the ${MAX_TX_BYTES}-byte limit${lookupTables.length ? '' : '; it needs the launch address lookup table'}`, {
      sizeBytes: bytes.length,
    });
  }
  return {
    transaction,
    bytes,
    base64: Buffer.from(bytes).toString('base64'),
    sizeBytes: bytes.length,
    requiredSigners: message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((k) => k.toBase58()),
    labels: instructions.map((i) => i.label),
  };
}

function readBorshString(buf, offset) {
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  if (start + len > buf.length) throw new LaunchTxError('malformed', 'string runs past instruction data');
  return { value: buf.subarray(start, start + len).toString('utf8'), next: start + len };
}

/**
 * Decodes and checks an unsigned (or signed) launch transaction against what
 * this RAM's launch must be. This is the "reject it if a single byte changed"
 * check: anything that is not exactly the four expected instructions, from the
 * allowed programs, paying the treasury the create fee and routing 100% of
 * creator fees to the treasury, with exactly the user and mint as signers,
 * fails with a list of reasons.
 *
 * @param {string|Uint8Array} serialized - base64 string or raw bytes.
 * @param {{ user: string, mint: string, treasury?: string, createFeeLamports?: number,
 *           name?: string, symbol?: string, uri?: string,
 *           lookupTables?: AddressLookupTableAccount[] }} expected
 */
export function inspectLaunchTransaction(serialized, expected) {
  const bytes = typeof serialized === 'string' ? Buffer.from(serialized, 'base64') : Buffer.from(serialized);
  const problems = [];
  const treasury = expected.treasury ?? DEFAULT_TREASURY;
  const createFeeLamports = expected.createFeeLamports ?? CREATE_FEE_LAMPORTS;

  let tx;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch (err) {
    return { ok: false, problems: [`does not deserialize: ${err.message}`] };
  }
  if (bytes.length > MAX_TX_BYTES) problems.push(`size ${bytes.length} > ${MAX_TX_BYTES}`);
  const msg = tx.message;
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: expected.lookupTables ?? [] });
  const signers = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());

  if (signers[0] !== expected.user) problems.push(`fee payer is ${signers[0]}, expected the user`);
  const wantSigners = new Set([expected.user, expected.mint]);
  if (signers.length !== 2 || !signers.every((s) => wantSigners.has(s))) {
    problems.push(`required signers are [${signers.join(', ')}], expected exactly the user and the mint`);
  }
  if (signers.includes(treasury)) problems.push('the treasury must never be a signer');

  const ixs = msg.compiledInstructions.map((ci) => ({
    programId: keys.get(ci.programIdIndex).toBase58(),
    accounts: ci.accountKeyIndexes.map((i) => keys.get(i).toBase58()),
    data: Buffer.from(ci.data),
  }));
  const decoded = [];
  if (ixs.length !== LAUNCH_STEPS.length) problems.push(`has ${ixs.length} instructions, expected ${LAUNCH_STEPS.length}`);
  for (const ix of ixs) if (!ALLOWED_PROGRAMS.includes(ix.programId)) problems.push(`invokes a program outside the allowlist: ${ix.programId}`);

  const [xfer, create, cfg, upd] = ixs;
  // 1. create fee: System transfer (index 2) user -> treasury, exact lamports.
  if (xfer) {
    const ok = xfer.programId === SystemProgram.programId.toBase58() && xfer.data.length === 12 && xfer.data.readUInt32LE(0) === 2;
    const lamports = ok ? Number(xfer.data.readBigUInt64LE(4)) : null;
    decoded.push({ step: 'create-fee', from: xfer.accounts[0], to: xfer.accounts[1], lamports });
    if (!ok) problems.push('step 1 is not a System transfer');
    else {
      if (xfer.accounts[0] !== expected.user) problems.push('create fee is not paid from the user');
      if (xfer.accounts[1] !== treasury) problems.push(`create fee goes to ${xfer.accounts[1]}, not the treasury`);
      if (lamports !== createFeeLamports) problems.push(`create fee is ${lamports} lamports, expected ${createFeeLamports}`);
    }
  }
  // 2. create_v2: creator arg = user, mint account = mint, user account = user.
  if (create) {
    const isCreate = create.programId === PUMP_PROGRAM_ID.toBase58() && create.data.subarray(0, 8).equals(DISC.create_v2);
    if (!isCreate) problems.push('step 2 is not pump create_v2');
    else {
      try {
        const n = readBorshString(create.data, 8);
        const s = readBorshString(create.data, n.next);
        const u = readBorshString(create.data, s.next);
        const creator = new PublicKey(create.data.subarray(u.next, u.next + 32)).toBase58();
        decoded.push({ step: 'create_v2', name: n.value, symbol: s.value, uri: u.value, creator, mint: create.accounts[0], user: create.accounts[5] });
        if (creator !== expected.user) problems.push(`create_v2 creator is ${creator}, expected the user`);
        if (create.accounts[0] !== expected.mint) problems.push('create_v2 mint is not the expected mint');
        if (create.accounts[5] !== expected.user) problems.push('create_v2 user is not the expected user');
        for (const f of ['name', 'symbol', 'uri']) {
          if (expected[f] !== undefined && decoded.at(-1)[f] !== expected[f]) problems.push(`create_v2 ${f} does not match the RAM`);
        }
      } catch (err) {
        problems.push(`create_v2 data does not decode: ${err.message}`);
      }
    }
  }
  // 3. create_fee_sharing_config: payer (accounts[2]) = user, mint (accounts[4]).
  if (cfg) {
    const isCfg = cfg.programId === PUMP_FEE_PROGRAM_ID.toBase58() && cfg.data.equals(DISC.create_fee_sharing_config);
    decoded.push({ step: 'create_fee_sharing_config', payer: cfg.accounts[2], mint: cfg.accounts[4] });
    if (!isCfg) problems.push('step 3 is not pump-fees create_fee_sharing_config');
    else if (cfg.accounts[2] !== expected.user || cfg.accounts[4] !== expected.mint) problems.push('create_fee_sharing_config is not for this user and mint');
  }
  // 4. update_fee_shares: authority (accounts[2]) = user; shareholders = [treasury @ 10000].
  if (upd) {
    const isUpd = upd.programId === PUMP_FEE_PROGRAM_ID.toBase58() && upd.data.subarray(0, 8).equals(DISC.update_fee_shares);
    if (!isUpd) problems.push('step 4 is not pump-fees update_fee_shares');
    else {
      const count = upd.data.readUInt32LE(8);
      const shareholders = [];
      for (let i = 0; i < count && 12 + (i + 1) * 34 <= upd.data.length; i++) {
        const at = 12 + i * 34;
        shareholders.push({ address: new PublicKey(upd.data.subarray(at, at + 32)).toBase58(), shareBps: upd.data.readUInt16LE(at + 32) });
      }
      decoded.push({ step: 'update_fee_shares', authority: upd.accounts[2], mint: upd.accounts[4], shareholders });
      if (upd.data.length !== 12 + count * 34) problems.push('update_fee_shares data has an unexpected length');
      if (upd.accounts[2] !== expected.user || upd.accounts[4] !== expected.mint) problems.push('update_fee_shares is not for this user and mint');
      if (shareholders.length !== 1 || shareholders[0].address !== treasury || shareholders[0].shareBps !== FULL_SHARE_BPS) {
        problems.push(`creator fees are not routed 100% to the treasury: ${JSON.stringify(shareholders)}`);
      }
    }
  }

  return { ok: problems.length === 0, problems, signers, sizeBytes: bytes.length, instructions: decoded };
}

export function lamportsToSol(lamports) {
  return lamports / LAMPORTS_PER_SOL;
}
