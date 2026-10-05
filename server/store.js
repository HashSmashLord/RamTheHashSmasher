// Wires the modules in server/lib together into one app state object.
// This is the only place that builds the coordinator's read-only view, so
// it's also the only place that could accidentally hand the coordinator a
// mutator — kept deliberately tiny and reviewed as such.

import { createMockFeeSource, createFeeLedger } from './lib/ledger.js';
import { computeAllocation } from './lib/budget.js';
import { createSlotManager } from './lib/slots.js';
import { createCoordinator, createCoordinatorView } from './lib/coordinator.js';
import { createIdeaQueue } from './lib/moderation.js';
import { createLlmProvider, modelOverride } from './lib/llm.js';
import { createHashSmashRunner, pipelinePolicy } from './lib/hashsmash.js';
import { createSandboxManager, sandboxPolicy } from './lib/sandbox.js';
import { createCostLedger } from './lib/cost.js';
import { createRamFunds } from './lib/ramfunds.js';
import { createPayoutBook } from './lib/payouts.js';
import { createRamRegistry } from './lib/rams.js';
import { createPinataClient, pinataPolicy } from './lib/pinata.js';

/**
 * @param {{
 *   budgetConfig: import('./lib/budget.js').BudgetConfig,
 *   env?: NodeJS.ProcessEnv,
 *   loadSandboxSdk?: () => Promise<{ Sandbox: any }>,
 *   launchpad?: { publicBaseUrl: string, treasury: string },
 * }} opts
 */
export function createStore({ budgetConfig, env = process.env, loadSandboxSdk, launchpad = { publicBaseUrl: 'http://127.0.0.1:4700', treasury: undefined } }) {
  const feeSource = createMockFeeSource();
  const ledger = createFeeLedger({ source: feeSource });
  const llmProvider = createLlmProvider(env);
  // Real HashSmash pipeline: opt-in with RAMHERD_PIPELINE=local (off by
  // default). Its credential-free stages are local and free; the paid judge
  // stage needs the live LLM gate plus RAMHERD_HASHSMASH_JUDGE=true; live
  // competition submission is never available from here.
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
  const slotManager = createSlotManager({ llmProvider, pipelineRunner, sandboxManager, costLedger, modelOverride: modelOverride(env) });
  const ideaQueue = createIdeaQueue();
  // Pinata, opt-in with PINATA_JWT: a launchpad RAM's token metadata gets
  // pinned to IPFS instead of only living at this server's own endpoint.
  // Unset -> rams.js keeps the self-hosted metadata.json URI exactly as
  // before; nothing else changes either way.
  const pinata = pinataPolicy(env);
  const pinataClient = pinata.configured ? createPinataClient({ jwt: pinata.jwt }) : null;
  const rams = createRamRegistry({ slotManager, funds: ramFunds, payouts, publicBaseUrl: launchpad.publicBaseUrl, treasury: launchpad.treasury, pinata: pinataClient });

  function getAllocation() {
    const { totalUsd } = ledger.getSnapshot();
    return computeAllocation(totalUsd, budgetConfig);
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
    ramFunds,
    payouts,
    rams,
    coordinator,
    getAllocation,
    reallocateSlotsFromBudget,
  };
}
