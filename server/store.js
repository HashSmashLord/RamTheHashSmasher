// Wires the modules in server/lib together into one app state object.
// This is the only place that builds the coordinator's read-only view, so
// it's also the only place that could accidentally hand the coordinator a
// mutator — kept deliberately tiny and reviewed as such.

import { join } from 'node:path';
import { Connection } from '@solana/web3.js';
import { createMockFeeSource, createFeeLedger } from './lib/ledger.js';
import { createPumpFeeSource, createCoinGeckoPriceSource, createCoinGeckoZecPriceSource, createJupiterPriceSource, connectionAdapter as pumpFeeConnectionAdapter, pumpFeePolicy } from './lib/pumpfee.js';
import { computeAllocation, withLaunchCeiling } from './lib/budget.js';
import { createSlotManager } from './lib/slots.js';
import { createCoordinator, createCoordinatorView } from './lib/coordinator.js';
import { createIdeaQueue } from './lib/moderation.js';
import { createLlmProvider, modelOverride, isLiveMode } from './lib/llm.js';
import { createHashSmashRunner, pipelinePolicy } from './lib/hashsmash.js';
import { createSandboxManager, sandboxPolicy } from './lib/sandbox.js';
import { runWorkbenchTask } from './lib/sandbox-task.js';
import { contextBanner } from './lib/sandbox-context.js';
import { desktopActivity } from './lib/sandbox-activity.js';
import { realResearchTools } from './lib/research-tools.js';
import * as yukonSandbox from './lib/yukon-sandbox.js';
import { liveSubmitPolicy, createLiveSubmissionLedger } from './lib/live-submit.js';
import { createCostLedger } from './lib/cost.js';
import { createRamFunds } from './lib/ramfunds.js';
import { createPayoutBook } from './lib/payouts.js';
import { createRamRegistry } from './lib/rams.js';
import { createPinataClient, pinataPolicy } from './lib/pinata.js';
import { createChangelogSource, createChangelogCache } from './lib/changelog.js';

/**
 * @param {{
 *   budgetConfig: import('./lib/budget.js').BudgetConfig,
 *   env?: NodeJS.ProcessEnv,
 *   loadSandboxSdk?: () => Promise<{ Sandbox: any }>,
 *   launchpad?: { publicBaseUrl: string, treasury: string, rpcUrl?: string },
 *   log?: (line: string) => void,
 * }} opts
 */
export function createStore({ budgetConfig, env = process.env, loadSandboxSdk, launchpad = { publicBaseUrl: 'http://127.0.0.1:4700', treasury: undefined, rpcUrl: undefined }, log = () => {} }) {
  // "Fees collected, lifetime" (the homepage's own stat): real pump.fun creator-fee
  // distributions to the treasury, read straight off chain -- opt-in with
  // RAMHERD_FEE_SOURCE=onchain (server/lib/pumpfee.js); the mock (admin/auto-seed-set
  // number) stays the default everywhere else, including every existing test, exactly
  // like every other opt-in real integration in this file.
  const pumpFee = pumpFeePolicy(env);
  // Same opt-in persistence pattern as rams.js/moderation.js below (RAMHERD_DATA_DIR,
  // unset = in-memory only): real bug, found 2026-10-06, the operator saw the real
  // "Fees collected, lifetime" figure regress/recompute across restarts because the
  // scan state (totalLamports, scan position) lived only in memory. See pumpfee.js's
  // createPumpFeeSource header for the full story.
  const pumpFeePersistPath = env.RAMHERD_DATA_DIR ? join(env.RAMHERD_DATA_DIR, 'pumpfee.json') : null;
  const feeSource =
    pumpFee.enabled && launchpad.treasury
      ? createPumpFeeSource({
          connection: pumpFeeConnectionAdapter(new Connection(launchpad.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed')),
          treasury: launchpad.treasury,
          priceSource: createCoinGeckoPriceSource(),
          persistPath: pumpFeePersistPath,
          log,
          // CollectCoinCreatorFee (post-migration) fees are paid in the migrated token
          // itself, not SOL -- found real 2026-10-06 after the operator reported real
          // fees well above what the SOL-only mechanism alone was counting.
          tokenPriceSource: createJupiterPriceSource(),
          log,
        })
      : createMockFeeSource();
  const ledger = createFeeLedger({ source: feeSource });
  // A real ZEC/USD price, cached (never fetched per-request) and refreshed on the same
  // cadence as the fee ledger itself (server/index.js). Purely a second, real way to show
  // the one real USD fee total pumpfee.js already has -- not a separate ZEC-denominated
  // source, and never guessed: null until the first real fetch succeeds.
  const zecPriceSource = pumpFee.enabled ? createCoinGeckoZecPriceSource() : null;
  let zecUsdPrice = null;
  async function refreshZecPrice() {
    if (!zecPriceSource) return null;
    zecUsdPrice = await zecPriceSource.fetchZecUsd();
    return zecUsdPrice;
  }
  function totalZec() {
    if (zecUsdPrice === null) return null;
    const { totalUsd } = ledger.getSnapshot();
    return Math.round((totalUsd / zecUsdPrice) * 1e6) / 1e6;
  }
  const llmProvider = createLlmProvider(env);
  // Real HashSmash pipeline: opt-in with RAMHERD_PIPELINE=local (off by
  // default). Its credential-free stages are local and free; the paid judge
  // stage needs the live LLM gate plus RAMHERD_HASHSMASH_JUDGE=true; live
  // competition submission needs RAMHERD_HASHSMASH_LIVE_SUBMIT (see below).
  const pipeline = pipelinePolicy(env);
  const pipelineRunner = pipeline.enabled
    ? createHashSmashRunner({ judgeAllowed: pipeline.judgeAllowed, env })
    : null;
  // E2B desktop sandboxes: opt-in with RAMHERD_SANDBOX=e2b (off by default).
  // Without the flag no manager exists and the SDK is never imported, even if
  // E2B_API_KEY is set. With the flag but no key, sandboxes stay off too.
  const sandbox = sandboxPolicy(env);
  const sandboxManager = sandbox.ready
    ? createSandboxManager({
        apiKey: env.E2B_API_KEY,
        template: sandbox.template,
        timeoutMs: sandbox.timeoutMs,
        maxConcurrent: sandbox.maxConcurrent,
        reconcileMs: sandbox.reconcileMs,
        ...(loadSandboxSdk ? { loadSdk: loadSandboxSdk } : {}),
      })
    : null;
  // Launchpad: user-created RAMs, each with its own funding account and owned
  // slot, plus the payout book for judged wins. Bookkeeping only: nothing in
  // these modules can sign, send or claim.
  const ramFunds = createRamFunds();
  const payouts = createPayoutBook();

  // Per-RAM compute spend (tokens + real USD), backend-only — see cost.js.
  // Not exposed on any route yet, by design: the figures should exist before
  // the frontend has anywhere to put them. An owned RAM's own LLM calls also
  // charge its funding account (ramfunds.js already totals "compute" there
  // for the launchpad), so that account's USD total was never missing this;
  // a roster RAM has no funding account to charge, so costLedger is the only
  // record of its spend. `chargeCompute` throws if `ramId`'s account isn't
  // open yet (e.g. a slot created directly in a test with no registered
  // RAM) — caught and skipped rather than ever letting cost tracking crash
  // a real "thinking" step.
  const costLedger = createCostLedger();
  const baseRecord = costLedger.record;
  costLedger.record = (entry) => {
    baseRecord(entry);
    if (entry.ramId && typeof entry.usage?.costUsd === 'number' && entry.usage.costUsd > 0) {
      try {
        ramFunds.chargeCompute(entry.ramId, { usd: entry.usage.costUsd, ref: entry.ref, note: `LLM call (${entry.model || 'unknown model'})` });
      } catch {
        // RAM has no open funding account (not this project's launchpad flow) — cost stays recorded in costLedger alone.
      }
    }
  };

  // Each slot calls its own roster model unless RAMHERD_LLM_MODEL forces one
  // model on all of them. Mock vs live is still only llm.js's decision.
  // Auto-restart of roster RAMs' sandboxes after E2B's hard timeout: opt-in
  // with RAMHERD_SANDBOX_AUTORESTART=true on top of RAMHERD_SANDBOX=e2b (off by
  // default; every restart bills). Owned slots are never auto-restarted.
  const autoRestart = sandboxManager && sandbox.autoRestart
    ? { enabled: true, baseDelayMs: sandbox.autoRestartBaseDelayMs, maxDelayMs: sandbox.autoRestartMaxDelayMs, maxFailures: sandbox.autoRestartMaxFailures }
    : null;
  // Always-on research loop: opt-in with RAMHERD_SANDBOX_ACTIVE_LOOP=true on
  // top of RAMHERD_SANDBOX=e2b. `live` is llm.js's own switch: in mock mode the
  // loop never starts (slots.js says so in the feed instead).
  const activeLoop = sandboxManager && sandbox.activeLoop
    ? {
      enabled: true, live: isLiveMode(env), stepPauseMs: sandbox.activeLoopStepPauseMs, browseEvery: sandbox.activeLoopBrowseEvery,
      maxThinkingPerSession: sandbox.activeLoopMaxThinking, maxDraftAttemptsPerSession: sandbox.activeLoopMaxDraftAttempts,
    }
    : null;
  // The loop's real research tools (research-tools.js): bounded EXPERIMENT runs
  // on a worker thread and VERIFY of a candidate pair, both against the track's
  // exact reduced-round target. Host CPU only, no paid call, no network; wired
  // whenever the loop itself is. A reported pair is also recomputed by the
  // organizer's own Python through pipelineRunner.organizerDigests when the
  // pipeline is on (RAMHERD_PIPELINE=local), and the feed says so when it is not.
  // yukon-sandbox.js: scoped to the one blake3-r1-exploratory roster slot,
  // gated internally by RAMHERD_YUKON_SUBMIT + a real YUKON_API_KEY (see its
  // header). Passed whenever sandboxes are on at all, same as sandboxTask —
  // it is the module itself, not this wiring, that stays inert by default.
  // REAL live submission to the HashSmash competition (live-submit.js): only
  // wired in at all when the pipeline runs, sandboxes are on, AND
  // RAMHERD_HASHSMASH_LIVE_SUBMIT=true with a real YUKON_API_KEY. Unset (the
  // default) = null, and slots.js never reaches any submission code. The
  // per-track "what we really submitted" ledger persists under
  // RAMHERD_DATA_DIR so a restart can never cause a duplicate submission.
  const liveSubmitGate = liveSubmitPolicy(env);
  const liveSubmit = pipelineRunner && sandboxManager && pipeline.liveSubmitAllowed && liveSubmitGate.allowed
    ? {
      policy: liveSubmitGate,
      env,
      ledger: createLiveSubmissionLedger({ persistPath: env.RAMHERD_DATA_DIR ? join(env.RAMHERD_DATA_DIR, 'live-submissions.json') : null, log }),
    }
    : null;
  const slotManager = createSlotManager({ llmProvider, pipelineRunner, sandboxManager, sandboxTask: sandboxManager ? runWorkbenchTask : null, sandboxContext: sandboxManager ? contextBanner : null, sandboxActivity: activeLoop ? desktopActivity : null, activeLoop, researchTools: activeLoop ? realResearchTools : null, yukonSandbox: sandboxManager ? yukonSandbox : null, liveSubmit, costLedger, modelOverride: modelOverride(env), autoRestart });
  // Same opt-in persistence pattern as rams.js below (RAMHERD_DATA_DIR, unset =
  // in-memory only, every existing createStore() test unaffected): real bug, found
  // 2026-10-06, a genuinely good approved idea silently wiped on every restart.
  const ideaQueuePersistPath = env.RAMHERD_DATA_DIR ? join(env.RAMHERD_DATA_DIR, 'ideas.json') : null;
  const ideaQueue = createIdeaQueue({ persistPath: ideaQueuePersistPath, log });
  // Pinata, opt-in with PINATA_JWT: a launchpad RAM's token metadata gets
  // pinned to IPFS instead of only living at this server's own endpoint.
  // Unset -> rams.js keeps the self-hosted metadata.json URI exactly as
  // before; nothing else changes either way.
  const pinata = pinataPolicy(env);
  const pinataClient = pinata.configured ? createPinataClient({ jwt: pinata.jwt }) : null;
  // Logs page (/logs, server/lib/changelog.js): this repo's own real commit history from
  // GitHub's public API. Always-on, unlike every other integration above -- it reads one
  // public repo's public, keyless commit list, so there is no secret, no cost and nothing
  // to gate behind a RAMHERD_* flag (see changelog.js's header for the full reasoning).
  // Cached here; server/index.js refreshes it on a timer, same as the fee ledger.
  const changelog = createChangelogCache({ source: createChangelogSource(), log });
  // Roster ceiling growth (budget.js withLaunchCeiling): each launchpad RAM
  // confirmed active adds SLOTS_PER_CONFIRMED_LAUNCH to the roster's maxSlots.
  // Append-only, like ramFunds/payouts: an id is only ever added, never
  // removed, so nothing later (a cancel, an eviction, a resize) can lower a
  // ceiling a real launch raised. A Set, so the same RAM can't count twice.
  // In memory like every other record here: a restart resets it (README).
  const launchesThatRaisedCeiling = new Set();
  // Persistence for the RAM registry (server/lib/rams.js + persist.js): opt-in
  // with RAMHERD_DATA_DIR, unset here means null = in-memory only, exactly
  // today's behaviour, so every existing test (hundreds of `createStore()`
  // calls, with no RAMHERD_DATA_DIR) is unaffected and never touches disk.
  // In production, server/index.js's Fly deploy sets RAMHERD_DATA_DIR to the
  // mounted volume (e.g. /data); for local dev that wants the same survival,
  // set it to something like .ramherd/data (already git-ignored).
  const ramsPersistPath = env.RAMHERD_DATA_DIR ? join(env.RAMHERD_DATA_DIR, 'rams.json') : null;
  const rams = createRamRegistry({
    slotManager,
    funds: ramFunds,
    payouts,
    publicBaseUrl: launchpad.publicBaseUrl,
    treasury: launchpad.treasury,
    pinata: pinataClient,
    onActivated: (ram) => launchesThatRaisedCeiling.add(ram.id),
    persistPath: ramsPersistPath,
    log,
  });

  /** The budget config in force right now: the static one, plus launchpad ceiling growth. */
  function currentBudgetConfig() {
    return withLaunchCeiling(budgetConfig, launchesThatRaisedCeiling.size);
  }

  const EPOCH_MS = 24 * 60 * 60 * 1000;

  function getAllocation() {
    const { totalUsd } = ledger.getSnapshot();
    return {
      ...computeAllocation(totalUsd, currentBudgetConfig()),
      // Where maxSlots comes from, so the number can be explained honestly.
      maxSlotsBase: budgetConfig.maxSlots,
      launchesConfirmed: launchesThatRaisedCeiling.size,
      // Real spend in the last 24h, off costLedger's own real per-call entries (server/lib/cost.js
      // epochTotals) -- genuinely $0 in mock mode (every call there records a real, honest zero),
      // and the real figure once RAMHERD_LIVE is on and real OpenRouter calls are billing.
      computeSpentEpochUsd: costLedger.epochTotals(EPOCH_MS).costUsd,
    };
  }

  const coordinatorView = createCoordinatorView({ slotManager, ledger, getAllocation });
  const coordinator = createCoordinator({ view: coordinatorView, llmProvider, costLedger });

  /** The one deliberate operation that ties budget to slot count. Admin-only. */
  function reallocateSlotsFromBudget() {
    const allocation = getAllocation();
    slotManager.setSlotCount(allocation.slotCount);
    return allocation;
  }

  return {
    feeSource,
    ledger,
    llmProvider,
    pipeline,
    pipelineRunner,
    sandbox,
    sandboxManager,
    slotManager,
    ideaQueue,
    costLedger,
    pinata,
    changelog,
    ramFunds,
    payouts,
    rams,
    coordinator,
    getAllocation,
    currentBudgetConfig,
    reallocateSlotsFromBudget,
    refreshZecPrice,
    totalZec,
  };
}
