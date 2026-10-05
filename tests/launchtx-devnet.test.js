// Opt-in: RAMHERD_DEVNET_SIM=1 npm test
//
// Simulates the launch instructions built by server/lib/launchtx.js against
// pump.fun's LIVE devnet programs through a public devnet RPC. Simulation
// only: `sigVerify: false`, nothing is signed, nothing is sent, no key exists.
//
// What this proves and what it does not:
//  - The full four-instruction launch is ~1330 bytes as a plain message and
//    the RPC refuses it (checked below). It fits only with the launch lookup
//    table, which doesn't exist on chain yet, so the full atomic message is
//    NOT simulated here.
//  - Instead the same builder's instructions are simulated in two messages
//    that each fit: [create-fee, create_v2] and [create_v2,
//    create_fee_sharing_config, update_fee_shares]. Together they exercise
//    every instruction the launch contains, against the real programs.
//  - The simulated fee payer is a funded devnet account read from pump's own
//    devnet Global (or RAMHERD_DEVNET_PAYER). Simulation does not need its key.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { OnlinePumpSdk } from '@pump-fun/pump-sdk';
import { buildLaunchInstructions, compileLaunchTransaction, LaunchTxError, DEFAULT_TREASURY } from '../server/lib/launchtx.js';

const enabled = process.env.RAMHERD_DEVNET_SIM === '1';
const skip = enabled ? false : 'set RAMHERD_DEVNET_SIM=1 to simulate against devnet (network)';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

async function fundedPayer(conn) {
  if (process.env.RAMHERD_DEVNET_PAYER) return new PublicKey(process.env.RAMHERD_DEVNET_PAYER);
  const global = await new OnlinePumpSdk(conn).fetchGlobal();
  const candidates = [global.authority, global.feeRecipient, ...(global.feeRecipients || [])].filter(Boolean);
  let best = null;
  let most = 0;
  for (const c of candidates) {
    const info = await conn.getAccountInfo(c);
    if (info && info.owner.equals(SystemProgram.programId) && info.lamports > most) {
      best = c;
      most = info.lamports;
    }
  }
  assert.ok(best && most > 1e9, 'need a funded devnet system account to simulate as payer');
  return best;
}

async function simulate(conn, payer, instructions) {
  const { blockhash } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: instructions.map((i) => i.instruction) }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  return { size: tx.serialize().length, ...sim.value };
}

test('devnet: the launch instructions run against pump.fun\'s live devnet programs (simulation only)', { skip, timeout: 120_000 }, async (t) => {
  const conn = new Connection(RPC, 'confirmed');
  const payer = await fundedPayer(conn);
  const user = payer.toBase58();
  const mint = Keypair.generate().publicKey.toBase58(); // public half only is used
  const ixs = await buildLaunchInstructions({ user, mint, name: 'RAMherd SHA-256 test', symbol: 'RAMT', uri: 'https://ramherd.example/api/launchpad/rams/ram-0001/metadata.json' });
  // (Realistic metadata. The pump-only message stays under 1232 bytes with it.)
  const byLabel = Object.fromEntries(ixs.map((i) => [i.label, i]));

  await t.test('the whole launch without a lookup table is too large to send (so it needs the table)', () => {
    assert.throws(() => compileLaunchTransaction({ instructions: ixs, payer: user, recentBlockhash: '11111111111111111111111111111111' }), (e) => e instanceof LaunchTxError && e.code === 'too_large');
  });

  await t.test('create-fee + create_v2 simulate cleanly', async () => {
    const sim = await simulate(conn, payer, [byLabel['create-fee'], byLabel.create_v2]);
    assert.equal(sim.err, null, JSON.stringify(sim.err) + '\n' + (sim.logs || []).join('\n'));
    assert.ok(sim.logs.some((l) => l.includes(`Program ${SystemProgram.programId.toBase58()} success`)));
  });

  await t.test('create_v2 + create_fee_sharing_config + update_fee_shares (treasury 100%) simulate cleanly', async () => {
    // With realistic metadata even these three are over 1232 bytes as a plain
    // message, so this one uses short metadata (36 bytes total, not the 37 edge).
    const short = await buildLaunchInstructions({ user, mint: Keypair.generate().publicKey.toBase58(), name: 'RAMherd SHA', symbol: 'RAMS', uri: 'https://r.example/m/1' });
    const sim = await simulate(conn, payer, short.slice(1));
    assert.deepEqual(short.slice(1).map((i) => i.label), ['create_v2', 'create_fee_sharing_config', 'update_fee_shares']);
    assert.ok(sim.size <= 1232);
    assert.equal(sim.err, null, JSON.stringify(sim.err) + '\n' + (sim.logs || []).join('\n'));
    assert.ok(sim.logs.some((l) => l.includes('Instruction: UpdateFeeShares')));
    assert.ok(sim.unitsConsumed > 0 && sim.unitsConsumed < 600_000, `CU ${sim.unitsConsumed}`);
    t.diagnostic(`fee-sharing simulation: ${sim.size} bytes, ${sim.unitsConsumed} CU, treasury ${DEFAULT_TREASURY}`);
  });
});
