// Unit tests for server/lib/launchverify.js: verifying a REAL on-chain launch signature
// against what a RAM's launch must be. Pure, with a fake connection -- no network.
//
// This module was written but never wired or tested before this session. Wiring it up
// (herd/server/launchpad-routes.js's new /report-signature route) surfaced a real bug: with a
// real @solana/web3.js Connection, accountKeysOf() read `pubkey` as a PublicKey instance, not
// a string, so every address comparison silently failed and every genuine, finalized launch
// came back "mismatch". These tests cover both the fixed comparison (string and {pubkey}
// shapes) and connectionAdapter's getParsedTransaction wiring, which is the other half of
// that same real bug (plain getTransaction's message has no accountKeys array at all).

import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyLaunchSignature, connectionAdapter, LaunchVerifyError } from '../server/lib/launchverify.js';

const MINT = 'Mint11111111111111111111111111111111111111';
const TREASURY = 'Treasury111111111111111111111111111111111';
const OWNER = 'Owner1111111111111111111111111111111111111';
const SIG = 'sig1';

function fakeTx({ keys = [OWNER, MINT, TREASURY], err = null, logs = ['Program log: Instruction: CreateV2'], pubkeyShape = 'string' } = {}) {
  return {
    meta: { err, logMessages: logs },
    transaction: {
      message: {
        accountKeys: keys.map((k) => (pubkeyShape === 'string' ? k : { pubkey: { toBase58: () => k } })),
      },
    },
  };
}

function fakeConnection(tx) {
  return { async getTransaction() { return tx; } };
}

test('verifyLaunchSignature: ok when mint, treasury and owner are all present with a real CreateV2 log', async () => {
  const result = await verifyLaunchSignature(fakeConnection(fakeTx()), SIG, { mint: MINT, treasury: TREASURY, owner: OWNER });
  assert.deepEqual(result, { ok: true });
});

test('verifyLaunchSignature: same thing, but accountKeys carries {pubkey} objects (PublicKey-shaped), not bare strings', async () => {
  const result = await verifyLaunchSignature(fakeConnection(fakeTx({ pubkeyShape: 'object' })), SIG, { mint: MINT, treasury: TREASURY, owner: OWNER });
  assert.deepEqual(result, { ok: true }, 'a PublicKey-shaped pubkey must be compared by its base58 address, not by reference');
});

test('verifyLaunchSignature: not_found when the signature has no transaction yet', async () => {
  const result = await verifyLaunchSignature(fakeConnection(null), SIG, { mint: MINT, treasury: TREASURY, owner: OWNER });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_found');
});

test('verifyLaunchSignature: failed when the transaction landed but errored on chain', async () => {
  const result = await verifyLaunchSignature(fakeConnection(fakeTx({ err: { InstructionError: [0, 'Custom'] } })), SIG, { mint: MINT, treasury: TREASURY, owner: OWNER });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed');
});

test('verifyLaunchSignature: mismatch when the mint is missing from the account keys', async () => {
  const result = await verifyLaunchSignature(fakeConnection(fakeTx({ keys: [OWNER, TREASURY] })), SIG, { mint: MINT, treasury: TREASURY, owner: OWNER });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'mismatch');
  assert.match(result.reason, /mint/);
});

test('verifyLaunchSignature: mismatch when the treasury is missing', async () => {
  const result = await verifyLaunchSignature(fakeConnection(fakeTx({ keys: [OWNER, MINT] })), SIG, { mint: MINT, treasury: TREASURY, owner: OWNER });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'mismatch');
  assert.match(result.reason, /treasury/);
});

test('verifyLaunchSignature: mismatch when the owner is missing', async () => {
  const result = await verifyLaunchSignature(fakeConnection(fakeTx({ keys: [MINT, TREASURY] })), SIG, { mint: MINT, treasury: TREASURY, owner: OWNER });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'mismatch');
  assert.match(result.reason, /owner/);
});

test('verifyLaunchSignature: mismatch when all three accounts are present but there is no CreateV2 instruction', async () => {
  const result = await verifyLaunchSignature(fakeConnection(fakeTx({ logs: ['Program log: Instruction: Transfer'] })), SIG, { mint: MINT, treasury: TREASURY, owner: OWNER });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'mismatch');
  assert.match(result.reason, /CreateV2/);
});

test('verifyLaunchSignature: rpc_error when the connection throws', async () => {
  const broken = { async getTransaction() { throw new Error('boom'); } };
  const result = await verifyLaunchSignature(broken, SIG, { mint: MINT, treasury: TREASURY, owner: OWNER });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'rpc_error');
  assert.match(result.reason, /boom/);
});

test('connectionAdapter: calls getParsedTransaction, not getTransaction, with maxSupportedTransactionVersion 0', async () => {
  const calls = [];
  const web3Connection = {
    getTransaction() { calls.push('getTransaction'); return fakeTx(); },
    getParsedTransaction(signature, opts) { calls.push('getParsedTransaction'); assert.equal(signature, SIG); assert.deepEqual(opts, { maxSupportedTransactionVersion: 0 }); return fakeTx(); },
  };
  const adapter = connectionAdapter(web3Connection);
  await adapter.getTransaction(SIG);
  assert.deepEqual(calls, ['getParsedTransaction'], 'must use the jsonParsed method: plain getTransaction() has no accountKeys array to read');
});

test('LaunchVerifyError carries a code', () => {
  const err = new LaunchVerifyError('mismatch', 'nope');
  assert.equal(err.code, 'mismatch');
  assert.equal(err.message, 'nope');
  assert.ok(err instanceof Error);
});
