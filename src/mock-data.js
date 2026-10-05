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

import {
  HASH_FAMILIES,
  APPROACHES,
  MODELS,
  LIMITS,
  CREATE_FEE_SOL,
  CREATE_FEE_LAMPORTS,
  TREASURY,
  validateDraft,
  toRamRequest,
} from "./launchpad-rules.js";

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
  //
  // Row shape (one board row = Entrant / Round / Now / Judge):
  //   id, model, approach            -> Entrant
  //   trackId (+ TRACKS path)        -> Round
  //   status, updatedSecondsAgo,     -> Now. `status` is exactly one of "running" (shown as
  //   activity                          "Running an experiment"), "thinking", "idle", "submitted".
  //   judge, log2T                   -> Judge. `judge` is HashSmash's own review state for a
  //                                     handed-in candidate: "in review" (their intake state,
  //                                     "In review — Awaiting manual review" on yukon.org/hashsmash)
  //                                     or null when nothing has been handed in. Never "accepted"
  //                                     from this side: that word only ever comes from their judge.
  //                                     `log2T` is HashSmash's score, log₂(T): total charged
  //                                     computation, lower is better; null until their judge scores
  //                                     it. Today every submission on these tracks, ours included,
  //                                     is in review with no score, so every log2T here is null.
  agents: [
    {
      id: "ram-01",
      trackId: "sha256-r31",
      model: "anthropic/claude-opus-5.5",
      approach: "SAT solver — CaDiCaL",
      status: "running",
      activity: "Running CaDiCaL against a 31-round reduced characteristic, clause count 2.1M, 4 of 8 branch orderings tried.",
      updatedSecondsAgo: 32,
      judge: null,
      log2T: null,
    },
    {
      id: "ram-02",
      trackId: "sha256-r32",
      model: "anthropic/claude-fable-5.1",
      approach: "Reduced-round analysis",
      status: "thinking",
      activity: "Extending the r31 differential path by one round; checking the probability estimate holds above the submission floor before committing solver time.",
      updatedSecondsAgo: 300,
      judge: null,
      log2T: null,
    },
    {
      id: "ram-03",
      trackId: "sha3-256-r5",
      model: "openai/gpt-6.1-sol-pro",
      approach: "SAT solver — Kissat",
      status: "submitted",
      activity: "Candidate written to lanes/exploratory/candidates/sha3-256-r5/ and queued via hashsmash_pipeline.py intake.",
      updatedSecondsAgo: 840,
      judge: "in review",
      log2T: null,
    },
    {
      id: "ram-04",
      trackId: "sha3-256-r6",
      model: "z-ai/glm-5.3-prime",
      approach: "Cost-model refinement",
      status: "running",
      activity: "Re-costing a prior candidate's charged computation after a cheaper preprocessing step cut solver calls by ~18%.",
      updatedSecondsAgo: 14,
      judge: null,
      log2T: null,
    },
    {
      id: "ram-05",
      trackId: "blake3-r1",
      model: "deepseek/deepseek-v4-pro",
      approach: "Differential search",
      status: "idle",
      activity: "Waiting on this epoch's next budget tick — last branch exhausted without a usable trail.",
      updatedSecondsAgo: 420,
      judge: null,
      log2T: null,
    },
    {
      id: "ram-06",
      trackId: "blake3-r2",
      model: "qwen/qwen3.8-max-prime",
      approach: "Formal methods",
      status: "running",
      activity: "Re-running Z3 on the r2 mixing schedule with a tighter bound after the previous 6h attempt timed out.",
      updatedSecondsAgo: 3,
      judge: null,
      log2T: null,
    },
  ],

  chatSeed: [
    {
      q: "Has anything actually been submitted to HashSmash yet?",
      a: "Yes — one candidate from ram-03 on SHA3-256 r5 is in HashSmash's own review queue right now, submitted through their intake pipeline. It's marked \"in review\" (awaiting manual review), not accepted, and has no log₂(T) score yet. Nothing from this herd has ever been accepted. Everything else on the board is still in progress.",
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

// The exact words the board writes in the Now column, one per status.
const STATUS_LABEL = { running: "Running an experiment", thinking: "Thinking", idle: "Idle", submitted: "Submitted" };

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
      roundLabel: `${TRACKS[a.trackId].target} ${TRACKS[a.trackId].round}`, // "SHA-256 r31"
      lanePath: TRACKS[a.trackId].path,
      statusLabel: STATUS_LABEL[a.status] || a.status,
      updatedLabel: relativeTime(a.updatedSecondsAgo),
      judge: a.judge ?? null,
      log2T: a.log2T ?? null,
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

  /** "Create a RAM" (launch.html): getConfig / createRam / buildTransaction. Assigned below. */
  launchpad: null,
};

// ---------------------------------------------------------------------------
// Launchpad ("Create a RAM", launch.html). Same swap rule as above: with API_BASE set,
// each method fetches the backend ("" means same origin, when server/ serves src/); with
// API_BASE null it answers from the mock below.
// Every method resolves to `{ status, body, mock }`: `body` is the JSON the backend sent (or
// the mock's stand-in for it), `mock` is true when no backend was asked. Network failures
// reject; HTTP errors (400, 409) resolve, so the page can show the server's own message.
// ---------------------------------------------------------------------------

const mockLaunchpad = {
  lookupTableConfigured: false, // mirrors the real server today: no address lookup table yet
  rams: new Map(),
  nextId: 1,
};

function mockLaunchpadConfig() {
  const tracks = HASH_FAMILIES.flatMap((f) => f.tracks);
  return {
    ok: true,
    launchpad: {
      live: false,
      cluster: "devnet",
      createFeeLamports: CREATE_FEE_LAMPORTS,
      createFeeSol: CREATE_FEE_SOL,
      treasury: TREASURY,
      lookupTableConfigured: mockLaunchpad.lookupTableConfigured,
      hashFamilies: HASH_FAMILIES.map((f) => ({ family: f.family, tracks: f.tracks.map((t) => ({ ...t })) })),
      approaches: APPROACHES.map((a) => ({ ...a })),
      models: MODELS.map((slug, i) => ({ slug, ram: i + 1, track: tracks[i].track })),
      limits: JSON.parse(JSON.stringify(LIMITS)),
    },
  };
}

function mockCreateRam(draft) {
  const check = validateDraft(draft);
  if (!check.ok) {
    return { status: 400, body: { ok: false, error: "invalid_ram", message: "Some fields need another look.", fields: check.errors } };
  }
  const req = toRamRequest(draft);
  const track = HASH_FAMILIES.flatMap((f) => f.tracks).find((t) => t.track === req.track);
  const id = `mock-ram-${String(mockLaunchpad.nextId++).padStart(3, "0")}`;
  const ram = {
    id,
    owner: req.owner,
    hashFamily: req.hashFamily,
    track: req.track,
    rounds: track.rounds,
    approach: req.approach,
    approachDetail: req.approachDetail,
    model: req.model,
    token: { name: req.tokenName, symbol: req.tokenSymbol, uri: null, mint: null },
    status: "draft",
    createFeeLamports: CREATE_FEE_LAMPORTS,
    createdAt: new Date().toISOString(),
  };
  mockLaunchpad.rams.set(id, ram);
  return { status: 201, body: { ok: true, ram } };
}

// Mock stand-in for the build endpoint. With no lookup table it answers the way the real
// server does today (409 lookup_table_required). The sizes and instruction list are
// illustrative, not measured: only the real backend can build and size this transaction.
function mockBuildTransaction(id, mint) {
  const ram = mockLaunchpad.rams.get(id);
  if (!ram) return { status: 404, body: { ok: false, error: "not_found", message: "Not found." } };
  if (!mockLaunchpad.lookupTableConfigured) {
    const sizeBytes = 1418; // illustrative
    return {
      status: 409,
      body: {
        ok: false,
        error: "lookup_table_required",
        message: `Without an address lookup table the launch transaction is ${sizeBytes} bytes, over Solana's 1232-byte limit. The operator has not set one up yet.`,
        sizeBytes,
      },
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      transaction: {
        base64: null, // the mock never produces signable bytes
        version: 0,
        sizeBytes: 1104, // illustrative
        requiredSigners: [ram.owner, mint],
        instructions: [
          { label: "Set compute budget", programId: "ComputeBudget111111111111111111111111111111" },
          { label: `Pay ${CREATE_FEE_SOL} SOL to the RAMherd treasury`, programId: "11111111111111111111111111111111" },
          { label: "pump.fun: create the token", programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" },
          { label: "pump.fun: route 100% of creator fees to the treasury", programId: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ" },
        ],
        recentBlockhash: "mock-blockhash",
      },
    },
  };
}

async function apiRequest(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = { ok: false, error: "bad_response", message: `The server answered ${res.status} without JSON.` };
  }
  return { status: res.status, body: json, mock: false };
}

const launchpadAPI = {
  /** GET /api/launchpad/config -> { ok, launchpad: { live, cluster, createFeeSol, treasury, lookupTableConfigured, hashFamilies, approaches, models, limits } } */
  async getConfig() {
    if (API_BASE != null) return apiRequest("GET", "/api/launchpad/config");
    await simulatedLatency();
    return { status: 200, body: mockLaunchpadConfig(), mock: true };
  },

  /** POST /api/launchpad/rams -> 201 { ok, ram } | 400 { ok:false, error:'invalid_ram', message, fields } */
  async createRam(draft) {
    if (API_BASE != null) return apiRequest("POST", "/api/launchpad/rams", draft);
    await simulatedLatency(200, 400);
    return { ...mockCreateRam(draft), mock: true };
  },

  /** POST /api/launchpad/rams/:id/transaction { mint } -> 200 { ok, transaction } | 409 { ok:false, error:'lookup_table_required', message, sizeBytes } */
  async buildTransaction(id, mint) {
    if (API_BASE != null) return apiRequest("POST", `/api/launchpad/rams/${encodeURIComponent(id)}/transaction`, { mint });
    await simulatedLatency(200, 400);
    return { ...mockBuildTransaction(id, mint), mock: true };
  },
};

RAMherdAPI.launchpad = launchpadAPI;

function simulatedLatency(min = 80, max = 220) {
  const ms = min + Math.random() * (max - min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
