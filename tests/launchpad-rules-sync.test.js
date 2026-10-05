// The page's rules (src/launchpad-rules.js) are a copy for early feedback; the
// server's (server/lib/launchpad.js) are the authority. This keeps them equal,
// and checks that what the page accepts the server accepts too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import * as client from '../src/launchpad-rules.js';
import { launchpadCatalog, validateCreateRequest } from '../server/lib/launchpad.js';
import { CREATE_FEE_LAMPORTS, DEFAULT_TREASURY } from '../server/lib/launchtx.js';

const server = launchpadCatalog();

test('families, tracks and rounds match the server', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(client.HASH_FAMILIES)), server.hashFamilies);
});

test('approach ids and labels match the server', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(client.APPROACHES)), server.approaches);
});

test('models match the server roster, in order', () => {
  assert.deepEqual([...client.MODELS], server.models.map((m) => m.slug));
});

test('limits, fee and treasury match the server', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(client.LIMITS)), server.limits);
  assert.equal(client.CREATE_FEE_LAMPORTS, CREATE_FEE_LAMPORTS);
  assert.equal(client.TREASURY, DEFAULT_TREASURY);
});

test('every family x approach x model the page accepts, the server accepts too', () => {
  const owner = Keypair.generate().publicKey.toBase58();
  for (const { family, tracks } of client.HASH_FAMILIES) {
    for (const { track } of tracks) {
      for (const { id } of client.APPROACHES) {
        for (const model of client.MODELS) {
          const form = { owner, hashFamily: family, track, approach: id, approachDetail: 'Look for a cheaper characteristic in the message schedule.', model, tokenName: 'Herd RAM', tokenSymbol: 'herd' };
          assert.equal(client.validateDraft(form).ok, true);
          const verdict = validateCreateRequest(client.toRamRequest(form));
          assert.equal(verdict.ok, true, `${family}/${track}/${id}/${model}: ${JSON.stringify(verdict.fields)}`);
        }
      }
    }
  }
});

test('the page refuses a multi-family pick just like the server', () => {
  assert.equal(client.validateHashFamily(['SHA-256', 'BLAKE3']).ok, false);
  assert.equal(validateCreateRequest({ hashFamily: ['SHA-256', 'BLAKE3'] }).fields.hashFamily !== undefined, true);
});
