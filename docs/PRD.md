# RAMherd — PRD

## What this is

A memecoin whose creator fees fund a fleet of AI agent instances doing real cryptanalysis
research against [HashSmash](https://yukon.org/hashsmash) — the open, public competition
(Eigen Labs / Shielded Labs / Yukon, backed by Zooko) testing how far AI can push attacks on
SHA-256, SHA3-256, BLAKE3 and Poseidon. The more fees collected, the more parallel agent
instances get funded, each working a different angle. A main coordinator agent aggregates
what every solver agent is doing, answers viewer questions about the project live, and takes
viewer-submitted crack ideas into a **human-moderated** queue — the operator approves/rejects before
anything reaches an agent.

Inspiration (not a spec to copy): the AGENCY launchpad concept of an autonomous AI mind with
a treasury. The operator explicitly does not want AGENCY's stuff implemented — if a specific feature
from it looks worth having, ask the operator first, feature by feature.

## Why this is real, not vaporware

HashSmash is a real, live competition with a real submission pipeline, already cloned into
`reference/hash-smash/` in this repo:
- Targets: SHA-256, SHA3-256 (Keccak[1600]), BLAKE3, Poseidon. Exploratory tracks currently
  open for SHA-256/SHA3-256/BLAKE3; Poseidon pending; rigorous/legacy tracks excluded for now.
- Scoring: `log2(total charged computation)` — lower is better — tracked per-target on
  Frontier / All Rounds / Time Series views, with submissions landing as "in review" →
  "accepted" or rejected.
- Submission = a schema-validated JSON claim + a markdown argument doc + optional
  certificate/experiment files, written into a solver's own
  `lanes/<lane>/candidates/<target>/` directory and run through
  `scripts/hashsmash_pipeline.py intake --track <id>`.
- The repo's own harness already expects `OPENROUTER_API_KEY` (or AWS Bedrock) — meaning our
  agent fleet can be, quite literally, that harness, funded by memecoin fees instead of
  the operator's own OpenRouter balance.

Full technical grounding (submission schema details, what techniques are realistic — SAT
solvers, differential search, reduced-round analysis, formal methods, etc.) is being written
up separately by a research pass over `reference/hash-smash/docs/` — see
`docs/research/hashsmash-technical-brief.md` once that lands.

**Framing honesty, on purpose:** "crack SHA-256" in the literal sense is not a realistic
24-hour-memecoin outcome — nobody expects it to be; that's the entire point of the
competition being hard and public. What's real and valuable: genuine incremental
cryptanalysis research (reduced-round attacks, novel differential paths, cost-model
improvements) submitted honestly through HashSmash's own review pipeline, with every attempt
and result shown live, win or not. The product should never claim a break that didn't pass
HashSmash's own judge.

## System overview

```
Pump.fun fees (real, BLOCKED — see below)
        │
        ▼
Fee ledger  ──funds──▶  Compute budget (USD)
        │                      │
        │                      ▼
        │           Agent-slot allocator (budget → N parallel solver instances)
        │                      │
        │        ┌─────────────┼─────────────┐
        │        ▼             ▼             ▼
        │   Solver agent  Solver agent  Solver agent   ...up to N, budget-limited
        │   (lane/target/  (lane/target/  (lane/target/
        │    approach A)    approach B)    approach C)
        │        │             │             │
        │        └──────status─┼─status──────┘
        │                      ▼
        │            Coordinator ("main") agent
        │          - aggregates live status
        │          - answers viewer Q&A
        │          - holds the moderation queue
        ▼                      │
   Frontend dashboard ◀────────┘
   - agents active, compute used, fees-to-date
   - live feed per solver agent (thinking / running / submitted)
   - viewer chat with coordinator
   - viewer idea submission → PENDING → the operator approves/rejects → only then visible to agents
```

## Explicitly blocked right now (same wall as every other project this session)

These need either the operator doing them by hand, or a capability this harness will not let me
write code for, full stop — not a wording problem, not something to route around:

1. **Creating the real pump.fun token.** Same wall as every other real-money action in this
   workspace. The operator creates it directly; hand me the mint address and I wire it in same-day.
2. **Claiming/collecting real creator fees.** Reading a public fee balance is fine; signing a
   claim transaction that moves real money is the blocked part.
3. **Spending real money on OpenRouter/compute credits.** The fee-ledger → compute-budget →
   agent-count pipeline is fully built and testable with mock numbers; the actual purchase of
   credits (or whatever "spend $X of pool funds on API calls" means operationally) needs
   the operator's go, same as any real spend.

Everything else — the full orchestration, the frontend, the moderation queue, the actual
solver-agent loop running against the real HashSmash repo with the operator's own OpenRouter key in
dev/test mode (operator's call on using real key spend, default is mocked) — is being built now.

## Decided

- **The Herder** (renamed from "coordinator"): same read-only Q&A for viewers as before —
  grounded in real state, never touches a RAM, never reachable by a viewer to direct one.
  New: the operator can tell the Herder to move funds/compute to a specific RAM, but that
  still runs through the same deterministic allocator code, not the model's judgment, and
  that action channel is operator-only — a completely separate door from the public chat.
- **Per-RAM models, via OpenRouter.** Each RAM gets its own assigned model, shown on its
  tile. Default roster at launch (one RAM per live HashSmash exploratory track):

  | RAM | Track | Model (OpenRouter slug) |
  |---|---|---|
  | 1 | `sha256-r31` | `anthropic/claude-opus-5.5` |
  | 2 | `sha256-r32` | `anthropic/claude-fable-5.1` |
  | 3 | `sha3-256-r5` | `openai/gpt-6.1-sol-pro` |
  | 4 | `sha3-256-r6` | `z-ai/glm-5.3-prime` |
  | 5 | `blake3-r1` | `deepseek/deepseek-v4-pro` |
  | 6 | `blake3-r2` | `qwen/qwen3.8-max-prime` |

  Verified real slugs against OpenRouter's own `/api/v1/models` endpoint, not guessed.
- **Viewers watch, never interact.** No viewer input ever reaches a RAM directly — only
  through the existing human-moderated idea queue. Confirmed explicitly, not a default.
- **Live view of a RAM working**, in priority order: (1) a real terminal/log stream of what
  a RAM's pipeline run actually does (cheap, build first), (2) a full isolated VM + live VNC
  desktop per RAM (via E2B — needs the operator's own E2B account/API key, real per-second
  cost), for once a RAM needs to browse rather than just run CLI commands. Build the VM feed
  wrapped in real UI framing, not a bare remote-desktop window.
- **Launchpad (later feature) — refined.** 0.2 SOL to create a RAM; a pump.fun token for it
  is created on the *user's own connected wallet* in one atomic Phantom-signed transaction
  (same non-custodial shape as the AGENCY reference), with the token's creator fees routed to
  the operator's treasury wallet (`5M6Pc7ossZ8cuQAjnexH9vv2axEJoncgZ3C6uD2PJqHm` — public
  address only; its private key is never handled by this project, by design), funding that
  RAM's compute. A
  win in HashSmash's own judged review sends a prize to the user's wallet. During creation,
  the user must **pick exactly one** of the three hash families (SHA-256, SHA3-256, BLAKE3) —
  a RAM cracks one, not all three — and answer a short follow-up on what approach the RAM
  should specifically try and which model to run it on. Still blocked on the same real-money
  wall as everything else here; the unsigned-transaction-building part (user's own wallet
  signs, we never hold a key) is the piece actually worth trying when this gets built.

## Still open

- Submission cadence to the real HashSmash repo: every candidate result, or only ones that
  pass some internal bar first?
- Exact $-per-RAM-slot ratio and floor/ceiling slot count.
- Does a viewer's approved idea get attached to an existing RAM, or spin up a new one?

## Build plan (today, 4-5 hours, three parallel surfaces)

1. **Research** — deep pass over `reference/hash-smash/docs/`, produces the technical brief
   this PRD links to: exact submission schema, realistic technique list, which track to
   target first.
2. **Orchestration backend** — agent-slot manager, coordinator agent, moderation queue, mock
   fee ledger with a real-feed-ready interface, one real solver-agent loop wired against the
   actual HashSmash repo (dry-run by default).
3. **Frontend (Impeccable)** — live dashboard: agents active, compute used, fees-to-date,
   per-agent live feed, viewer chat, idea-submission form → moderation queue.
