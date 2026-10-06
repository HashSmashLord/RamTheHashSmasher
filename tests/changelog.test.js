// Unit tests for server/lib/changelog.js: the real GitHub commit-history reader behind
// /api/changelog. Pure, with a fake fetch -- no network, same pattern as tests/pumpfee.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommit, parseCommits, createChangelogSource, createChangelogCache } from '../server/lib/changelog.js';

const REPO = 'HashSmashLord/RamTheHashSmasher';

/** A real-shaped GitHub commits-list entry. */
function rawCommit({
  sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  message = 'Add the Logs page\n\nShows real commits, each linking to GitHub.',
  authorName = 'HashSmashLord',
  login = 'HashSmashLord',
  date = '2026-10-06T12:00:00Z',
  parents = [{ sha: 'parent1sha' }],
} = {}) {
  return {
    sha,
    commit: { message, author: { name: authorName, date } },
    author: login ? { login } : null,
    parents,
  };
}

test('parseCommit: a real-shaped commit parses into a clean record', () => {
  const record = parseCommit(rawCommit());
  assert.deepEqual(record, {
    sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    shortSha: 'a1b2c3d',
    url: `https://github.com/${REPO}/commit/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0`,
    author: 'HashSmashLord',
    date: '2026-10-06T12:00:00Z',
    message: { subject: 'Add the Logs page', body: 'Shows real commits, each linking to GitHub.' },
  });
});

test('parseCommit: a merge commit (more than one parent) is skipped, never shown as a real change', () => {
  const merge = rawCommit({ parents: [{ sha: 'p1' }, { sha: 'p2' }] });
  assert.equal(parseCommit(merge), null);
});

test('parseCommit: a single-parent (or root, no-parent) commit is never mistaken for a merge', () => {
  assert.notEqual(parseCommit(rawCommit({ parents: [{ sha: 'p1' }] })), null);
  assert.notEqual(parseCommit(rawCommit({ parents: [] })), null, 'a repo\'s very first commit has no parents at all');
});

test('parseCommit: a one-line message has an empty body, never undefined or the subject repeated', () => {
  const record = parseCommit(rawCommit({ message: 'Just a subject line' }));
  assert.deepEqual(record.message, { subject: 'Just a subject line', body: '' });
});

test('parseCommit: the GitHub login is preferred when the commit is linked to an account; falls back to the raw git author name otherwise', () => {
  const linked = parseCommit(rawCommit({ authorName: 'Haidar', login: 'HashSmashLord' }));
  assert.equal(linked.author, 'HashSmashLord');

  const unlinked = parseCommit(rawCommit({ authorName: 'Haidar', login: null }));
  assert.equal(unlinked.author, 'Haidar');
});

test('parseCommit: no sha at all -> null, never a half-built record', () => {
  assert.equal(parseCommit({}), null);
  assert.equal(parseCommit(null), null);
});

test('parseCommits: filters merge commits out of a list while keeping the real ones in order', () => {
  const list = [
    rawCommit({ sha: 'sha1'.padEnd(40, '1'), parents: [{ sha: 'p' }] }),
    rawCommit({ sha: 'sha2'.padEnd(40, '2'), parents: [{ sha: 'p1' }, { sha: 'p2' }] }), // merge, dropped
    rawCommit({ sha: 'sha3'.padEnd(40, '3'), parents: [{ sha: 'p' }] }),
  ];
  const parsed = parseCommits(list);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((c) => c.sha), [list[0].sha, list[2].sha]);
});

test('parseCommits: a non-array input is handled as an empty list, never a throw', () => {
  assert.deepEqual(parseCommits(null), []);
  assert.deepEqual(parseCommits(undefined), []);
  assert.deepEqual(parseCommits('not a list'), []);
});

test('createChangelogSource: builds the real GitHub commits URL, sends a User-Agent (GitHub requires one), and parses the response', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, async json() { return [rawCommit()]; } };
  };
  const source = createChangelogSource({ fetchImpl, repo: REPO, perPage: 30 });
  assert.equal(source.kind, 'github');
  assert.equal(source.repo, REPO);
  const commits = await source.fetchCommits();
  assert.equal(calls[0].url, `https://api.github.com/repos/${REPO}/commits?per_page=30`);
  assert.ok(calls[0].opts.headers['User-Agent'], 'GitHub\'s unauthenticated API refuses requests with no User-Agent');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, rawCommit().sha);
});

test('createChangelogSource: a bad HTTP status throws rather than returning an empty list that looks like "no commits"', async () => {
  const source = createChangelogSource({ fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(source.fetchCommits(), /403/);
});

test('createChangelogSource: a non-list response (e.g. GitHub\'s own rate-limit error object) throws rather than silently parsing nothing', async () => {
  const source = createChangelogSource({
    fetchImpl: async () => ({ ok: true, async json() { return { message: 'API rate limit exceeded' }; } }),
  });
  await assert.rejects(source.fetchCommits(), /not a list/);
});

test('createChangelogSource: a merge commit from the real API is dropped end to end', async () => {
  const source = createChangelogSource({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return [rawCommit({ sha: 'real'.padEnd(40, '0'), parents: [{ sha: 'p' }] }), rawCommit({ sha: 'merge'.padEnd(40, '0'), parents: [{ sha: 'p1' }, { sha: 'p2' }] })];
      },
    }),
  });
  const commits = await source.fetchCommits();
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sha, 'real'.padEnd(40, '0'));
});

function fakeSource(commits) {
  const calls = [];
  return {
    kind: 'github',
    repo: REPO,
    calls,
    async fetchCommits() {
      calls.push(Date.now());
      if (commits instanceof Error) throw commits;
      return commits;
    },
  };
}

test('createChangelogCache: refresh() populates the cache and stamps updatedAt on a real success', async () => {
  const commits = [parseCommit(rawCommit())];
  const cache = createChangelogCache({ source: fakeSource(commits) });
  assert.deepEqual(cache.getSnapshot(), { commits: [], updatedAt: null, repo: REPO }, 'nothing served before the first real fetch');
  await cache.refresh();
  const snap = cache.getSnapshot();
  assert.deepEqual(snap.commits, commits);
  assert.ok(snap.updatedAt, 'a real ISO timestamp was stamped');
  assert.equal(snap.repo, REPO);
});

test('createChangelogCache: a fetch failure logs and keeps serving the last good cached list -- never crashes, never empties a real cache', async () => {
  const goodCommits = [parseCommit(rawCommit())];
  const source = fakeSource(goodCommits);
  const logs = [];
  const cache = createChangelogCache({ source, log: (l) => logs.push(l) });

  await cache.refresh(); // first, successful fetch
  const goodSnapshot = cache.getSnapshot();
  assert.equal(goodSnapshot.commits.length, 1);

  // Swap the source to fail, the way a real GitHub hiccup would.
  source.fetchCommits = async () => { throw new Error('GitHub is down'); };
  await cache.refresh();
  const afterFailure = cache.getSnapshot();
  assert.deepEqual(afterFailure.commits, goodSnapshot.commits, 'the last good list is still served');
  assert.equal(afterFailure.updatedAt, goodSnapshot.updatedAt, 'updatedAt is not bumped on a failed refresh');
  assert.ok(logs.some((l) => l.includes('GitHub is down') && l.includes('keeping the last good cache')));
});

test('createChangelogCache: a failure before any successful fetch logs and leaves an honest, empty cache -- not a crash', async () => {
  const logs = [];
  const cache = createChangelogCache({ source: fakeSource(new Error('rate limited')), log: (l) => logs.push(l) });
  await cache.refresh();
  assert.deepEqual(cache.getSnapshot(), { commits: [], updatedAt: null, repo: REPO });
  assert.ok(logs.some((l) => l.includes('rate limited') && l.includes('no cache yet')));
});

test('createChangelogCache: getSnapshot() hands back a copy -- mutating the result never corrupts the cache', async () => {
  const cache = createChangelogCache({ source: fakeSource([parseCommit(rawCommit())]) });
  await cache.refresh();
  const snap = cache.getSnapshot();
  snap.commits.push('not a real commit');
  assert.equal(cache.getSnapshot().commits.length, 1, 'the pushed junk never touched the real cache');
});

test('createChangelogCache requires its real collaborator, never silently running with none', () => {
  assert.throws(() => createChangelogCache({}), TypeError);
  assert.throws(() => createChangelogCache({ source: {} }), TypeError);
});
