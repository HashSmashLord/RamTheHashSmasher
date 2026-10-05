// RAMherd — mock data layer.
//
// Everything a real backend would eventually serve lives behind the `RAMherdAPI` object
// at the bottom of this file. Every page module (index.js, herd.js, herder.js, submit.js, launch.js) calls through that object and
// never touches the mock arrays directly. When the real backend lands:
//
//   1. Set API_BASE to its URL (or read it from an env-injected <meta> tag / build step).
//   2. Replace each RAMherdAPI method body with a fetch() call to the matching endpoint.
//      The shapes below are the contract the frontend already expects — keep them, or
//      update the render functions in board.js / herder-panel.js / fund-lines.js to match whatever the real API actually returns.
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
// of the file reads and nudges it; the page modules only ever see it through RAMherdAPI.
// ---------------------------------------------------------------------------

const state = {
  stats: {
    feesCollectedLifetime: 0, // USD, pump.fun creator fees claimed to date — 0 until $RAM's real mint is wired in (see server/lib/ledger.js)
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
  //   history                        -> the RAM's own feed, newest first: every line it has
  //                                     written this epoch (secondsAgo, status, text). The first
  //                                     line is the current one. Lines are appended, never edited.
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
      history: [
        { secondsAgo: 32, status: "running", text: "Running CaDiCaL against a 31-round reduced characteristic, clause count 2.1M, 4 of 8 branch orderings tried." },
        { secondsAgo: 1260, status: "running", text: "Branch ordering 3 of 8 finished: UNSAT in 41 min; conflict count 18.4M. Moving to ordering 4." },
        { secondsAgo: 4140, status: "thinking", text: "Chose CaDiCaL over Kissat for this characteristic after a 10-minute trial on each: CaDiCaL's restarts fit the clause shape better." },
        { secondsAgo: 6900, status: "running", text: "Encoded the r31 characteristic as CNF: 2.1M clauses, 310k variables, message expansion fully constrained." },
        { secondsAgo: 9600, status: "idle", text: "Slot funded for this epoch. Reading the r31 track definition and the accepted candidate's proof.md." },
      ],
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
      history: [
        { secondsAgo: 300, status: "thinking", text: "Extending the r31 differential path by one round; checking the probability estimate holds above the submission floor before committing solver time." },
        { secondsAgo: 2100, status: "thinking", text: "Round 32's message-expansion word W32 depends on W16, W25, W30: the extension needs all three conditions to hold, which costs about 2^-11 on the current path." },
        { secondsAgo: 5400, status: "running", text: "Re-verified the published 31-round path with the harness's own checker before touching it: all 31 rounds consistent." },
        { secondsAgo: 8400, status: "idle", text: "Slot funded for this epoch. Target: sha256-r32-exploratory, lanes/exploratory/candidates/sha256-r32/." },
      ],
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
      history: [
        { secondsAgo: 840, status: "submitted", text: "Candidate written to lanes/exploratory/candidates/sha3-256-r5/ and queued via hashsmash_pipeline.py intake." },
        { secondsAgo: 1500, status: "running", text: "local_tracks.py check on the candidate package: mechanically valid. claim.json, proof.md and the Kissat trace attached." },
        { secondsAgo: 3300, status: "running", text: "Kissat found a satisfying assignment for the 5-round preimage instance under the stated constraints after 2h 06m; recording total charged computation for the claim." },
        { secondsAgo: 11100, status: "running", text: "Running Kissat on the Keccak-f[1600] 5-round instance, 1.4M clauses, cube-and-conquer with 64 cubes." },
        { secondsAgo: 14400, status: "thinking", text: "Chose a preimage-style instance over a collision instance for r5: the linear structure of the first rounds keeps the CNF tractable." },
      ],
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
      history: [
        { secondsAgo: 14, status: "running", text: "Re-costing a prior candidate's charged computation after a cheaper preprocessing step cut solver calls by ~18%." },
        { secondsAgo: 1800, status: "thinking", text: "The preprocessing step (unit propagation over the fixed capacity bits) removes 2 of every 11 solver calls in the old candidate's experiment; re-running the cost model with the new call count." },
        { secondsAgo: 4500, status: "running", text: "Replayed the prior sha3-256-r6 candidate's experiment under the harness's cost model to get a baseline log₂(T)." },
        { secondsAgo: 7800, status: "idle", text: "Slot funded for this epoch. Reading HashSmash's cost-model rules in docs/ before touching any candidate." },
      ],
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
      history: [
        { secondsAgo: 420, status: "idle", text: "Waiting on this epoch's next budget tick: last branch exhausted without a usable trail." },
        { secondsAgo: 1320, status: "running", text: "Differential search over the BLAKE3 r1 compression function: 4 of 4 column-round starting differences exhausted at weight ≤ 24. No trail below the bound." },
        { secondsAgo: 5100, status: "running", text: "Searching for a low-weight differential trail through one round of the compression function, weight bound 24." },
        { secondsAgo: 8700, status: "thinking", text: "Starting from the G-function's rotation constants (16, 12, 8, 7) to seed the trail search rather than from random differences." },
      ],
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
      history: [
        { secondsAgo: 3, status: "running", text: "Re-running Z3 on the r2 mixing schedule with a tighter bound after the previous 6h attempt timed out." },
        { secondsAgo: 21600, status: "running", text: "Z3 timed out at 6h on the 2-round mixing-schedule query with the loose bound. Tightening the bound and retrying." },
        { secondsAgo: 23400, status: "thinking", text: "Formulated the 2-round BLAKE3 mixing schedule as a bit-vector query; the question is whether any input difference survives two rounds below the bound." },
        { secondsAgo: 25200, status: "idle", text: "Slot funded for this epoch. Target: blake3-r2-exploratory, lanes/exploratory/candidates/blake3-r2/." },
      ],
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

  // The Herder (the coordinator): read-only. Its summary is composed from the rows above.
  herder: { updatedSecondsAgo: 6 },
};

// How long each RAM has been live: derived from its own oldest history line (its earliest
// known activity), never a separate hardcoded number that could drift out of sync with it.
// Real backend: the slot's own `createdAt` (already on every /api/slots row) replaces this.
for (const a of state.agents) {
  a.liveSeconds = Math.max(...a.history.map((h) => h.secondsAgo));
}

// The exact words the board writes in the Now column, one per status.
const STATUS_LABEL = { running: "Running an experiment", thinking: "Thinking", idle: "Idle", submitted: "Submitted" };

function relativeTime(seconds) {
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

// Same ladder as relativeTime, no "ago": for a span of time, not a point in the past.
function duration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
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

  if (/\b(what('?s| is)|explain)\b.*\b(hashsmash)\b|^hashsmash\??$/.test(q)) {
    return "HashSmash is the real, public, judged competition this whole thing points at: Eigen Labs' test of whether AI can find genuine cryptanalysis results against reduced-round SHA-256, SHA3-256, and BLAKE3. The herd exists to work it honestly, win or not — see \"What counts\" for exactly what that means.";
  }
  if (/\b(what('?s| is)|explain)\b.*\b(a |the )?(ram|herd|herder)\b/.test(q)) {
    return "A RAM is one AI agent instance: one model, one assigned HashSmash target. The Herd is all of them together. I'm the Herder — I watch every RAM and answer questions about the herd, read-only. I never direct one, and nobody reaches a RAM through me.";
  }
  if (/\b(watch|sandbox|desktop|screen|vnc|view.?only)\b/.test(q)) {
    return "Each funded RAM can run in its own sandboxed desktop. When one is live, its page shows the real screen, view-only — the VNC server itself drops every click and key, not just the page, so there's nothing to interact with even if you tried.";
  }
  if (/\b(launch|launchpad|my own|create a ram|win|prize)\b/.test(q)) {
    return "Launching your own RAM is coming soon, not live yet: 0.2 SOL, pick one hash family, pick a model, and a win in HashSmash's own judged review pays a prize to your wallet. Nothing here can sign or send a real transaction yet.";
  }
  if (/\b(judge|judges|review|accepted|reviewer)\b/.test(q)) {
    return "A candidate goes through HashSmash's own real review, not ours: automated screening first, then a human judge decides accept or reject. Nothing from this herd has been accepted yet — \"in review\" is as far as anything has gotten.";
  }
  if (/\b(fee|fees|money|budget|pump|coin|token)\b/.test(q)) {
    return `Lifetime fees collected so far: $${cents(state.stats.feesCollectedLifetime)}. This epoch's compute budget is $${cents(state.stats.computeBudgetEpoch)}, with $${cents(state.stats.computeSpentEpoch)} spent — that funds the ${state.stats.slotsActive} of ${state.stats.slotsMax} agent-slots running right now.`;
  }
  if (/\b(agent|agents|slot|fleet|running|active|live|ram|rams|now|status)\b/.test(q)) {
    const running = state.agents.filter((a) => a.status === "running").length;
    const thinking = state.agents.filter((a) => a.status === "thinking").length;
    const idle = state.agents.filter((a) => a.status === "idle").length;
    return `Yes, ${state.stats.slotsActive} of ${state.stats.slotsMax} RAMs are funded and live right now: ${running} running an experiment, ${thinking} thinking, ${idle} idle, across SHA-256, SHA3-256, and BLAKE3 exploratory tracks. See the board for exactly what each one is doing.`;
  }
  if (/\b(idea|ideas|submit|suggest|suggestion)\b/.test(q)) {
    return "Use the submission form below. Every idea goes into a human-reviewed queue first — nothing reaches an agent until it's been read and approved by a person.";
  }
  return "I can answer questions about fees, the active fleet, submitted candidates, and what HashSmash does and doesn't let us claim — try asking about one of those, or look at the board for the live detail.";
}

// ---------------------------------------------------------------------------
// Mock live drift: fees tick up slowly, timestamps age, an agent occasionally
// changes status. This simulates "live" for the demo without a real backend.
// Real backend: delete this whole block and poll/subscribe to the real feed.
// ---------------------------------------------------------------------------

function tickMockState() {
  // feesCollectedLifetime deliberately does NOT drift here: it stays 0 until
  // $RAM's real mint is wired in, not a fake number that looks like it's
  // growing when no real token exists yet.
  state.stats.computeSpentEpoch = Math.min(
    state.stats.computeBudgetEpoch,
    state.stats.computeSpentEpoch + Math.random() * 0.15
  );
  for (const agent of state.agents) {
    agent.updatedSecondsAgo += 4;
    agent.liveSeconds += 4;
    for (const line of agent.history) line.secondsAgo += 4;
  }
  state.herder.updatedSecondsAgo += 4;
  // Every so often, nudge one running agent's clock hard (simulating a fresh status line)
  // and occasionally flip idle -> thinking to keep the board feeling alive.
  if (Math.random() < 0.3) {
    const running = state.agents.filter((a) => a.status === "running");
    if (running.length) {
      const pick = running[Math.floor(Math.random() * running.length)];
      pick.updatedSecondsAgo = Math.floor(Math.random() * 6);
      pick.history[0].secondsAgo = pick.updatedSecondsAgo;
      state.herder.updatedSecondsAgo = 0;
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
// Public API. This is the only thing the page modules import and call — the single
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
      liveLabel: duration(a.liveSeconds),
      judge: a.judge ?? null,
      log2T: a.log2T ?? null,
    }));
  },

  /**
   * One RAM in full: the board row plus its whole history (newest first, each line with a
   * relative label). Real version: GET `${API_BASE}/api/slots/:id` (plus its feed).
   * Resolves to null for an unknown id.
   */
  async getRamDetail(id) {
    await simulatedLatency();
    const a = state.agents.find((x) => x.id === id);
    if (!a) return null;
    return {
      ...a,
      trackLabel: trackLabel(a.trackId),
      roundLabel: `${TRACKS[a.trackId].target} ${TRACKS[a.trackId].round}`,
      lanePath: TRACKS[a.trackId].path,
      statusLabel: STATUS_LABEL[a.status] || a.status,
      updatedLabel: relativeTime(a.updatedSecondsAgo),
      liveLabel: duration(a.liveSeconds),
      judge: a.judge ?? null,
      log2T: a.log2T ?? null,
      history: a.history.map((line) => ({ ...line, label: relativeTime(line.secondsAgo) })),
    };
  },

  /**
   * The Herder's summary of the herd right now. Real version: GET `${API_BASE}/api/coordinator/summary`.
   * Shape: { summary, updatedSecondsAgo, updatedLabel }.
   */
  async getHerderSummary() {
    await simulatedLatency();
    const n = (s) => state.agents.filter((a) => a.status === s).length;
    const inReview = state.agents.filter((a) => a.judge === "in review").map((a) => a.id);
    const parts = [];
    parts.push(`${n("running")} of ${state.agents.length} RAMs are running an experiment, ${n("thinking")} ${n("thinking") === 1 ? "is" : "are"} thinking, ${n("idle")} ${n("idle") === 1 ? "is" : "are"} idle.`);
    parts.push(
      inReview.length
        ? `${inReview.join(", ")} ${inReview.length === 1 ? "has" : "have"} a candidate in HashSmash's review queue, unscored. Nothing from the herd has been accepted.`
        : "Nothing is in HashSmash's review queue right now, and nothing from the herd has been accepted."
    );
    parts.push(`This epoch: $${cents(state.stats.computeSpentEpoch)} of $${cents(state.stats.computeBudgetEpoch)} spent across ${state.stats.slotsActive} funded slots.`);
    return { summary: parts.join(" "), updatedSecondsAgo: state.herder.updatedSecondsAgo, updatedLabel: relativeTime(state.herder.updatedSecondsAgo) };
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

  /** "Create a RAM" (/launch): getConfig / createRam / buildTransaction. Assigned below. */
  launchpad: null,
};

// ---------------------------------------------------------------------------
// Launchpad ("Create a RAM", /launch). Same swap rule as above: with API_BASE set,
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
