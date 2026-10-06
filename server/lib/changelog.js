// Real changelog: this repo's own public commit history, read straight from GitHub's
// public REST API (no auth, no key -- the repo is already public). Lets the site show,
// honestly, what actually changed and when, each line linking to the real commit on
// GitHub rather than a hand-written release note that can drift from reality.
//
// Always-on, unlike every opt-in integration elsewhere in this codebase (pumpfee.js,
// sandbox.js, pinata.js, ...): those gate real network access behind an env flag because
// they touch money, cost real compute, or need a secret. This reads one public repo's
// public commit list -- no secret, no cost, nothing sensitive to opt out of being honest
// about -- so it needs no RAMHERD_* flag; see server/store.js for where it's wired in.
//
// Cached in memory and refreshed on a timer (server/index.js), same pattern as
// server/lib/pumpfee.js's periodic refresh: never fetched per-request, both to respect
// GitHub's unauthenticated rate limit (60 requests/hour per IP) and so a slow or down
// GitHub never slows down a real page load. A failed refresh logs and keeps serving
// whatever the last successful fetch produced -- never crashes, never empties a list
// that has real data in it.

const DEFAULT_REPO = 'HashSmashLord/RamTheHashSmasher';

/**
 * One real GitHub commit (the API's own shape) -> a clean record, or null for a merge
 * commit (more than one parent): a merge is a bookkeeping event, not one real, reviewable
 * change, and would otherwise show up twice (once as itself, once as what it merged).
 *
 * @param {any} raw - one entry from GitHub's GET /repos/:owner/:repo/commits response
 * @param {{ repo?: string }} [opts]
 * @returns {{ sha: string, shortSha: string, url: string, author: string, date: string|null, message: { subject: string, body: string } } | null}
 */
export function parseCommit(raw, { repo = DEFAULT_REPO } = {}) {
  if (!raw || typeof raw.sha !== 'string' || !raw.sha) return null;
  const parents = Array.isArray(raw.parents) ? raw.parents : [];
  if (parents.length > 1) return null; // a merge commit, skipped -- see header

  const sha = raw.sha;
  const rawMessage = typeof raw.commit?.message === 'string' ? raw.commit.message : '';
  const newlineIndex = rawMessage.indexOf('\n');
  const subject = (newlineIndex === -1 ? rawMessage : rawMessage.slice(0, newlineIndex)).trim();
  const body = newlineIndex === -1 ? '' : rawMessage.slice(newlineIndex + 1).replace(/^\n+/, '').trim();
  // The GitHub account's login when the commit is linked to one; otherwise the git
  // author's own name straight from the commit object (always present on a real commit).
  const author = raw.author?.login || raw.commit?.author?.name || 'unknown';
  const date = raw.commit?.author?.date || null;

  return {
    sha,
    shortSha: sha.slice(0, 7),
    url: `https://github.com/${repo}/commit/${sha}`,
    author,
    date,
    message: { subject, body },
  };
}

/** Parses a whole GitHub commits-list response, dropping merge commits and keeping order (newest first, as GitHub sends it). */
export function parseCommits(rawList, opts) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map((raw) => parseCommit(raw, opts)).filter(Boolean);
}

/**
 * The real source: one GitHub API call, parsed into clean records. Stateless -- holds no
 * cache of its own; `createChangelogCache` below is what a long-running server actually
 * calls on a timer.
 *
 * @param {{ fetchImpl?: typeof fetch, repo?: string, perPage?: number }} [opts]
 */
export function createChangelogSource({ fetchImpl = fetch, repo = DEFAULT_REPO, perPage = 30 } = {}) {
  return {
    kind: 'github',
    repo,
    async fetchCommits() {
      // GitHub's unauthenticated REST API refuses requests with no User-Agent header
      // (403), and Accept pins the exact response shape this module parses.
      const url = `https://api.github.com/repos/${repo}/commits?per_page=${perPage}`;
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HashRammers-changelog' },
      });
      if (!res.ok) throw new Error(`GitHub commits fetch failed: ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error('GitHub commits response was not a list');
      return parseCommits(body, { repo });
    },
  };
}

/**
 * Wraps a changelog source with an in-memory cache, refreshed by whoever calls
 * `refresh()` (server/index.js, on a timer) -- same split as ledger.js's
 * source/createFeeLedger. A failed refresh logs and leaves the existing cache alone, so
 * the API route never serves nothing just because one GitHub poll hiccuped.
 *
 * @param {{ source: { fetchCommits: () => Promise<any[]>, repo?: string }, log?: (line: string) => void }} opts
 */
export function createChangelogCache({ source, log = () => {} }) {
  if (!source || typeof source.fetchCommits !== 'function') {
    throw new TypeError('createChangelogCache requires a source with fetchCommits()');
  }
  let commits = [];
  let updatedAt = null;
  let hasFetchedOnce = false;

  async function refresh() {
    try {
      const fetched = await source.fetchCommits();
      commits = fetched;
      updatedAt = new Date().toISOString();
      hasFetchedOnce = true;
    } catch (err) {
      log(
        `changelog: refresh failed, ${hasFetchedOnce ? 'keeping the last good cache' : 'no cache yet'}: ${err?.message || err}`
      );
    }
    return getSnapshot();
  }

  function getSnapshot() {
    return { commits: commits.slice(), updatedAt, repo: source.repo ?? null };
  }

  return { refresh, getSnapshot };
}
