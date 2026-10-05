// Payout book: "this wallet is owed X, here's why, here's the record."
//
// Bookkeeping only. There is no code anywhere in this project that sends a
// payout: no key, no signer, no transfer builder for it. When a user-created
// RAM's submission is ACCEPTED in HashSmash's own judged review, an owed
// record is written here. The operator pays it by hand, outside this system,
// and may then record the transaction signature they used (`recordSent`),
// which only annotates the record — it does not check or move anything.
//
// One record per (RAM, candidate): recording the same win twice returns the
// existing record; recording it again with a different amount or wallet is an
// error rather than a silent second payout.

import bs58 from 'bs58';

export const PAYOUT_STATUSES = Object.freeze(['owed', 'sent-by-operator']);

function isSignature(value) {
  if (typeof value !== 'string') return false;
  try {
    return bs58.decode(value).length === 64;
  } catch {
    return false;
  }
}

export function createPayoutBook({ now = () => new Date().toISOString(), idPrefix = 'payout' } = {}) {
  /** @type {Map<string, any>} */
  const records = new Map();
  const byWin = new Map();
  let seq = 0;

  const copy = (r) => JSON.parse(JSON.stringify(r));

  /**
   * @param {{ ramId: string, wallet: string, lamports: number, track: string,
   *           candidateRef: string, verdict: string, evidence?: string }} win
   */
  function recordOwed({ ramId, wallet, lamports, track, candidateRef, verdict, evidence = '' }) {
    if (verdict !== 'accepted') throw new Error('only a submission ACCEPTED in HashSmash review creates a payout');
    if (typeof ramId !== 'string' || !ramId) throw new TypeError('ramId is required');
    if (typeof wallet !== 'string' || !wallet) throw new TypeError('wallet is required');
    if (typeof candidateRef !== 'string' || !candidateRef.trim()) throw new TypeError('candidateRef is required');
    if (!Number.isSafeInteger(lamports) || lamports <= 0) throw new RangeError('lamports must be a positive integer');

    const key = `${ramId}::${candidateRef.trim()}`;
    const existing = byWin.get(key);
    if (existing) {
      const rec = records.get(existing);
      if (rec.lamports !== lamports || rec.wallet !== wallet) {
        throw new Error(`win ${key} is already recorded as ${rec.id} with a different amount or wallet`);
      }
      return { record: copy(rec), created: false };
    }
    const rec = {
      id: `${idPrefix}-${seq++}`,
      status: 'owed',
      wallet,
      lamports,
      reason: `RAM ${ramId}'s submission ${candidateRef.trim()} on ${track} was accepted in HashSmash's judged review.`,
      ramId,
      track,
      candidateRef: candidateRef.trim(),
      verdict,
      evidence: String(evidence).slice(0, 500),
      createdAt: now(),
      sent: null,
    };
    records.set(rec.id, rec);
    byWin.set(key, rec.id);
    return { record: copy(rec), created: true };
  }

  /**
   * Annotates an owed record with the signature of a transfer the OPERATOR
   * made by hand. Nothing is verified or sent from here.
   */
  function recordSent(id, { signature, note = '' }) {
    const rec = records.get(id);
    if (!rec) throw new RangeError(`unknown payout id: ${id}`);
    if (rec.status !== 'owed') throw new Error(`payout ${id} is already ${rec.status}`);
    if (!isSignature(signature)) throw new TypeError('signature must be a base58 transaction signature');
    rec.status = 'sent-by-operator';
    rec.sent = { signature, note: String(note).slice(0, 200), recordedAt: now() };
    return copy(rec);
  }

  function list({ wallet, status, ramId } = {}) {
    return [...records.values()]
      .filter((r) => (!wallet || r.wallet === wallet) && (!status || r.status === status) && (!ramId || r.ramId === ramId))
      .map(copy);
  }

  function owedTo(wallet) {
    return list({ wallet, status: 'owed' }).reduce((sum, r) => sum + r.lamports, 0);
  }

  return { recordOwed, recordSent, list, owedTo, get: (id) => (records.has(id) ? copy(records.get(id)) : undefined) };
}
