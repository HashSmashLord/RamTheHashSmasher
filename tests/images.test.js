import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import {
  sniffImageType,
  validateImageBytes,
  imageIdFor,
  createImageStore,
  ImageError,
  MAX_IMAGE_BYTES,
  IMAGE_TYPES,
  DEFAULT_IMAGE_PIN_RATE_LIMIT,
} from '../server/lib/images.js';
import { createRamRegistry, DEFAULT_PIN_RATE_LIMIT } from '../server/lib/rams.js';
import { createSlotManager } from '../server/lib/slots.js';
import { createRamFunds } from '../server/lib/ramfunds.js';
import { createPayoutBook } from '../server/lib/payouts.js';
import { validateCreateRequest, launchpadCatalog } from '../server/lib/launchpad.js';
import * as client from '../src/launchpad-rules.js';
import { startApp } from './helpers/harness.js';
import { loadConfig } from '../server/config.js';
import { makePng } from './helpers/png.js';

const BASE = 'https://ramherd.example';
const png = (note = '') => makePng({ note });
// Real file signatures, padded to a plausible length.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(64, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(64, 3)]);

function fakePinata({ fails = false } = {}) {
  const files = [];
  return {
    files,
    client: {
      async pinFile(bytes, opts) {
        files.push({ bytes, opts });
        if (fails) throw new Error('pinata down');
        return { cid: `bafyImg${files.length}`, uri: `https://gateway.pinata.cloud/ipfs/bafyImg${files.length}` };
      },
      async pinJson() {
        return { cid: 'bafyMeta', uri: 'https://gateway.pinata.cloud/ipfs/bafyMeta' };
      },
    },
  };
}

// ---- validation -------------------------------------------------------------

test('the real type comes from the file signature: PNG, JPG, GIF, WEBP; anything else is refused', () => {
  assert.equal(sniffImageType(png()), 'image/png');
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(GIF), 'image/gif');
  assert.equal(sniffImageType(WEBP), 'image/webp');
  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('%PDF-1.7 .....'), Buffer.alloc(0), Buffer.from('RIFF0000WAVEfmt ')]) {
    assert.equal(sniffImageType(bad), null, bad.toString('latin1').slice(0, 12));
  }
  assert.deepEqual([...IMAGE_TYPES], ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
});

test('validateImageBytes refuses empty, oversize and non-image files with a reason', () => {
  assert.deepEqual(validateImageBytes(png()), { ok: true, type: 'image/png' });
  assert.equal(validateImageBytes(Buffer.alloc(0)).ok, false);
  const tooBig = Buffer.concat([png(), Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.equal(validateImageBytes(tooBig).code, 'too_large');
  // Exactly at the ceiling is fine.
  const atCap = Buffer.concat([png(), Buffer.alloc(MAX_IMAGE_BYTES - png().length)]);
  assert.equal(atCap.length, MAX_IMAGE_BYTES);
  assert.equal(validateImageBytes(atCap).ok, true);
  const text = validateImageBytes(Buffer.from('just some text renamed to logo.png'));
  assert.equal(text.code, 'invalid_image');
  assert.match(text.reason, /PNG, JPG, GIF or WEBP/);
  assert.equal(MAX_IMAGE_BYTES, 2 * 1024 * 1024);
});

// ---- the store --------------------------------------------------------------

test('no Pinata: the image is held and self-hosted at once (no await needed), deduplicated by content', async () => {
  const store = createImageStore({ publicBaseUrl: BASE });
  const bytes = png('a');
  const pending = store.upload(bytes);
  const id = imageIdFor(bytes);
  assert.ok(store.get(id), 'held synchronously');
  const img = await pending;
  assert.equal(img.id, id);
  assert.match(img.id, /^img-[0-9a-f]{24}$/);
  assert.equal(img.pinned, false);
  assert.equal(img.url, `${BASE}/api/launchpad/images/${id}`);
  assert.equal(img.type, 'image/png');
  assert.deepEqual(store.file(id).bytes, bytes);
  assert.deepEqual(await store.upload(Buffer.from(bytes)), img, 'same bytes, same record');
  assert.equal(store.heldBytes(), bytes.length);
});

test('upload rejects (never stores) a non-image or oversize file', async () => {
  const store = createImageStore({ publicBaseUrl: BASE });
  await assert.rejects(store.upload(Buffer.from('<svg/>' + ' '.repeat(20))), (e) => e instanceof ImageError && e.code === 'invalid_image');
  await assert.rejects(store.upload(Buffer.concat([png(), Buffer.alloc(MAX_IMAGE_BYTES)])), (e) => e instanceof ImageError && e.code === 'too_large');
  assert.equal(store.heldBytes(), 0);
});

test('with Pinata: the file is pinned (name, real type) and the URL is the gateway; nothing held in memory', async () => {
  const pin = fakePinata();
  const store = createImageStore({ publicBaseUrl: BASE, pinata: pin.client });
  const img = await store.upload(WEBP);
  assert.equal(pin.files.length, 1);
  assert.equal(pin.files[0].opts.type, 'image/webp');
  assert.equal(pin.files[0].opts.name, `${img.id}.webp`);
  assert.equal(img.pinned, true);
  assert.equal(img.cid, 'bafyImg1');
  assert.equal(img.url, 'https://gateway.pinata.cloud/ipfs/bafyImg1');
  assert.equal(store.file(img.id), undefined);
  assert.equal(store.heldBytes(), 0);
  await store.upload(WEBP);
  assert.equal(pin.files.length, 1, 'the same image is never pinned twice');
  store.stop();
});

test('a failed image pin falls back to the self-hosted URL, never a fake one', async () => {
  const pin = fakePinata({ fails: true });
  const store = createImageStore({ publicBaseUrl: BASE, pinata: pin.client });
  const img = await store.upload(GIF);
  assert.equal(pin.files.length, 1);
  assert.equal(img.pinned, false);
  assert.equal(img.url, `${BASE}/api/launchpad/images/${img.id}`);
  assert.ok(store.file(img.id));
  store.stop();
});

test('image pins have their own global cap; past it uploads are self-hosted', async () => {
  const pin = fakePinata();
  const store = createImageStore({ publicBaseUrl: BASE, pinata: pin.client, pinRateLimit: { max: 2, windowMs: 60 * 60 * 1000 } });
  const out = [];
  for (let i = 0; i < 5; i++) out.push(await store.upload(png(`cap-${i}`)));
  assert.equal(pin.files.length, 2);
  assert.deepEqual(out.map((i) => i.pinned), [true, true, false, false, false]);
  assert.ok(DEFAULT_IMAGE_PIN_RATE_LIMIT.max < DEFAULT_PIN_RATE_LIMIT.max, 'images are capped tighter than metadata JSON');
  assert.equal(DEFAULT_IMAGE_PIN_RATE_LIMIT.windowMs, 60 * 60 * 1000);
  store.stop();
});

test('held bytes are capped: unused images go first, an active RAM\'s image never; refused when only kept ones remain', async () => {
  const a = png('held-a');
  const size = a.length;
  const store = createImageStore({ publicBaseUrl: BASE, maxHeldBytes: size * 2 });
  const ia = await store.upload(a);
  const ib = await store.upload(png('held-b'));
  store.claim(ia.id, 'kept');
  const ic = await store.upload(png('held-c')); // evicts b (loose), keeps a
  assert.ok(store.get(ia.id));
  assert.equal(store.get(ib.id), undefined);
  assert.ok(store.get(ic.id));
  store.claim(ic.id, 'kept');
  await assert.rejects(store.upload(png('held-d')), (e) => e.code === 'image_storage_full');
  assert.ok(store.get(ia.id) && store.get(ic.id));
});

// ---- the registry: required image, metadata ---------------------------------

function registry(opts = {}) {
  const slotManager = createSlotManager({ llmProvider: { complete: async () => ({ text: 'x' }) } });
  return createRamRegistry({ slotManager, funds: createRamFunds(), payouts: createPayoutBook(), publicBaseUrl: BASE, ...opts });
}
function value(image, over = {}) {
  const v = validateCreateRequest({
    owner: Keypair.generate().publicKey.toBase58(),
    hashFamily: 'BLAKE3',
    approach: 'trail-search-heuristics',
    approachDetail: 'Try a new beam-search heuristic over 2-round BLAKE3 trails.',
    model: 'qwen/qwen3.8-max-prime',
    tokenName: 'Blake Breaker',
    tokenSymbol: 'BLKB',
    image,
    ...over,
  });
  assert.equal(v.ok, true, JSON.stringify(v.fields));
  return v.value;
}

test('the image is required: the request validator and the registry both refuse a draft without one', () => {
  const r = validateCreateRequest({ ...value('img-0123456789abcdef01234567'), image: undefined });
  assert.equal(r.fields.image, 'Add an image for the token.');
  assert.ok(validateCreateRequest({ ...value('img-0123456789abcdef01234567'), image: 'https://evil.example/x.png' }).fields.image, 'a URL is never accepted, only an id');
  const rams = registry();
  const v = value('img-0123456789abcdef01234567');
  assert.throws(() => rams.createDraft({ ...v, image: undefined }), /image is required/);
  assert.throws(() => rams.createDraft(v), /unknown image id/);
  assert.equal(rams.list().length, 0, 'no draft and no id spent');
});

test('metadata gains `image` (self-hosted with no Pinata); every other field, external_url included, is unchanged', async () => {
  const rams = registry();
  const img = await rams.uploadImage(png('meta'));
  const ram = rams.createDraft(value(img.id));
  const meta = rams.metadata(ram.id);
  assert.deepEqual(Object.keys(meta), ['name', 'symbol', 'description', 'image', 'external_url', 'attributes']);
  assert.equal(meta.image, `${BASE}/api/launchpad/images/${img.id}`);
  assert.equal(meta.external_url, `${BASE}/herd#ram/${ram.id}`);
  assert.equal(ram.token.imageId, img.id);
  assert.equal(ram.token.image, meta.image);
});

test('with Pinata: the pinned metadata JSON carries the pinned image\'s gateway URL', async () => {
  const pin = fakePinata();
  const metaPins = [];
  pin.client.pinJson = async (content) => (metaPins.push(content), { cid: 'bafyMeta', uri: 'https://gateway.pinata.cloud/ipfs/bafyMeta' });
  const rams = registry({ pinata: pin.client });
  const img = await rams.uploadImage(JPEG);
  const ram = rams.createDraft(value(img.id));
  await rams.waitForMetadataPin(ram.id);
  assert.equal(metaPins[0].image, 'https://gateway.pinata.cloud/ipfs/bafyImg1');
  assert.equal(metaPins[0].external_url, `${BASE}/herd#ram/${ram.id}`);
  assert.equal(rams.get(ram.id).token.uri, 'https://gateway.pinata.cloud/ipfs/bafyMeta');
  rams.stop();
});

test('a self-hosted image dropped from memory is left out of the metadata, not pointed at', async () => {
  const first = png('drop-1');
  const rams = registry({ maxHeldImageBytes: first.length });
  const img = await rams.uploadImage(first);
  const ram = rams.createDraft(value(img.id));
  assert.ok(rams.metadata(ram.id).image);
  await rams.uploadImage(png('drop-2')); // only room for one: the draft's image is dropped
  const meta = rams.metadata(ram.id);
  assert.equal('image' in meta, false);
  assert.equal(meta.external_url, `${BASE}/herd#ram/${ram.id}`);
});

test('an active RAM\'s self-hosted image is kept even under memory pressure', async () => {
  const first = png('kept-1');
  const rams = registry({ maxHeldImageBytes: first.length * 3 });
  const img = await rams.uploadImage(first);
  const ram = rams.createDraft(value(img.id));
  rams.prepareLaunch(ram.id, Keypair.generate().publicKey.toBase58());
  rams.confirmLaunch(ram.id, { signature: bs58.encode(randomBytes(64)), briefApproved: true });
  for (let i = 0; i < 5; i++) await rams.uploadImage(png(`kept-x${i}`));
  assert.equal(rams.metadata(ram.id).image, `${BASE}/api/launchpad/images/${img.id}`);
});

// ---- the page's copy of the rules -------------------------------------------

test('the page\'s image limits match the server\'s, and its file check refuses what the server would', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(client.IMAGE_LIMITS)), launchpadCatalog().image);
  const file = (type, size) => ({ type, size, name: 'x' });
  assert.equal(client.validateImage(file('image/png', 1000)).ok, true);
  assert.equal(client.validateImage(file('image/webp', MAX_IMAGE_BYTES)).ok, true);
  assert.match(client.validateImage(file('image/png', MAX_IMAGE_BYTES + 1)).errors.image, /2 MB or smaller/);
  assert.match(client.validateImage(file('image/svg+xml', 1000)).errors.image, /not a PNG, JPG, GIF or WEBP/);
  assert.match(client.validateImage(file('application/pdf', 1000)).errors.image, /not a PNG/);
  assert.match(client.validateImage(file('image/png', 0)).errors.image, /empty/);
  assert.match(client.validateImage(undefined).errors.image, /Add an image/);
  assert.match(client.validateImage(null).errors.image, /Add an image/);
  assert.equal(client.validateImage('img-0123456789abcdef01234567').ok, true);
  assert.ok(client.validateImage('https://x.example/a.png').errors.image);
});

// ---- over HTTP --------------------------------------------------------------

async function start() {
  const base = loadConfig({});
  return startApp({ launchpad: { ...base.launchpad, publicBaseUrl: BASE }, launchpadRateLimit: { max: 1000, windowMs: 60_000 } });
}
const post = (s, body, type = 'image/png') => fetch(`${s.base}/api/launchpad/images`, { method: 'POST', headers: { 'Content-Type': type }, body });

test('HTTP: upload an image, serve it back byte-for-byte, and the draft\'s metadata.json points at it', async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const bytes = png('http');
  const up = await post(s, bytes);
  assert.equal(up.status, 201);
  const { image } = await up.json();
  assert.equal(image.pinned, false);

  const served = await s.get(`/api/launchpad/images/${image.id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
  assert.equal((await s.get('/api/launchpad/images/img-0123456789abcdef01234567')).status, 404);

  const created = await s.postJson('/api/launchpad/rams', { ...rawBody(), image: image.id });
  assert.equal(created.status, 201);
  const { ram } = await created.json();
  const meta = await (await s.get(`/api/launchpad/rams/${ram.id}/metadata.json`)).json();
  assert.equal(meta.image, `${BASE}/api/launchpad/images/${image.id}`);
  assert.equal(meta.external_url, `${BASE}/herd#ram/${ram.id}`);
});

function rawBody() {
  return {
    owner: Keypair.generate().publicKey.toBase58(),
    hashFamily: 'SHA3-256',
    approach: 'literature-replication',
    approachDetail: 'Adapt the known 6-round Keccak collision attack to the exploratory cost model.',
    model: 'z-ai/glm-5.3-prime',
    tokenName: 'Keccak Knocker',
    tokenSymbol: 'KECK',
  };
}

test('HTTP: non-images, wrong Content-Type and oversize uploads are refused per field; nothing is stored', async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const html = await post(s, Buffer.from('<html><script>alert(1)</script></html>'.padEnd(64)));
  assert.equal(html.status, 400);
  assert.match((await html.json()).fields.image, /not a PNG, JPG, GIF or WEBP/);

  const form = await post(s, png('x'), 'text/plain');
  assert.equal(form.status, 415);

  const big = await post(s, Buffer.concat([png('big'), Buffer.alloc(MAX_IMAGE_BYTES)]));
  assert.equal(big.status, 413);
  assert.equal(s.store.rams.list().length, 0);
});

test('HTTP: a draft without an image, or with an id this server does not hold, is refused on the image field', async (t) => {
  const s = await start();
  t.after(() => s.stop());
  const none = await s.postJson('/api/launchpad/rams', rawBody());
  assert.equal(none.status, 400);
  assert.equal((await none.json()).fields.image, 'Add an image for the token.');
  const unknown = await s.postJson('/api/launchpad/rams', { ...rawBody(), image: 'img-0123456789abcdef01234567' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).fields.image, /no longer on the server/);
  assert.equal(s.store.rams.list().length, 0);
});
