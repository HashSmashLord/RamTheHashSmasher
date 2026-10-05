// Per-RAM funding ledger for user-created (launchpad) RAMs.
//
// Separate from the shared pool ledger (ledger.js) on purpose: a launchpad
// RAM is funded by its own 0.2 SOL create fee and by the creator fees of its
// own token, and its compute spend is charged to it alone. Nothing here moves
// money. Entries are append-only records of what was paid in (as reported by
// the operator / a future on-chain reader) and what compute was charged.
//
// Lamports are integers (Number.isSafeInteger) so totals are exact; compute
// spend is in USD like the rest of the backend.

const CREDIT_KINDS = new Set(['create-fee', 'creator-fees']);

export function createRamFunds({ now = () => new Date().toISOString() } = {}) {
  /** @type {Map<string, { ramId: string, owner: string, openedAt: string, entries: any[] }>} */
  const accounts = new Map();

  function requireAccount(ramId) {
    const acct = accounts.get(ramId);
    if (!acct) throw new RangeError(`no funding account for RAM ${ramId}`);
    return acct;
  }

  function view(acct) {
    const totals = { createFeeLamports: 0, creatorFeesLamports: 0, computeSpentUsd: 0 };
    for (const e of acct.entries) {
      if (e.kind === 'create-fee') totals.createFeeLamports += e.lamports;
      else if (e.kind === 'creator-fees') totals.creatorFeesLamports += e.lamports;
      else if (e.kind === 'compute') totals.computeSpentUsd += e.usd;
    }
    totals.computeSpentUsd = Math.round(totals.computeSpentUsd * 1e6) / 1e6;
    return { ramId: acct.ramId, owner: acct.owner, openedAt: acct.openedAt, totals, entries: acct.entries.map((e) => ({ ...e })) };
  }

  function open(ramId, owner) {
    if (accounts.has(ramId)) throw new Error(`RAM ${ramId} already has a funding account`);
    const acct = { ramId, owner, openedAt: now(), entries: [] };
    accounts.set(ramId, acct);
    return view(acct);
  }

  /** Records lamports paid in for this RAM. Never a transfer: a record of one. */
  function credit(ramId, { kind, lamports, ref = null, note = '' }) {
    const acct = requireAccount(ramId);
    if (!CREDIT_KINDS.has(kind)) throw new RangeError(`credit kind must be one of: ${[...CREDIT_KINDS].join(', ')}`);
    if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new RangeError('lamports must be a positive integer');
    if (kind === 'create-fee' && acct.entries.some((e) => e.kind === 'create-fee')) {
      throw new Error(`RAM ${ramId} already has its create fee recorded`);
    }
    acct.entries.push({ seq: acct.entries.length, ts: now(), kind, lamports, ref, note: String(note).slice(0, 200) });
    return view(acct);
  }

  /** Charges compute (USD) to this RAM alone. */
  function chargeCompute(ramId, { usd, ref = null, note = '' }) {
    const acct = requireAccount(ramId);
    if (!Number.isFinite(usd) || usd <= 0) throw new RangeError('usd must be a positive number');
    acct.entries.push({ seq: acct.entries.length, ts: now(), kind: 'compute', usd, ref, note: String(note).slice(0, 200) });
    return view(acct);
  }

  return {
    open,
    credit,
    chargeCompute,
    get: (ramId) => (accounts.has(ramId) ? view(accounts.get(ramId)) : undefined),
    list: () => [...accounts.values()].map(view),
  };
}
