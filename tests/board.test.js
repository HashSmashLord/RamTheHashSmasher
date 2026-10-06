// The herd board's live scroll-jump fix (src/board.js render()/refreshDesks()).
//
// The shipped fix (commit 5f0626b, 2026-10-06) snapshots window.scrollY synchronously
// before a tick's DOM mutations and restores it right after, replacing an earlier
// ResizeObserver-based attempt that was real-tested and made production WORSE (continuous
// drift). That synchronous snapshot/restore already covers tile-count growth generically
// (any mutation, including grid.appendChild for a new tile, happens before the check) --
// but each tile also kicks off its own async desk check (sandbox-viewer.js's refresh(),
// a fetch) that was fire-and-forget, so its DOM work could still land AFTER the
// synchronous check already ran and returned. These tests prove render() and
// refreshDesks() now await that work first, closing the timing gap, without reaching for
// a persistent observer again.
//
// There is no real layout engine here (no jsdom in this repo -- see sandbox-viewer.test.js
// for the same hand-rolled-DOM convention). A specific, called-out mutation point (grid
// append, or a desk load() resolving) nudges the fake window.scrollY itself, standing in
// for whatever a real browser's layout engine would do; the thing under test is the
// *sequencing* -- does the restore check run after all of this tick's DOM work, sync and
// async alike -- not the real CSS math (covered separately by reading styles.css: .screen
// is a fixed aspect-ratio box, overflow:hidden, every bit of desk content inside it
// position:absolute, so in production today a desk check settling late reflows nothing --
// this is defense-in-depth against that ever changing, not a fix for an observed jump).

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFakeBrowser } from './helpers/fake-browser.js';

const browser = installFakeBrowser();

function agent(id, overrides = {}) {
  return {
    id,
    liveLabel: '1h',
    roundLabel: 'SHA-256 r31',
    trackLabel: 'SHA-256 · r31 · exploratory',
    lanePath: 'lanes/exploratory/candidates/sha256-r31/',
    model: 'demo-model',
    approach: 'demo approach',
    activity: 'doing a thing',
    status: 'idle',
    updatedLabel: '8s ago',
    updatedSecondsAgo: 8,
    judge: null,
    log2T: null,
    slotId: `slot-${id}`,
    ...overrides,
  };
}

/** A feed whose `load` is a stable reference that delegates to a swappable function, so a
 * test can change timing/behaviour between render()/refreshDesks() calls without having to
 * rebuild tiles (board.js captures `feed.load` once, per tile, at build time). */
function makeFeed(initialLoad) {
  let current = initialLoad;
  return {
    load: (slotId) => current(slotId),
    refresh: async () => {},
    setLoad(fn) {
      current = fn;
    },
  };
}

const immediateIdle = async () => ({ state: 'idle', enabled: true });

/** Resolves after a real macrotask (setTimeout), bumping window.scrollY by `bump` right
 * when it resolves -- simulating "this tile's own async desk check landed, and whatever it
 * changed shifted the page" at the moment it actually happens, not before. */
function delayedIdle(bump) {
  return () =>
    new Promise((resolve) => {
      setTimeout(() => {
        browser.window.scrollY += bump;
        resolve({ state: 'idle', enabled: true });
      }, 5);
    });
}

async function mountFreshBoard(feed, getFleet) {
  const grid = browser.freshGrid();
  // mountBoard() calls $("tiles") once at mount time; freshGrid() just registered it, so
  // the board's internal `grid` reference is this exact object -- patching its methods
  // after this call (as the first test does) still reaches board.js's own copy.
  const { mountBoard } = await import('../src/board.js');
  return { board: mountBoard({ feed, getFleet }), grid };
}

test('render(): several new tiles in one tick (roster growth) do not leave scroll shifted', async () => {
  const feed = makeFeed(immediateIdle);
  const fleet = [agent('ram-1'), agent('ram-2'), agent('ram-3'), agent('ram-4'), agent('ram-5')];
  const { board, grid } = await mountFreshBoard(feed, async () => fleet);

  // Simulate a real reflow on every tile actually entering the grid -- the one DOM mutation
  // that's always synchronous, inside the loop the existing scrollY check already guards.
  const realAppendChild = grid.appendChild.bind(grid);
  grid.appendChild = (kid) => {
    browser.window.scrollY += 50;
    return realAppendChild(kid);
  };

  browser.window.scrollY = 1200;
  const returned = await board.render();

  assert.equal(returned.length, 5);
  assert.equal(grid.children.length, 5, 'all 5 new tiles were actually appended');
  assert.equal(browser.window.scrollY, 1200, 'scroll was restored despite 5 tiles worth of (simulated) reflow');
});

test('render(): a new tile whose own desk check settles after the mutation loop still gets caught', async () => {
  const feed = makeFeed(delayedIdle(77));
  const fleet = [agent('ram-6')];
  const { board } = await mountFreshBoard(feed, async () => fleet);

  browser.window.scrollY = 900;
  await board.render();
  // Give any *unawaited* stray timer a chance to fire too, so this test actually
  // distinguishes "render() wiaited it and already restored" from "render() returned
  // before the bump even happened, and nothing is checking any more" -- without this, an
  // unfixed render() would pass here for the wrong reason (the assertion would simply run
  // before the 5ms delayedIdle() bump fires at all).
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    browser.window.scrollY,
    900,
    'render() awaited the new tile\'s own (delayed) desk check before its final scrollY check, so the late shift was caught',
  );
});

test('sanity check on the test above: an unawaited desk check really does let the same late shift slip through', async () => {
  // Not a claim about shipped behaviour -- this reproduces, directly, the fire-and-forget
  // shape render() used to have (kick off the load, check scrollY immediately, never look
  // again), to prove the previous test is actually exercising the fix and would fail
  // without it.
  const feed = makeFeed(delayedIdle(77));

  browser.window.scrollY = 300;
  const scrollY = browser.window.scrollY;
  const stray = feed.load('slot-ram-7'); // kicked off, but not awaited -- the old shape
  if (browser.window.scrollY !== scrollY) browser.window.scrollTo(0, scrollY);
  assert.equal(browser.window.scrollY, scrollY, 'no shift yet -- the delayed load has not resolved');
  await stray; // let the delayed bump actually happen
  assert.notEqual(
    browser.window.scrollY,
    scrollY,
    'once it resolves late, with nothing awaiting it the shift is never corrected -- the bug render() now avoids by awaiting it',
  );
});

test('refreshDesks(): waits for every tile\'s own desk check, so a caller checking scrollY right after it sees the settled state', async () => {
  const feed = makeFeed(immediateIdle);
  const fleet = [agent('ram-8'), agent('ram-9')];
  const { board } = await mountFreshBoard(feed, async () => fleet);
  await board.render(); // builds the two tiles with the immediate loader

  // Now simulate the 10s poll (herd.js's setInterval): each tile's desk check is slow this
  // time, and settling it shifts the page a little.
  feed.setLoad(delayedIdle(40));

  browser.window.scrollY = 500;
  const scrollY = browser.window.scrollY;
  await board.refreshDesks(); // herd.js awaits this before its own scrollY check
  if (browser.window.scrollY !== scrollY) browser.window.scrollTo(0, scrollY);
  assert.equal(browser.window.scrollY, scrollY, 'both tiles\' delayed desk checks had already landed by the time refreshDesks() resolved');

  // Contrast: calling it without awaiting (the old shape) checks before the delayed work
  // has landed, so the later shift is never corrected -- same demonstration as above, at
  // the refreshDesks() entry point herd.js actually uses.
  feed.setLoad(delayedIdle(40));
  browser.window.scrollY = 500;
  const scrollY2 = browser.window.scrollY;
  const pending = board.refreshDesks(); // not awaited
  if (browser.window.scrollY !== scrollY2) browser.window.scrollTo(0, scrollY2);
  assert.equal(browser.window.scrollY, scrollY2, 'checked too early: nothing has shifted yet');
  await pending; // let the delayed bumps actually happen before the test exits
  assert.notEqual(browser.window.scrollY, scrollY2, 'the shift landed after the (unawaited) check, so it was never corrected');
});
