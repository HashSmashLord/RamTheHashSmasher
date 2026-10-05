// HashRammers: which RAM does /herd#ram/<id> mean? Pure (no DOM), so node tests can run it.
//
// Two kinds of id reach the RAM page:
//   - a slot id (slot-0, slot-7, ...): every RAM on the board, roster or launchpad-owned.
//   - a launchpad RAM id (ram-0001, ...): the stable link a launchpad token's metadata
//     carries as its website (server/lib/rams.js pageUrl). It has to be stable because
//     the metadata is pinned to IPFS at draft time, before the RAM has a slot at all.
//
// Order: the real slot first; if that 404s, the real launchpad record. An active
// launchpad RAM resolves to its own slot. One that hasn't launched (draft, waiting on
// its signature) or never will (cancelled) resolves to an honest "not launched" record:
// no slot, no activity, nothing invented.

/** Launchpad statuses (server/lib/rams.js RAM_STATUSES) that never had a slot. */
export const NOT_LAUNCHED = Object.freeze(["draft", "awaiting-signature", "cancelled"]);

async function getJson(fetchImpl, path) {
  const res = await fetchImpl(path, { credentials: "omit" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/**
 * @param {string} id - whatever followed #ram/
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<
 *   | { kind: "slot", slot: any }
 *   | { kind: "launched", slot: any, ram: any }
 *   | { kind: "not-launched", ram: any }
 *   | null>} null = no such RAM anywhere
 */
export async function resolveRamId(id, { fetchImpl = globalThis.fetch } = {}) {
  const enc = encodeURIComponent(id);
  const direct = await getJson(fetchImpl, `/api/slots/${enc}`);
  if (direct) return { kind: "slot", slot: direct.slot };

  const found = await getJson(fetchImpl, `/api/launchpad/rams/${enc}`);
  if (!found) return null;
  const { ram } = found;
  if (ram.status === "active" && ram.slotId) {
    const owned = await getJson(fetchImpl, `/api/slots/${encodeURIComponent(ram.slotId)}`);
    // Active with a slot id but no such slot should not happen (an owned slot is never
    // retired); if it ever does, say nothing exists rather than invent a page.
    return owned ? { kind: "launched", slot: owned.slot, ram } : null;
  }
  if (NOT_LAUNCHED.includes(ram.status)) return { kind: "not-launched", ram };
  return null;
}
