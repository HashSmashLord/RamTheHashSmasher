// HashRammers: pure helpers for Discover (/discover) — which launched RAMs to show and how
// to link to them. No DOM, no fetch: node tests import this directly, same pattern as
// ram-resolve.js and launchpad-rules.js.
//
// "Launched" means server/lib/rams.js RAM_STATUSES 'active': the operator confirmed the
// launch transaction's signature and approved the owner's brief, and the RAM's funding
// account and owned slot both exist. A draft (saved, never signed), an awaiting-signature
// RAM (signature not yet confirmed) or a cancelled one is a private, unfinished or abandoned
// request — never shown here. See src/ram-resolve.js's own NOT_LAUNCHED list, which this
// mirrors from the other side (everything NOT in it, for a real list instead of one id).

/** The one RAM_STATUSES value that means "actually launched", per server/lib/rams.js. */
export const LAUNCHED_STATUS = "active";

/** True once a launchpad RAM has actually launched (confirmed signature, owned slot exists). */
export function isLaunched(ram) {
  return Boolean(ram) && ram.status === LAUNCHED_STATUS;
}

/**
 * Every real launched RAM out of a GET /api/launchpad/rams list, newest launch first ("the
 * last made tokens"). Sorted by `updatedAt`, not `createdAt`: server/lib/rams.js only bumps
 * updatedAt on a status change (touch()), and nothing after confirmLaunch() touches an active
 * RAM's record again (recordCreatorFees/recordWin credit funds, never the RAM itself) — so for
 * every launched RAM, updatedAt is frozen at the exact moment confirmLaunch() made it active.
 * createdAt is the earlier, less honest answer: it's when the draft was first started, which
 * for a RAM someone sat on for days before launching is not "last made" at all. A RAM missing
 * updatedAt (should not happen for an active one) sorts after ones that have it, rather than
 * crashing or jumping the queue.
 */
export function launchedRams(rams) {
  if (!Array.isArray(rams)) return [];
  return sortRams(rams.filter(isLaunched), "newest");
}

/**
 * Sorts an already-filtered list of RAMs by launch time. `order` is "newest" (default,
 * matches launchedRams) or "oldest". Same `updatedAt` field and same missing-value handling
 * as launchedRams -- see its own comment for why updatedAt, not createdAt, is "when it launched".
 */
export function sortRams(rams, order = "newest") {
  if (!Array.isArray(rams)) return [];
  const list = [...rams];
  const time = (r) => (r?.updatedAt ? Date.parse(r.updatedAt) : -Infinity);
  list.sort((a, b) => (order === "oldest" ? time(a) - time(b) : time(b) - time(a)));
  return list;
}

/**
 * True if `ram`'s token name or symbol contains `query`, case-insensitively. An empty/
 * whitespace-only query matches everything (the default, unfiltered state).
 */
export function matchesQuery(ram, query) {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q) return true;
  const token = ram && ram.token;
  if (!token) return false;
  const name = typeof token.name === "string" ? token.name.toLowerCase() : "";
  const symbol = typeof token.symbol === "string" ? token.symbol.toLowerCase() : "";
  return name.includes(q) || symbol.includes(q);
}

/** "SHA-256 r31": the same short round label the herd board prints (src/ui.js roundShort), built from the RAM's own recorded fields — never the track id's raw string. */
export function ramRoundLabel(ram) {
  return ram && ram.hashFamily && ram.rounds != null ? `${ram.hashFamily} r${ram.rounds}` : "";
}

/**
 * The token's own image. The pinned IPFS gateway URL once Pinata has pinned it
 * (server/lib/rams.js createDraft), else this server's own self-hosted route for the same
 * image id (server/launchpad-routes.js getImage) — never a guessed path. Null only if the
 * RAM record itself is missing a token or an image id (should not happen for a launched RAM:
 * every draft requires an uploaded image before it can exist).
 */
export function tokenImageUrl(ram) {
  const token = ram && ram.token;
  if (!token) return null;
  if (token.image) return token.image;
  if (token.imageId) return `/api/launchpad/images/${encodeURIComponent(token.imageId)}`;
  return null;
}

/**
 * pump.fun's own page for this token, built only from the real mint the server recorded
 * when the launch transaction was prepared (server/lib/rams.js prepareLaunch). Null — never
 * guessed — when no mint is on record for this RAM.
 */
export function pumpFunUrl(ram) {
  const mint = ram && ram.token && ram.token.mint;
  return typeof mint === "string" && mint ? `https://pump.fun/coin/${encodeURIComponent(mint)}` : null;
}
