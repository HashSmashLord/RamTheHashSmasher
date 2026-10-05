# Product

<!-- impeccable:product-schema 1 -->

<!-- Written by init without a live interview (background session, no question tool).
     Facts come from docs/PRD.md, README.md and docs/research/hashsmash-technical-brief.md.
     Lines marked (inferred) were not confirmed by the operator; correct them freely. -->

## Platform

web

## Users

- Primary: people arriving from the memecoin side — a pump.fun page, a tweet, a group chat —
  on a phone or a laptop, asking one question in the first few seconds: "is this real, or is
  it another AI-themed coin with a landing page?" They are not cryptographers. They can read a
  live status board and tell activity from decoration. (inferred from PRD "Why this is real,
  not vaporware")
- Secondary: cryptanalysis-curious viewers (students, CTF people, HashSmash followers) who
  might ask the coordinator a real question or submit an attack idea. They know words like
  "reduced-round", "differential path", "SAT solver" and will notice if the page uses them
  wrong. (inferred)
- Operator: reviews submitted ideas and runs the backend. Moderation happens in the
  backend's admin routes, not on this public surface.

## Product Purpose

HashRammers is a memecoin whose creator fees buy compute for a herd of RAMs — independent AI
agent instances — each working a different cryptanalysis angle against HashSmash, the public,
judged competition on SHA-256, SHA3-256 and BLAKE3. The public page exists to show that work
happening, live, win or not: fees collected, compute budget, how many RAMs are funded, what
each one is doing right now, a read-only coordinator that answers questions, and a form that
puts viewer ideas into a human-reviewed queue.

Success: a first-time visitor understands within seconds that fees fund real, visible
research; a returning visitor can see what changed; nobody leaves believing a hash function
was broken.

## Positioning

The mechanism a neighbouring "AI agent" coin cannot truthfully copy: every attempt is
submitted through HashSmash's own public intake pipeline and scored by HashSmash's own judge.
More fees means more parallel approaches running at once, not a faster crack. The page never
claims a break; a result only counts when HashSmash marks it accepted.

## Operating Context

- HashSmash (yukon.org/hashsmash): exploratory tracks currently open for SHA-256, SHA3-256
  and BLAKE3. Track IDs the herd is assigned to: `sha256-r31`, `sha256-r32`, `sha3-256-r5`,
  `sha3-256-r6`, `blake3-r1`, `blake3-r2`. Candidates live under
  `lanes/exploratory/candidates/<track>/` and enter via `scripts/hashsmash_pipeline.py intake`.
  Score is `log2(total charged computation)`, lower is better. Submission states on their
  side: in review → accepted or rejected.
- Backend (`server/`) vocabulary the page must match: RAM = one funded solver-agent slot; slot
  states `idle`, `thinking`, `running`, `submitted`; a 24h compute epoch with a USD budget;
  fee ledger → budget → slot allocator; coordinator is structurally read-only (summary + ask);
  idea queue is human-moderated with a rule-based pre-filter.
- Approach catalogue (from the technical brief, section 2.2): SAT solvers (CaDiCaL, Kissat),
  differential search, reduced-round analysis, formal methods, cost-model refinement.
- The frontend runs with no build step from `src/` on port 4701; the backend owns 4700.

## Capabilities and Constraints

- Every number on the page is mock by default (`src/mock-data.js`, `RAMherdAPI`). The page
  must say so where a visitor could mistake it for live data, until the backend is wired in.
- The real pump.fun token, real fee claiming and real compute spend do not exist yet; the operator
  does those by hand. The page must not invent a contract address, a price, a holder count or
  a chart.
- The coordinator answers questions only. It cannot redirect a RAM on a viewer's say.
- No viewer idea reaches a RAM until a human approves it. This is the product's safety
  boundary and must be stated plainly wherever ideas are collected.
- Undecided (the operator's call): slots per dollar, whether an approved idea attaches to an
  existing RAM or spins up a new one, how often candidates are submitted to HashSmash, and
  the final product name (now HashRammers, matching @HashRammers and hashrammers.com; "RAMherd" was the working name).

## Brand Commitments

- Name: HashRammers (formerly the working name RAMherd). "RAM" is both the animal and the pun; a herd of rams ramming at a
  hash. The copy may lean on it; the page must not become a cartoon.
- Voice: plain, specific, unhyped. Says what is real and what is not in the same breath.
  "Nothing here claims a hash function is broken" is a fixed line, not a disclaimer to hide.
- Standing preference from the workspace: no generic AI-looking frontend ("i dont want any
  basic claude looking front end"); frontends are built through Impeccable.
- No other assets (logo, colours, type) are committed. The first pass's look (near-black,
  blue accent, Space Grotesk + IBM Plex Mono) was not a brand decision and carries no
  authority.

## Evidence on Hand

- The HashSmash repo itself, vendored at `reference/hash-smash/` (tracks, lanes, pipeline,
  docs). Real track IDs and lane paths come from there.
- `docs/research/hashsmash-technical-brief.md`: how submission and scoring really work.
- `server/`: working orchestration backend, 94 passing tests, HTTP API.
- Absent, and not to be fabricated: real fee figures, a token mint, holders, price, any
  accepted HashSmash submission, testimonials, partner names, press.

## Product Principles

1. Prove, don't claim: the live board is the argument; the hero only frames it.
2. Honest in both directions: say what is real research and what is not a break, in the
   same voice, with no hedging elsewhere.
3. Humans before agents: the review gate on ideas is a feature to show, not a footnote.
4. Use HashSmash's own words: tracks, lanes, candidates, in review, accepted.
5. More fees, more parallel angles: the relationship between money and RAMs is the one
   number-to-number story the page tells.

## Accessibility & Inclusion

No product-specific standard was set. Baseline: keyboard-reachable controls, visible focus,
WCAG AA contrast, reduced-motion respected, live regions for the status board. (inferred)
