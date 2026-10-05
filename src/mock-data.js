// RAMherd — mock data layer.
//
// Everything a real backend would eventually serve lives behind the `RAMherdAPI` object
// at the bottom of this file. Every page module (app.js) calls through that object and
// never touches the mock arrays directly. When the real backend lands:
//
//   1. Set API_BASE to its URL (or read it from an env-injected <meta> tag / build step).
//   2. Replace each RAMherdAPI method body with a fetch() call to the matching endpoint.
//      The shapes below are the contract the frontend already expects — keep them, or
//      update app.js's render functions to match whatever the real API actually returns.
//   3. Delete the setInterval-driven mock mutation at the bottom of this file
//      (`startMockLiveFeed`) — the real backend pushes/updates this state itself.
//
// Nothing else in the frontend needs to change. That's the whole swap point.

export const API_BASE = null; // e.g. "https://api.herd.xyz" once the backend ships.

// ---------------------------------------------------------------------------
// Real, specific HashSmash tracks this fleet is actually assigned to.
// These track IDs and lane paths match reference/hash-smash/tracks/ and
// reference/hash-smash/lanes/exploratory/candidates/ in this repo — not placeholders.
// ---------------------------------------------------------------------------

const TRACKS = {
  "sha256-r31": { target: "SHA-256", round: "r31", lane: "exploratory", path: "lanes/exploratory/candidates/sha256-r31/" },
  "sha256-r32": { target: "SHA-256", round: "r32", lane: "exploratory", path: "lanes/exploratory/candidates/sha256-r32/" },
  "sha3-256-r5": { target: "SHA3-256", round: "r5", lane: "exploratory", path: "lanes/exploratory/candidates/sha3-256-r5/" },
  "sha3-256-r6": { target: "SHA3-256", round: "r6", lane: "exploratory", path: "lanes/exploratory/candidates/sha3-256-r6/" },
  "blake3-r1": { target: "BLAKE3", round: "r1", lane: "exploratory", path: "lanes/exploratory/candidates/blake3-r1/" },
  "blake3-r2": { target: "BLAKE3", round: "r2", lane: "exploratory", path: "lanes/exploratory/candidates/blake3-r2/" },
};

function trackLabel(trackId) {
  const t = TRACKS[trackId];
  return `${t.target} · ${t.round} · ${t.lane}`;
}

// ---------------------------------------------------------------------------
// Mutable mock state. Treat this block as "what the backend holds" — the rest
// of the file reads and nudges it; app.js only ever sees it through RAMherdAPI.
// ---------------------------------------------------------------------------

const state = {
  stats: {
    feesCollectedLifetime: 2384.17, // USD, pump.fun creator fees claimed to date
    computeBudgetEpoch: 400.0, // USD allocated this 24h epoch
    computeSpentEpoch: 268.42,
    epochLabel: "this 24h epoch",
    slotsActive: 6,
    slotsMax: 12,
  },

  // The launch roster (docs/PRD.md, "Decided"): one RAM per live exploratory track, each on
  // its own assigned OpenRouter model. Same slugs as server/lib/targets.js; keep them in sync.
  agents: [
    {
      id: "ram-01",
      trackId: "sha256-r31",
      model: "anthropic/claude-opus-5.5",
      approach: "SAT solver — CaDiCaL",
      status: "running",
      activity: "Running CaDiCaL against a 31-round reduced characteristic, clause count 2.1M, 4 of 8 branch orderings tried.",
      updatedSecondsAgo: 8,
    },
    {
      id: "ram-02",
      trackId: "sha256-r32",
      model: "anthropic/claude-fable-5.1",
      approach: "Reduced-round analysis",
      status: "thinking",
      activity: "Extending the r31 differential path by one round; checking the probability estimate holds above the submission floor before committing solver time.",
      updatedSecondsAgo: 41,
    },
    {
      id: "ram-03",
      trackId: "sha3-256-r5",
      model: "openai/gpt-6.1-sol-pro",
      approach: "SAT solver — Kissat",
      status: "submitted",
      activity: "Candidate written to lanes/exploratory/candidates/sha3-256-r5/ and queued via hashsmash_pipeline.py intake.",
      updatedSecondsAgo: 612,
    },
    {
      id: "ram-04",
      trackId: "sha3-256-r6",
      model: "z-ai/glm-5.3-prime",
      approach: "Cost-model refinement",
      status: "running",
      activity: "Re-costing a prior candidate's charged computation after a cheaper preprocessing step cut solver calls by ~18%.",
      updatedSecondsAgo: 23,
    },
    {
      id: "ram-05",
      trackId: "blake3-r1",
      model: "deepseek/deepseek-v4-pro",
      approach: "Differential search",
      status: "idle",
      activity: "Waiting on this epoch's next budget tick — last branch exhausted without a usable trail.",
      updatedSecondsAgo: 203,
    },
    {
      id: "ram-06",
      trackId: "blake3-r2",
      model: "qwen/qwen3.8-max-prime",
      approach: "Formal methods",
      status: "running",
      activity: "Re-running Z3 on the r2 mixing schedule with a tighter bound after the previous 6h attempt timed out.",
      updatedSecondsAgo: 15,
    },
  ],

  chatSeed: [
    {
      q: "Has anything actually been submitted to HashSmash yet?",
      a: "Yes — one candidate from ram-03 on SHA3-256 r5 is in HashSmash's own review queue right now, submitted through their intake pipeline. It's marked \"in review,\" not accepted. Everything else on the board is still in progress.",
    },
    {
      q: "Does more money in the pool mean faster cracks?",
      a: "It means more parallel agent-slots, not a faster crack — HashSmash is hard by design and nobody here expects a 24-hour break. More fees fund more independent approaches running at once: more SAT-solver seeds, more differential paths, more reduced-round angles tried in parallel.",
    },
    {
      q: "Can I tell an agent what to try?",
      a: "Not directly — I only answer questions here, I don't relay instructions to the fleet. If you've got a concrete idea, use the submission form below; a person reads it before any agent does.",
    },
    {
      q: "What happens to a candidate that fails?",
      a: "It stays visible. A failed branch (like ram-05's exhausted BLAKE3 r1 trail) gets logged and the slot moves to the next approach — we don't hide attempts that didn't pan out, win or not is the whole point of showing this live.",
    },
    {
      q: "Is SHA-256 broken?",
      a: "No. Nothing on this board is a claim that SHA-256, SHA3-256, or BLAKE3 is broken. We're working reduced-round and exploratory tracks inside HashSmash's own competition structure — real research, scored by their judge, not a headline.",
    },
  ],

  ideaQueueLength: 14, // how many human-pending ideas are ahead of the next submission, for realism
};

function relativeTime(seconds) {
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

function cents(n) {
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Coordinator Q&A matching. Mock only — real backend replaces this with an
// actual model call scoped to live fleet state. Kept intentionally simple:
// keyword match against the seeded pairs, then a grounded fallback.
// ---------------------------------------------------------------------------

function coordinatorReply(question) {
  const q = question.toLowerCase();

  for (const pair of state.chatSeed) {
    const keyWords = pair.q.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
    const hits = keyWords.filter((w) => q.includes(w)).length;
    if (hits >= 2) return pair.a;
  }

  if (/fee|money|budget|pump|coin|token/.test(q)) {
    return `Lifetime fees collected so far: $${cents(state.stats.feesCollectedLifetime)}. This epoch's compute budget is $${cents(state.stats.computeBudgetEpoch)}, with $${cents(state.stats.computeSpentEpoch)} spent — that funds the ${state.stats.slotsActive} of ${state.stats.slotsMax} agent-slots running right now.`;
  }
  if (/agent|slot|fleet|running|active/.test(q)) {
    const running = state.agents.filter((a) => a.status === "running").length;
    const thinking = state.agents.filter((a) => a.status === "thinking").length;
    return `Right now: ${running} agents running an experiment, ${thinking} thinking through their next move, across SHA-256, SHA3-256, and BLAKE3 exploratory tracks. See the fleet grid above for exactly what each one is doing.`;
  }
  if (/idea|submit|suggest/.test(q)) {
    return "Use the submission form below. Every idea goes into a human-reviewed queue first — nothing reaches an agent until it's been read and approved by a person.";
  }
  return "I can answer questions about fees, the active fleet, submitted candidates, and what HashSmash does and doesn't let us claim — try asking about one of those, or scroll to the fleet grid for the live detail.";
}

// ---------------------------------------------------------------------------
// Mock live drift: fees tick up slowly, timestamps age, an agent occasionally
// changes status. This simulates "live" for the demo without a real backend.
// Real backend: delete this whole block and poll/subscribe to the real feed.
// ---------------------------------------------------------------------------

function tickMockState() {
  state.stats.feesCollectedLifetime += Math.random() * 0.4 + 0.02;
  state.stats.computeSpentEpoch = Math.min(
    state.stats.computeBudgetEpoch,
    state.stats.computeSpentEpoch + Math.random() * 0.15
  );
  for (const agent of state.agents) {
    agent.updatedSecondsAgo += 4;
  }
  // Every so often, nudge one running agent's clock hard (simulating a fresh status line)
  // and occasionally flip idle -> thinking to keep the board feeling alive.
  if (Math.random() < 0.3) {
    const running = state.agents.filter((a) => a.status === "running");
    if (running.length) {
      const pick = running[Math.floor(Math.random() * running.length)];
      pick.updatedSecondsAgo = Math.floor(Math.random() * 6);
    }
  }
}

let mockInterval = null;
function startMockLiveFeed(onTick, intervalMs = 4000) {
  if (mockInterval) clearInterval(mockInterval);
  mockInterval = setInterval(() => {
    tickMockState();
    onTick();
  }, intervalMs);
  return () => clearInterval(mockInterval);
}

// ---------------------------------------------------------------------------
// Public API. This is the only thing app.js imports and calls — the single
// swap point once the real backend exists. Keep the method names and return
// shapes; change the bodies.
// ---------------------------------------------------------------------------

export const RAMherdAPI = {
  /** Returns the live stats-bar numbers. Real version: GET `${API_BASE}/stats`. */
  async getStats() {
    await simulatedLatency();
    const { feesCollectedLifetime, computeBudgetEpoch, computeSpentEpoch, epochLabel, slotsActive, slotsMax } = state.stats;
    const breakdown = {
      idle: state.agents.filter((a) => a.status === "idle").length,
      thinking: state.agents.filter((a) => a.status === "thinking").length,
      running: state.agents.filter((a) => a.status === "running").length,
      submitted: state.agents.filter((a) => a.status === "submitted").length,
    };
    return {
      feesCollectedLifetime,
      computeBudgetEpoch,
      computeSpentEpoch,
      epochLabel,
      slotsActive,
      slotsMax,
      breakdown,
    };
  },

  /** Returns the fleet grid. Real version: GET `${API_BASE}/agents`. */
  async getFleet() {
    await simulatedLatency();
    return state.agents.map((a) => ({
      ...a,
      trackLabel: trackLabel(a.trackId),
      lanePath: TRACKS[a.trackId].path,
      updatedLabel: relativeTime(a.updatedSecondsAgo),
    }));
  },

  /** Seeds the chat panel with realistic prior Q&A. Real version: GET `${API_BASE}/coordinator/history`. */
  async getChatSeed() {
    await simulatedLatency();
    return state.chatSeed;
  },

  /** Sends a viewer question to the coordinator. Real version: POST `${API_BASE}/coordinator/ask`. */
  async askCoordinator(question) {
    await simulatedLatency(500, 900);
    return { answer: coordinatorReply(question) };
  },

  /** Submits a viewer idea into the human-review queue. Real version: POST `${API_BASE}/ideas`. */
  async submitIdea(payload) {
    await simulatedLatency(300, 600);
    state.ideaQueueLength += 1;
    return {
      status: "queued_for_human_review",
      queuePosition: state.ideaQueueLength,
    };
  },

  /** Starts the mock "live" drift and calls `onTick` after every update. Delete with the mock. */
  subscribeLive(onTick, intervalMs) {
    return startMockLiveFeed(onTick, intervalMs);
  },
};

function simulatedLatency(min = 80, max = 220) {
  const ms = min + Math.random() * (max - min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
