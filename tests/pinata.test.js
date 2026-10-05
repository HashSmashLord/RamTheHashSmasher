import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinataClient, pinataPolicy } from '../server/lib/pinata.js';

test('pinataPolicy reads PINATA_JWT and treats unset or blank as not configured', () => {
  assert.equal(pinataPolicy({}).configured, false);
  assert.equal(pinataPolicy({ PINATA_JWT: '' }).configured, false);
  assert.equal(pinataPolicy({ PINATA_JWT: '   ' }).configured, false);
  const p = pinataPolicy({ PINATA_JWT: 'eyFake' });
  assert.equal(p.configured, true);
  assert.equal(p.jwt, 'eyFake');
});

test('createPinataClient requires a jwt', () => {
  assert.throws(() => createPinataClient({ jwt: '' }), TypeError);
});

test('pinJson posts pinataContent with a Bearer auth header and returns the gateway URL', async () => {
  let call = null;
  const fetchImpl = async (url, opts) => {
    call = { url, opts, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ IpfsHash: 'bafyFakeCid123' }) };
  };
  const client = createPinataClient({ jwt: 'sk-fake', fetchImpl });
  const result = await client.pinJson({ name: 'RAM 1', symbol: 'R1' }, { name: 'r1-metadata' });
  assert.equal(call.url, 'https://api.pinata.cloud/pinning/pinJSONToIPFS');
  assert.equal(call.opts.headers.Authorization, 'Bearer sk-fake');
  assert.deepEqual(call.body.pinataContent, { name: 'RAM 1', symbol: 'R1' });
  assert.equal(call.body.pinataMetadata.name, 'r1-metadata');
  assert.equal(result.cid, 'bafyFakeCid123');
  assert.equal(result.uri, 'https://gateway.pinata.cloud/ipfs/bafyFakeCid123');
});

test('pinJson omits pinataMetadata when no name is given', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal('pinataMetadata' in JSON.parse(opts.body), false);
    return { ok: true, json: async () => ({ IpfsHash: 'x' }) };
  };
  await createPinataClient({ jwt: 'sk-fake', fetchImpl }).pinJson({ a: 1 });
});

test('pinJson throws on a failed HTTP response, never returning a fake URL', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  const client = createPinataClient({ jwt: 'sk-fake', fetchImpl });
  await assert.rejects(() => client.pinJson({ a: 1 }), /401/);
});

test('pinJson throws when the response has no IpfsHash', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({}) });
  const client = createPinataClient({ jwt: 'sk-fake', fetchImpl });
  await assert.rejects(() => client.pinJson({ a: 1 }), /IpfsHash/);
});
