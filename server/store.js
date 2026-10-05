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

/**
 * @param {{ budgetConfig: import('./lib/budget.js').BudgetConfig, env?: NodeJS.ProcessEnv }} opts
 */
export function createStore({ budgetConfig, env = process.env }) {
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
  // Each slot calls its own roster model unless RAMHERD_LLM_MODEL forces one
  // model on all of them. Mock vs live is still only llm.js's decision.
  const slotManager = createSlotManager({ llmProvider, pipelineRunner, modelOverride: modelOverride(env) });
  const ideaQueue = createIdeaQueue();

  function getAllocation() {
    const { totalUsd } = ledger.getSnapshot();
    return computeAllocation(totalUsd, budgetConfig);
  }

  const coordinatorView = createCoordinatorView({ slotManager, ledger, getAllocation });
  const coordinator = createCoordinator({ view: coordinatorView, llmProvider });

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
    slotManager,
    ideaQueue,
    coordinator,
    getAllocation,
    reallocateSlotsFromBudget,
  };
}
