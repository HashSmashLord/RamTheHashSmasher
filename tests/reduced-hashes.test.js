// Correctness of server/lib/reduced-hashes.js, the JS port of the HashSmash
// organizer's own reference checker that the research loop's real
// experiments run on. Pinned four independent ways, so the port is never
// "checked against itself":
//   1. full round counts against Node's own SHA-256 / SHA3-256 at every
//      padding/rate boundary;
//   2. the organizer's OWN independent reduced-round vectors, embedded here
//      (NIST "abc" intermediate states for SHA-256 t=7/t=23, XKCP Keccak-f
//      [1600] after-round-5/6 states, BLAKE3 Rust-reference prefix outputs for
//      r1/r2 plus the official full-round corpus) — copied from
//      reference/hash-smash/tests/{test_hash_functions,test_keccak}.py and
//      tests/fixtures/blake3-vectors.json, which state their own provenance;
//   3. the organizer's own Python (verifier/hash_functions.py digest, the
//      call its certificate checker makes) on random messages for all six
//      tracks — skipped loudly when the vendored repo or python3 is absent;
//   4. the track table against the vendored target-profiles/*.json files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sha256Reduced, sha3_256Reduced, blake3Reduced, keccakF1600, digest, digestForTrack, TRACK_TARGETS, SHA256_IV,
} from '../server/lib/reduced-hashes.js';
import { PIPELINE_TRACKS, DEFAULT_REFERENCE_ROOT } from '../server/lib/hashsmash.js';

const hex = (b) => Buffer.from(b).toString('hex');
const pattern = (len) => Uint8Array.from({ length: len }, (_, i) => i % 251);

function pythonOk() {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const REF_SKIP = !existsSync(join(DEFAULT_REFERENCE_ROOT, 'verifier', 'hash_functions.py'))
  ? 'vendored HashSmash repo not present (reference/ is git-ignored; see Dockerfile)'
  : !pythonOk() ? 'python3 not available' : false;

test('full-round SHA-256 and SHA3-256 match Node\'s own implementations at every padding and rate boundary', () => {
  for (const len of [0, 1, 3, 31, 40, 55, 56, 63, 64, 65, 67, 68, 69, 119, 120, 127, 128, 134, 135, 136, 137, 270, 271, 272, 273, 1000]) {
    const m = pattern(len);
    assert.equal(hex(sha256Reduced(m, 64)), createHash('sha256').update(m).digest('hex'), `sha256 len ${len}`);
    assert.equal(hex(sha3_256Reduced(m, 24)), createHash('sha3-256').update(m).digest('hex'), `sha3-256 len ${len}`);
  }
});

test('reduced SHA-256 matches the NIST "abc" intermediate states (t=7, t=23) plus feed-forward, as the organizer pins it', () => {
  // reference/hash-smash/tests/test_hash_functions.py: NIST SHA256.pdf example, rounds 8 and 24.
  const vectors = [
    [8, '85A07B5F E5030380 2B4209F5 04409A6A 0C657A79 9B27A401 714260AD 43ADA245'],
    [24, 'C5D53D8D A7A3623F C2606D6D 9DC68B63 AA47C347 49F5114A E1257970 8ADA8930'],
  ];
  for (const [rounds, working] of vectors) {
    const words = working.split(' ').map((w) => parseInt(w, 16));
    const expected = Buffer.alloc(32);
    words.forEach((w, i) => expected.writeUInt32BE((SHA256_IV[i] + w) >>> 0, 4 * i));
    assert.equal(hex(sha256Reduced(Buffer.from('abc'), rounds)), expected.toString('hex'), `rounds ${rounds}`);
  }
});

test('Keccak-f[1600] prefix rounds match the published XKCP after-round-5/6 states on the all-zero state', () => {
  // reference/hash-smash/tests/test_keccak.py, from XKCP KeccakF-1600-IntermediateValues.txt.
  const vectors = {
    5: `6A00840802752A6F F9A9C3AB00C9C931 6DB98725571F1604 96BA275BA7474A93 9B5E7A3FEEB7E41E
        73FE33C9B1038C36 70E8B5D763274728 0FE03A842F22AFCB D95C0A4EC94AD619 E57A1A2BB2AE09C2
        2728E4F2B7AEEBE8 A81EDBEB54D20FE1 7AC22599684B0182 C17E6A6AB6526EB1 A1C3CEE067AB9F52
        B8E36F84D019B15F 1CF47F1F04738AD9 F377844620F2D499 105A64A116516B0E 965393CA1B42F1DB
        1C2C849D3FD29C1F AB89B3623F5F6964 916D0713D86ACC2A E5DC85FFAD78D9B0 650759748DF5EFE9`,
    6: `43E30B96FF110A58 D642C7DF22B4173C BFD660DFE2E0051D A303B734F55677E6 37C05E405B01AF0C
        0B5033314F45C5CB 44F0FBF5606F647A 34FE5A6214181ED1 B42ABC5DE738DDD5 7A8E099FE258E5D8
        2D6CBEB27C4BC219 A58159B967A3AD93 A4036D7EAF457157 5F252E8E367F3DC8 5E8F6AD5D330526E
        4FCB128386812F6E 02C154103BD90DD0 375463E874AF271C 1CEE752EDB4B48F6 36E67B423707DCB0
        F36BA8B04378F57A CFCD9CECD3ADE3D5 7FC73C7B61494B4C B913D9D348A8E89A 1EDCA3008E4023A2`,
  };
  for (const [rounds, text] of Object.entries(vectors)) {
    const s = keccakF1600(new Uint32Array(50), Number(rounds));
    const lanes = [];
    for (let i = 0; i < 25; i++) lanes.push(((BigInt(s[2 * i + 1]) << 32n) | BigInt(s[2 * i])).toString(16).toUpperCase().padStart(16, '0'));
    assert.deepEqual(lanes, text.trim().split(/\s+/), `rounds ${rounds}`);
  }
});

test('BLAKE3 matches the official full-round corpus and the independent Rust-reference r1/r2 prefix vectors, across chunk/tree boundaries', () => {
  // reference/hash-smash/tests/fixtures/blake3-vectors.json (official corpus + upstream Rust reference reduced to 1/2 rounds).
  const vectors = [
    [7, 0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'], [7, 1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
    [7, 64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'], [7, 65, 'de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee'],
    [7, 1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'], [7, 1025, 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'],
    [7, 3073, '7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3'], [7, 8193, 'bab6c09cb8ce8cf459261398d2e7aef35700bf488116ceb94a36d0f5f1b7bc3b'],
    [7, 31744, '62b6960e1a44bcc1eb1a611a8d6235b6b4b78f32e7abc4fb4c6cdcce94895c47'],
    [1, 0, '111b0e9672ca328b7216e00d36bc0449f86e5e5f919ef9ba0c70ddd58581b23c'], [1, 1, 'aaa5ad08818bf5b2e947b32da4fb197a11a90f5a8bdedadc8e965d95d99fdf3b'],
    [1, 64, 'daa3818e90978f7be4d1386c972be2ccbde74b1680a14a5a3450503d7c5b26f0'], [1, 65, 'd6e70bce4f860c9767df1b41853bd19e6323abc3ac6dfbce9f1c350caadab206'],
    [1, 1024, 'f48e1d0474fcf8cb2ae42dd69a6f05e78ffa12446c5c8b3100fe79008252f832'], [1, 1025, '853e922c2c9f52915d6930890d18c65d51c648a52e8c98818c06ca9fddd86bbc'],
    [1, 8193, 'e9445fd2cb4af8786c6b1d5e27a27eb91e19312a6338252429bdf93b94e25937'], [1, 16385, '859f8fb074b8e0dc78f30dc94dbccb73127005a4ff0273f78c5bd35bf73909df'],
    [2, 0, '10db78433bdbf567c9fe51bde752212755c64729b78dc4979dcf8b23010650f6'], [2, 1, '86080bd6fda77648e526630c65bedd4a9c779c3711d2ab3ca209d69118a22931'],
    [2, 64, 'f4bccfa0dad3dba53dad94ab20f344afa19337c6e4e8dfe496cd0fbdbc9013e4'], [2, 65, '84e0ca8564ee6a8b2cdb1d40e5129e9d1a7dbaa7f625e29d96adfbd34410789e'],
    [2, 1024, 'd9eaadd8f7a9e67d82930e72dbf1611479d07d4adbac09315e3d60b12163614e'], [2, 1025, 'a5d1e757f6a508b37bf826a4859adca4618960ebc67a8aa6829ee05158073ead'],
    [2, 8193, 'cb43120e4b5687240c1e28e2717f68bf1a3ace698d469f3a6fe6b4845de06c04'], [2, 16385, '29fd710aeab8f982a5f8f9f2c61667d6ca0c57e8e83a195b01788dc9b7629557'],
  ];
  for (const [rounds, len, want] of vectors) assert.equal(hex(blake3Reduced(pattern(len), rounds)), want, `blake3 r${rounds} len ${len}`);
});

test('BLAKE3: every vector in the vendored organizer fixture matches (all 67, including every r1/r2 prefix case)', { skip: REF_SKIP }, () => {
  const vectors = JSON.parse(readFileSync(join(DEFAULT_REFERENCE_ROOT, 'tests', 'fixtures', 'blake3-vectors.json'), 'utf8'));
  assert.ok(vectors.length >= 60);
  for (const v of vectors) assert.equal(hex(blake3Reduced(pattern(v.length), v.rounds)), v.digest, `r${v.rounds} len ${v.length}`);
});

test('the organizer\'s own shallow control: a REAL 8-round SHA-256 full-message collision, which full rounds break', () => {
  // reference/hash-smash/tests/test_hash_functions.py: the difference sits in
  // message word 8, which the first 8 steps never read.
  const a = new Uint8Array(40);
  const b = new Uint8Array(40); b[32] = 1;
  assert.equal(hex(digest(a, 'sha256', 8)), hex(digest(b, 'sha256', 8)));
  assert.notEqual(hex(digest(a, 'sha256', 64)), hex(digest(b, 'sha256', 64)));
  const a2 = new Uint8Array(110); const b2 = new Uint8Array(110); b2[32] = 1;
  assert.equal(hex(digest(a2, 'sha256', 8)), hex(digest(b2, 'sha256', 8)), 'equality persists through a second block');
});

test('invalid round counts and non-byte inputs fail closed, like the organizer\'s reference', () => {
  for (const [fn, bad] of [[sha256Reduced, [0, 65, 1.5, true]], [sha3_256Reduced, [0, 25, '5']], [blake3Reduced, [0, 8, null]]]) {
    for (const r of bad) assert.throws(() => fn(new Uint8Array(3), r));
    assert.throws(() => fn('abc', 1));
  }
  assert.throws(() => digest(new Uint8Array(1), 'md5', 8), /unsupported algorithm/);
  assert.throws(() => digestForTrack('sha1-r80-exploratory', new Uint8Array(1)), /no reduced-round target/);
});

test('the track table covers exactly the six pipeline tracks', () => {
  assert.deepEqual(Object.keys(TRACK_TARGETS).sort(), [...PIPELINE_TRACKS].sort());
});

test('the track table matches every vendored organizer target profile exactly (algorithm, rounds, digest bits, profile id)', { skip: REF_SKIP }, () => {
  for (const [track, t] of Object.entries(TRACK_TARGETS)) {
    const profile = JSON.parse(readFileSync(join(DEFAULT_REFERENCE_ROOT, 'target-profiles', `${t.profileId}.json`), 'utf8'));
    assert.equal(profile.id, t.profileId, track);
    assert.equal(profile.algorithm, t.algorithm, track);
    assert.equal(profile.rounds, t.rounds, track);
    assert.equal(profile.full_rounds, t.fullRounds, track);
    assert.equal(profile.digest_bits, t.digestBits, track);
    assert.equal(profile.attack_class, 'ordinary-collision', track);
  }
});

test('all six tracks agree with the organizer\'s own Python digest (get_frontier_track + verifier.hash_functions.digest) on random messages', { skip: REF_SKIP }, () => {
  const cases = [];
  for (const track of Object.keys(TRACK_TARGETS)) {
    for (const len of [0, 1, 55, 56, 64, 135, 136, 137, 300, 1023, 1024, 1025, 2100]) cases.push({ track, m: randomBytes(len).toString('hex') });
  }
  const code = [
    'import json,sys',
    'from verifier.frontier_tracks import get_frontier_track',
    'from verifier.hash_functions import digest',
    'out=[]',
    'for c in json.load(sys.stdin):',
    '  t=get_frontier_track(c["track"]); out.append(digest(bytes.fromhex(c["m"]), t.algorithm, t.rounds).hex())',
    'print(json.dumps(out))',
  ].join('\n');
  const out = JSON.parse(execFileSync('python3', ['-c', code], {
    cwd: DEFAULT_REFERENCE_ROOT, input: JSON.stringify(cases), env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  }).toString());
  cases.forEach((c, i) => assert.equal(hex(digestForTrack(c.track, Buffer.from(c.m, 'hex'))), out[i], `${c.track} len ${c.m.length / 2}`));
});
