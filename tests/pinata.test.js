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

test('pinFile posts multipart form-data to pinFileToIPFS: a typed `file` part and a pinataMetadata JSON string', async () => {
  let call = null;
  const fetchImpl = async (url, opts) => {
    call = { url, opts };
    return { ok: true, json: async () => ({ IpfsHash: 'QmFakeImageCid', PinSize: 4, isDuplicate: false }) };
  };
  const client = createPinataClient({ jwt: 'sk-fake', fetchImpl });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const result = await client.pinFile(bytes, { name: 'img-abc.png', type: 'image/png', filename: 'img-abc.png' });
  assert.equal(call.url, 'https://api.pinata.cloud/pinning/pinFileToIPFS');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers.Authorization, 'Bearer sk-fake');
  assert.equal('Content-Type' in call.opts.headers, false, 'fetch writes the multipart boundary itself');
  assert.ok(call.opts.body instanceof FormData);
  const file = call.opts.body.get('file');
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'img-abc.png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.deepEqual(JSON.parse(call.opts.body.get('pinataMetadata')), { name: 'img-abc.png' });
  assert.deepEqual(result, { cid: 'QmFakeImageCid', uri: 'https://gateway.pinata.cloud/ipfs/QmFakeImageCid' });
});

test('pinFile throws on a failed response or a missing IpfsHash, never returning a fake URL', async () => {
  const denied = createPinataClient({ jwt: 'sk-fake', fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'NO_SCOPES_FOUND' }) });
  await assert.rejects(() => denied.pinFile(Buffer.from('x')), /pinFileToIPFS failed: 403/);
  const empty = createPinataClient({ jwt: 'sk-fake', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(() => empty.pinFile(Buffer.from('x')), /IpfsHash/);
});

test('unpin sends DELETE /pinning/unpin/<cid> and refuses a non-CID', async () => {
  let call = null;
  const client = createPinataClient({ jwt: 'sk-fake', fetchImpl: async (url, opts) => ((call = { url, opts }), { ok: true, text: async () => 'OK' }) });
  await client.unpin('QmFakeImageCid');
  assert.equal(call.url, 'https://api.pinata.cloud/pinning/unpin/QmFakeImageCid');
  assert.equal(call.opts.method, 'DELETE');
  await assert.rejects(() => client.unpin('../pinJSONToIPFS'), TypeError);
});
