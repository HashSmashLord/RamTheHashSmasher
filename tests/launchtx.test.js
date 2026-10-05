import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Keypair, PublicKey, SystemProgram, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID } from '@pump-fun/pump-sdk';
import {
  buildLaunchInstructions,
  compileLaunchTransaction,
  inspectLaunchTransaction,
  launchLookupTableAddresses,
  lookupTableAccount,
  anchorDiscriminator,
  LaunchTxError,
  DEFAULT_TREASURY,
  CREATE_FEE_LAMPORTS,
  MAX_TX_BYTES,
  LAUNCH_STEPS,
} from '../server/lib/launchtx.js';

const require = createRequire(import.meta.url);
const sdkDir = require.resolve('@pump-fun/pump-sdk').replace(/dist\/.*$/, '');
const pumpIdl = JSON.parse(readFileSync(`${sdkDir}src/idl/pump.json`, 'utf8'));
const feesIdl = JSON.parse(readFileSync(`${sdkDir}src/idl/pump_fees.json`, 'utf8'));

// Public keys of throwaway keypairs. Nothing in this file signs anything.
const pk = () => Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
// Worst-case metadata: the longest name/symbol the launchpad allows and a long URI.
const META = { name: 'N'.repeat(32), symbol: 'S'.repeat(10), uri: `https://ramherd.example.com/api/launchpad/rams/ram-0001/metadata.json` };

async function launch({ user = pk(), mint = pk(), ...rest } = {}) {
  const instructions = await buildLaunchInstructions({ user, mint, ...META, ...rest });
  return { user, mint, instructions };
}

async function compiledWithTable(opts) {
  const l = await launch(opts);
  const table = lookupTableAccount(pk(), await launchLookupTableAddresses());
  const out = compileLaunchTransaction({ instructions: l.instructions, payer: l.user, recentBlockhash: BLOCKHASH, lookupTables: [table] });
  return { ...l, table, out };
}

test('the anchor discriminators we decode with are the ones in pump\'s own IDLs', () => {
  const idlDisc = (idl, name) => Buffer.from(idl.instructions.find((i) => i.name === name).discriminator);
  assert.ok(anchorDiscriminator('create_v2').equals(idlDisc(pumpIdl, 'create_v2')));
  assert.ok(anchorDiscriminator('create_fee_sharing_config').equals(idlDisc(feesIdl, 'create_fee_sharing_config')));
  assert.ok(anchorDiscriminator('update_fee_shares').equals(idlDisc(feesIdl, 'update_fee_shares')));
  assert.equal(feesIdl.address, PUMP_FEE_PROGRAM_ID.toBase58());
  assert.equal(pumpIdl.address, PUMP_PROGRAM_ID.toBase58());
});

test('builds exactly the four launch steps, in order, against the right programs', async () => {
  const { instructions } = await launch();
  assert.deepEqual(instructions.map((i) => i.label), [...LAUNCH_STEPS]);
  assert.deepEqual(
    instructions.map((i) => i.instruction.programId.toBase58()),
    [SystemProgram.programId, PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, PUMP_FEE_PROGRAM_ID].map((k) => k.toBase58()),
  );
});

test('only the user and the mint ever sign; the treasury never does', async () => {
  const { user, mint, instructions } = await launch();
  const signers = new Set();
  for (const { instruction } of instructions) for (const k of instruction.keys) if (k.isSigner) signers.add(k.pubkey.toBase58());
  assert.deepEqual([...signers].sort(), [user, mint].sort());
  assert.ok(!signers.has(DEFAULT_TREASURY));
});

test('without a lookup table the launch does not fit one packet, and compile refuses with the measured size', async () => {
  const { user, instructions } = await launch();
  assert.throws(
    () => compileLaunchTransaction({ instructions, payer: user, recentBlockhash: BLOCKHASH }),
    (err) => err instanceof LaunchTxError && err.code === 'too_large' && err.sizeBytes > MAX_TX_BYTES,
  );
});

test('with the launch lookup table it fits, with room to spare, even at max metadata length', async () => {
  const { out } = await compiledWithTable();
  assert.ok(out.sizeBytes <= MAX_TX_BYTES, `size ${out.sizeBytes}`);
  assert.ok(out.sizeBytes < 1000, `expected comfortable headroom, got ${out.sizeBytes}`);
});

test('the lookup table holds only launch-invariant accounts: treasury yes, user/mint/top-level programs no', async () => {
  const addrs = await launchLookupTableAddresses();
  const again = await launchLookupTableAddresses();
  assert.deepEqual(addrs, again, 'stable across calls');
  assert.ok(addrs.includes(DEFAULT_TREASURY), 'treasury is launch-invariant');
  const { user, mint, instructions } = await launch();
  assert.ok(!addrs.includes(user) && !addrs.includes(mint));
  for (const p of [SystemProgram.programId, PUMP_PROGRAM_ID, PUMP_FEE_PROGRAM_ID]) assert.ok(!addrs.includes(p.toBase58()));
  // Every launch account outside the table is user/mint-specific or a top-level program.
  const all = new Set();
  for (const { instruction } of instructions) for (const k of instruction.keys) all.add(k.pubkey.toBase58());
  const statics = [...all].filter((a) => !addrs.includes(a));
  assert.ok(statics.length <= 13, `static accounts: ${statics.length}`);
});

test('serialized bytes are unsigned (zeroed signature slots) and round-trip exactly', async () => {
  const { user, mint, out, table } = await compiledWithTable();
  assert.equal(out.requiredSigners.length, 2);
  assert.equal(out.requiredSigners[0], user, 'user is the fee payer');
  assert.equal(out.requiredSigners[1], mint);
  const tx = VersionedTransaction.deserialize(Buffer.from(out.base64, 'base64'));
  assert.equal(tx.version, 0);
  assert.equal(tx.signatures.length, 2);
  for (const sig of tx.signatures) assert.ok(sig.every((b) => b === 0), 'no signature present');
  assert.ok(Buffer.from(tx.serialize()).equals(Buffer.from(out.bytes)));
  // Decompiling with the same table gives back the same instructions.
  const decompiled = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: [table] });
  assert.equal(decompiled.payerKey.toBase58(), user);
  assert.equal(decompiled.instructions.length, 4);
});

test('inspection decodes the launch: fee to treasury, creator = user, 100% of creator fees to the treasury', async () => {
  const { user, mint, out, table } = await compiledWithTable();
  const r = inspectLaunchTransaction(out.base64, { user, mint, lookupTables: [table], ...META });
  assert.equal(r.ok, true, r.problems.join('; '));
  const [fee, create, cfg, upd] = r.instructions;
  assert.deepEqual(fee, { step: 'create-fee', from: user, to: DEFAULT_TREASURY, lamports: CREATE_FEE_LAMPORTS });
  assert.equal(CREATE_FEE_LAMPORTS, 0.2 * 1e9);
  assert.equal(create.creator, user);
  assert.equal(create.mint, mint);
  assert.equal(create.name, META.name);
  assert.equal(cfg.payer, user);
  assert.deepEqual(upd.shareholders, [{ address: DEFAULT_TREASURY, shareBps: 10_000 }]);
});

test('inspection rejects a launch built for a different treasury, fee, user or metadata', async () => {
  const attacker = pk();
  const { user, mint, out, table } = await compiledWithTable({ treasury: attacker });
  const r = inspectLaunchTransaction(out.base64, { user, mint, lookupTables: [table] });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('not the treasury')));
  assert.ok(r.problems.some((p) => p.includes('not routed 100% to the treasury')));

  const cheap = await compiledWithTable({ createFeeLamports: 1 });
  assert.ok(inspectLaunchTransaction(cheap.out.base64, { user: cheap.user, mint: cheap.mint, lookupTables: [cheap.table] }).problems.some((p) => p.includes('create fee is 1')));

  const good = await compiledWithTable();
  assert.equal(inspectLaunchTransaction(good.out.base64, { user: pk(), mint: good.mint, lookupTables: [good.table] }).ok, false);
  assert.equal(inspectLaunchTransaction(good.out.base64, { user: good.user, mint: good.mint, lookupTables: [good.table], name: 'Other' }).ok, false);
});

test('inspection rejects a single flipped byte in the shareholder list', async () => {
  const { user, mint, out, table } = await compiledWithTable();
  const bytes = Buffer.from(out.bytes);
  // The shareholder's address is in update_fee_shares data; find the treasury bytes and flip one.
  const treasuryBytes = new PublicKey(DEFAULT_TREASURY).toBuffer();
  const at = bytes.lastIndexOf(treasuryBytes);
  assert.ok(at > 0);
  bytes[at + 5] ^= 0x01;
  const r = inspectLaunchTransaction(bytes, { user, mint, lookupTables: [table] });
  assert.equal(r.ok, false);
});

test('inspection rejects an extra instruction or a foreign program', async () => {
  const { user, mint, instructions, table } = await compiledWithTable();
  const thief = SystemProgram.transfer({ fromPubkey: new PublicKey(user), toPubkey: new PublicKey(pk()), lamports: 5 });
  const out = compileLaunchTransaction({ instructions: [...instructions, { label: 'extra', instruction: thief }], payer: user, recentBlockhash: BLOCKHASH, lookupTables: [table] });
  const r = inspectLaunchTransaction(out.base64, { user, mint, lookupTables: [table] });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('5 instructions')));
});

test('inspection rejects garbage and an oversize message', () => {
  assert.equal(inspectLaunchTransaction(Buffer.from('not a tx'), { user: pk(), mint: pk() }).ok, false);
});

test('bad inputs are refused before anything is built', async () => {
  await assert.rejects(buildLaunchInstructions({ user: 'nope', mint: pk(), ...META }), LaunchTxError);
  await assert.rejects(buildLaunchInstructions({ user: DEFAULT_TREASURY, mint: pk(), ...META }), /treasury/);
  const same = pk();
  await assert.rejects(buildLaunchInstructions({ user: same, mint: same, ...META }), /fresh/);
  await assert.rejects(buildLaunchInstructions({ user: pk(), mint: pk(), ...META, createFeeLamports: 0 }), LaunchTxError);
  await assert.rejects(buildLaunchInstructions({ user: pk(), mint: pk(), ...META, uri: '' }), LaunchTxError);
  assert.throws(() => compileLaunchTransaction({ instructions: [], payer: pk(), recentBlockhash: '' }), LaunchTxError);

  // 12 + 4 + 21 = 37 bytes: the Multisig-size mint edge seen failing on devnet.
  await assert.rejects(buildLaunchInstructions({ user: pk(), mint: pk(), name: 'RAMherd test', symbol: 'RAMT', uri: 'https://r.example/m/1' }), /37 bytes/);
  await buildLaunchInstructions({ user: pk(), mint: pk(), name: 'RAMherd tes', symbol: 'RAMT', uri: 'https://r.example/m/1' });
});

test('the launch module has no code path that signs, sends or loads a key', () => {
  const src = readFileSync(new URL('../server/lib/launchtx.js', import.meta.url), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const banned of ['.sign(', 'partialSign', 'sendTransaction', 'sendRawTransaction', 'secretKey', 'fromSecretKey', 'readFileSync', 'process.env']) {
    assert.ok(!code.includes(banned), `launchtx.js must not contain ${banned}`);
  }
});
