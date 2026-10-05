#!/usr/bin/env node
// Creates and extends the real mainnet address lookup table the launchpad's
// atomic launch transaction needs to fit under Solana's 1232-byte packet
// limit (server/lib/launchtx.js, launchLookupTableAddresses()).
//
// This is a real, one-time, irreversible mainnet action that spends real SOL
// (table creation + extend rent, plus network fees — a small amount, not
// precisely quoted here on purpose: this script does not guess a number,
// it lets the real transaction simulation report the real cost before you
// confirm). Nobody but you runs this: it reads a local keypair file path,
// never a key pasted anywhere, and never touches this project's own secrets.
//
// Usage:
//   node scripts/create-launch-lookup-table.mjs --keypair ~/.config/solana/id.json [--dry-run]
//
// --dry-run prints what would happen (addresses, table size, a simulation)
// without sending anything. Omit it only once you're ready to actually spend.
//
// On success, it prints the one thing the server needs:
//   fly secrets set --app ramherd-app RAMHERD_LAUNCH_ALT=<table address>
// Nothing here sets that secret for you — a deliberate extra confirmation
// step, same as every other "go live" flag this project uses.

import { readFileSync } from 'node:fs';
import {
  Connection, Keypair, PublicKey, Transaction, AddressLookupTableProgram,
} from '@solana/web3.js';
import { launchLookupTableAddresses } from '../server/lib/launchtx.js';

function parseArgs(argv) {
  const out = { keypair: null, dryRun: false, rpcUrl: null, treasury: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keypair') out.keypair = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--rpc-url') out.rpcUrl = argv[++i];
    else if (a === '--treasury') out.treasury = argv[++i];
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.keypair) {
    console.error('Usage: node scripts/create-launch-lookup-table.mjs --keypair <path to your local Solana keypair JSON> [--dry-run] [--rpc-url <url>] [--treasury <address>]');
    process.exitCode = 1;
    return;
  }

  const secret = JSON.parse(readFileSync(opts.keypair, 'utf8'));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const rpcUrl = opts.rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');

  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`Payer balance: ${(balance / 1e9).toFixed(6)} SOL`);
  if (balance === 0) {
    console.error('Payer wallet has 0 SOL on this cluster. Fund it before continuing.');
    process.exitCode = 1;
    return;
  }

  const addresses = await launchLookupTableAddresses(opts.treasury ? { treasury: opts.treasury } : {});
  console.log(`\n${addresses.length} static addresses to put in the table:`);
  for (const a of addresses) console.log(`  ${a}`);

  const slot = await connection.getSlot('finalized');
  const [createIx, tableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: tableAddress,
    addresses: addresses.map((a) => new PublicKey(a)),
  });

  console.log(`\nLookup table will be created at: ${tableAddress.toBase58()}`);

  const tx = new Transaction().add(createIx, extendIx);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const sim = await connection.simulateTransaction(tx, [payer]);
  if (sim.value.err) {
    console.error('\nSimulation failed, nothing sent:', JSON.stringify(sim.value.err));
    console.error(sim.value.logs?.join('\n') ?? '');
    process.exitCode = 1;
    return;
  }
  console.log(`\nSimulation OK. Estimated compute units: ${sim.value.unitsConsumed ?? 'unknown'}.`);
  console.log('Real cost = this transaction\'s network fee + the lookup table account\'s rent-exempt');
  console.log('minimum (reclaimable later by closing the table) — ask your wallet/RPC for the exact');
  console.log('lamports if you want a number before sending; this script does not invent one.');

  if (opts.dryRun) {
    console.log('\n--dry-run: nothing sent. Re-run without --dry-run to actually create the table on-chain.');
    return;
  }

  console.log('\nSending the real transaction...');
  const sig = await connection.sendTransaction(tx, [payer]);
  console.log(`Sent: ${sig}`);
  await connection.confirmTransaction(sig, 'confirmed');
  console.log('Confirmed.');

  console.log(`\nDone. Lookup table address: ${tableAddress.toBase58()}`);
  console.log('\nLast step (not run by this script — a deliberate separate confirmation):');
  console.log(`  fly secrets set --app ramherd-app RAMHERD_LAUNCH_ALT=${tableAddress.toBase58()}`);
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exitCode = 1;
});
