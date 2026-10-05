# RAMherd

A memecoin whose creator fees fund a herd of RAMs — independent AI agent instances — doing
real cryptanalysis research against [HashSmash](https://yukon.org/hashsmash), the public,
judged competition testing SHA-256, SHA3-256, and BLAKE3. See `docs/PRD.md` for full context,
and `docs/research/hashsmash-technical-brief.md` for exactly how HashSmash's own submission
and scoring pipeline works.

## Status

| Piece | State |
|---|---|
| PRD + HashSmash technical brief | **done** — grounded in the real competition repo, vendored at `reference/hash-smash/` |
| Orchestration backend (`server/`) | **built, tested (154 tests), mocked.** Fee ledger, budget→slot allocator, RAM slots, read-only coordinator, moderated idea queue, HTTP API all real; fee numbers and LLM calls are mock by default |
| Per-RAM models (OpenRouter) | **done, wired, mock by default.** Each of the six exploratory tracks carries its launch-roster model in `server/lib/targets.js` (RAM 1 `sha256-r31` → `anthropic/claude-opus-5.5`, 2 `sha256-r32` → `anthropic/claude-fable-5.1`, 3 `sha3-256-r5` → `openai/gpt-6.1-sol-pro`, 4 `sha3-256-r6` → `z-ai/glm-5.3-prime`, 5 `blake3-r1` → `deepseek/deepseek-v4-pro`, 6 `blake3-r2` → `qwen/qwen3.8-max-prime`; see `docs/PRD.md` "Decided"). Every slot sends its own model on each LLM call, a 7th+ slot inherits its track's model, and `/api/slots` shows it. Optional `RAMHERD_LLM_MODEL` forces one model on every slot (testing). Calls are still mock unless `RAMHERD_LIVE=true` **and** `OPENROUTER_API_KEY` are both set; no live call to any roster model has been made yet |
| Frontend dashboard (`src/`) | **built, demoable, mocked.** Real UI/UX against a mock data layer — see "Mock data and the API swap point" below |
| Solver-agent loop → real HashSmash pipeline (`server/lib/hashsmash.js`) | **pipeline integration working end to end, locally, for `sha256-r31-exploratory`.** A RAM slot clones the vendored repo, writes a clearly labeled harness *draft* (the organizer's own `draft_claim()` template, no attack claimed), and runs HashSmash's real `local_tracks.py check` and `hashsmash_pipeline.py intake`. Result: `check` → `mechanically_valid`, `intake` → `draft_not_submitted` with a real `package_sha256` and evidence file. Opt-in with `RAMHERD_PIPELINE=local`. **Not done:** no research content yet (the LLM doesn't write real candidates), no judge run (paid, gated off), no live submission (not implemented on purpose). The real accepted r31 candidate can't pass local intake here because its experiment needs Docker, which isn't installed. See "Real HashSmash pipeline" below |
| Live VM view per RAM: E2B desktop sandbox (`server/lib/sandbox.js`) | **backend lifecycle plumbing done, proven once for real, nothing runs inside yet.** A slot can be given one E2B Desktop sandbox (Ubuntu + Xfce, VNC via noVNC) through admin routes; `/api/slots` shows its session id and status, and an admin route returns the embeddable stream URL. Opt-in with `RAMHERD_SANDBOX=e2b` + `E2B_API_KEY`; off by default. One real run on 2026-10-05: created, noVNC page answered HTTP 200, killed after ~8 s, E2B confirmed it gone, cost about $0.001. **Not done:** frontend embedding, running the RAM's real work inside the sandbox, a smaller template (the stock `desktop` one runs at 8 vCPU / 8 GiB, about $0.53/hour each), and server-side view-only. See "E2B desktop sandboxes" below |
| Deployment (Fly.io, app `ramherd-app`, region lhr) | **set up, not live yet.** One server serves the API (`/api/*`) and the static frontend (`src/`) on one URL; `Dockerfile` + `fly.toml` (shared-cpu-1x / 256 MB, health check on `/api/health`, no volume: all state is in memory and resets on every deploy). **First launch (operator, once):** `fly apps create ramherd-app --org personal`, then `fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32) -a ramherd-app` (without it the admin routes fall back to the public `dev-admin-token`), then `scripts/deploy.sh`. **Redeploy after every change (no CI/CD):** commit, then run `scripts/deploy.sh`. It deploys the last *commit* only (uncommitted work never ships) and curls `/api/health` on https://ramherd-app.fly.dev when done. Add a Fly volume once launchpad / RAM ownership data must survive restarts |
| Launchpad: user-created RAMs — tested for real | **built and tested (75 offline tests + an opt-in devnet simulation).** `server/lib/launchpad.js` validation (exactly one hash family of SHA-256 / SHA3-256 / BLAKE3, a track inside it, one of six catalog approaches plus a 20–600 char brief through the idea screen, one of the six roster models, token name/symbol, on-curve owner wallet, unknown fields refused). Ownership model: `rams.js` (draft → awaiting-signature → active, operator confirms + approves the brief), `ramfunds.js` (per-RAM ledger: 0.2 SOL create fee, its token's creator fees, its compute; separate from the shared pool), owned slots in `slots.js` outside the budget roster (a resize never retires them), `payouts.js` (an *accepted* HashSmash win → "wallet X is owed Y, because Z" record, idempotent per candidate). Unsigned launch transaction in `launchtx.js`, encoded by pump.fun's official `@pump-fun/pump-sdk` 2.0.0: transfer 0.2 SOL user→treasury, `create_v2` (creator = user), `create_fee_sharing_config`, `update_fee_shares` (treasury 100%, locked by pump). Only the user and a browser-generated mint sign; the server only sees public keys. Serialization round-trips, both signature slots are empty, and an inspector rejects a changed treasury/fee/creator/shareholder, an extra instruction or a flipped byte. **Devnet:** with `RAMHERD_DEVNET_SIM=1`, every launch instruction is simulated against pump.fun's live devnet programs (err `null`; fee-sharing message 1210 bytes, ~240k CU), in two messages, since the full one doesn't fit without the lookup table |
| Launchpad — built, not verified | **Not live** (`config.live` is false and `LAUNCHPAD_LIVE = false` in `src/launch.js`). The full atomic launch is ~1300–1334 bytes, over Solana's 1232 limit, so it needs a v0 address lookup table of the launch's 14 static accounts (`launchLookupTableAddresses()`); with one it compiles to ~934 bytes (offline test), but no table exists on chain, so **the full four-instruction message has never been simulated together**. No real Phantom wallet has connected or signed (headless checks used a fake injected provider). The browser signing hand-off (`signAndSendLaunch`) is written but has never run, and the page CSP would need a `connect-src` for the RPC. Launch confirmation is the operator entering the tx signature by hand (`POST /api/admin/launchpad/rams/:id/confirm`); there is no on-chain launch verifier. State is in memory (lost on restart). Prize amount is not decided (admin supplies it per win). Frontend: `src/launch.html` entry slip, mock by default, also checked against the real server |
| Launchpad — out of scope (blocked capability) | Creating the lookup table on chain, signing or broadcasting any launch, sending any payout (only the owed record exists), claiming creator fees. No code path here can do any of these, and none needs the treasury's private key |
| Real pump.fun token / real fee claiming / real compute spend | **blocked**, same as every real-money action this workspace runs into — needs the operator to do those parts directly |
| GitHub | currently **no remote** — local-only; pushed to HashSmashLord and deleted twice so far; will get a fresh repo when ready |

## Launchpad settings

| Env var | Default | Effect |
|---|---|---|
| `TREASURY_WALLET` | the PRD's treasury address | public address that receives the 0.2 SOL fee and 100% of creator fees; the server refuses to start if it isn't a valid address. Its private key is never used or needed |
| `SOLANA_CLUSTER` / `SOLANA_RPC_URL` | `devnet` / public devnet RPC | read-only RPC for the blockhash and the lookup table, only when a table is configured |
| `RAMHERD_LAUNCH_ALT` | unset | address of the launch lookup table. Unset → `POST /api/launchpad/rams/:id/transaction` answers 409 `lookup_table_required` with the measured size, without calling the RPC |
| `RAMHERD_LAUNCHPAD_LIVE=true` | off | asks for live; `live` is only true when the table is set too, and the page's own `LAUNCHPAD_LIVE` constant must also be flipped |
| `RAMHERD_PUBLIC_BASE_URL` | `http://127.0.0.1:$PORT` | base of each token's metadata URI (`/api/launchpad/rams/:id/metadata.json`) |
| `RAMHERD_DEVNET_SIM=1` | off | test-only: runs `tests/launchtx-devnet.test.js` against devnet (network, simulation only) |

Devnet finding worth keeping: when name + symbol + uri total exactly 37 bytes, the Token-2022 mint is 355 bytes (the SPL Multisig size, which Token-2022 pads), and pump's `create_v2` under-funds its rent (`InsufficientFundsForRent` on the mint). `buildLaunchInstructions` refuses that length.

## Real HashSmash pipeline (what's proven, what isn't)

`server/lib/hashsmash.js` drives the **real** vendored repo (`reference/hash-smash/`, git-ignored,
pinned at its own HEAD) through its own Python CLI. Stock `python3` (3.14 here) is all it needs.
HashSmash's own `bash .yukon/setup.sh` passes with no pip installs (168 tests, 5 Docker tests skipped).

- **Proven:** a RAM slot on `sha256-r31-exploratory` runs a real `check` + `intake` cycle and gets
  the pipeline's own verdict back into its feed (`server/lib/slots.js`, status `validated`). The
  tests also show the real intake **rejects** broken packages (bad `success_probability`, extra
  file), and that the real pipeline refuses to judge a draft.
- **Not claimed:** any cryptanalysis result. The candidate is a harness test. Its numbers are the
  organizer's unmodified template, it says so in `claim.json` and `proof.md`, and it is a `draft`,
  so HashSmash itself stops it before the judge. "Passed intake" means well-formed, nothing more.
- **Isolation:** each slot works in its own clone under `.ramherd/workspaces/<slot>/` (git-ignored).
  The vendored repo and its real accepted candidate are never written to, and a test checks this.
  Python runs without a shell and with a minimal environment, so no keys reach credential-free stages.

| Env var | Default | Effect |
|---|---|---|
| `RAMHERD_PIPELINE=local` | off | sha256-r31 slots run the real local pipeline (free, credential-free) instead of the mock step |
| `RAMHERD_HASHSMASH_JUDGE=true` | off | allows the paid `judge`/`score` stages, **only** when `RAMHERD_LIVE=true` and `OPENROUTER_API_KEY` are also set |
| `RAMHERD_HASHSMASH_SUBMIT=true` | off | recorded only. Live submission to the HashSmash/Yukon competition is **not implemented**; `submitLive()` always refuses |

Known environment gap: the real accepted r31 package declares a `python-message-pairs-v1`
experiment, which HashSmash only runs in its pinned Docker sandbox, with no host fallback.
Docker isn't installed on this machine, so intake on that package exits `3`. The runner reports
this as `environment-blocked` (a setup problem, not a verdict on the candidate).

## E2B desktop sandboxes (what's proven, what isn't)

`server/lib/sandbox.js` wraps `@e2b/desktop` (the API shape was read from the installed SDK source, not guessed):
`Sandbox.create('desktop', { apiKey, timeoutMs, metadata, lifecycle: { onTimeout: 'kill' } })` →
`stream.start({ requireAuth: true })` → `stream.getUrl({ viewOnly: true, authKey })` → `kill()`.

- **Proven (once, by hand, 2026-10-05):** one real sandbox (`desktop` template, 8 vCPU / 8 GiB as
  E2B reported it) was created and streaming in 7.5 s. Its `https://6080-<id>.e2b.app/vnc.html` page
  returned HTTP 200 (noVNC). It was killed after 8.1 s, and E2B then reported "not found", with 0
  sandboxes left running on the account. Estimated cost was about $0.0012.
- **Mocked:** the whole test suite (`tests/sandbox.test.js`) uses a fake SDK, so no test run ever
  creates a real sandbox.
- **Cost rails:** nothing is created unless an admin calls start. Every sandbox has an E2B-side hard
  timeout (it gets killed even if this server dies), there's a concurrency cap, retiring a slot kills
  its sandbox, and server shutdown kills them all.
- **Not built yet:** frontend VNC embedding, and running the RAM's real work inside the sandbox
  (the intended content is written up at the top of `sandbox.js`).
- **Before showing it to the public:** noVNC's `view_only` is client-side only, so anyone who holds
  the URL (it includes the VNC password) can take control. That's why the URL is admin-only. To
  enforce view-only on the server, start x11vnc with `-viewonly`, or put a proxy in front.

| Env var | Default | Effect |
|---|---|---|
| `RAMHERD_SANDBOX=e2b` | off | enables sandboxes (also needs `E2B_API_KEY`); without it the SDK is never even imported |
| `RAMHERD_SANDBOX_TEMPLATE` | `desktop` | template name/id (a smaller custom template is the next cost step) |
| `RAMHERD_SANDBOX_TIMEOUT_MIN` | 15 | E2B-side hard kill timeout per sandbox (1 to 1440) |
| `RAMHERD_SANDBOX_MAX` | 6 | max concurrent sandboxes from this server (1 to 100) |

Admin routes (`x-admin-token`): `POST /api/admin/slots/:id/sandbox/start`, `POST /api/admin/slots/:id/sandbox/stop`,
`GET /api/admin/slots/:id/sandbox` (stream URL).

## Build convention for the real coding work (not the scaffolding/docs)

The actual technical pieces — the solver-agent loop, any real cryptanalysis-adjacent code,
anything load-bearing — run on stronger models (Opus 5.5 / Fable 5.1), not the default.

The frontend is built with [Impeccable](https://www.npmjs.com/package/impeccable) going
forward (`.claude/skills/impeccable/` is installed in this repo) — run its `context.mjs` →
`new-work.md` → `craft-floor.md` flow before touching UI, same as this workspace's other
frontends.

---

This section below covers the **frontend dashboard** specifically. The orchestration backend
(fee ledger, slot allocator, coordinator, moderation queue, HashSmash pipeline runner) lives in
`server/`. Run its tests with `npm test`; the pipeline tests need `reference/hash-smash/` and
`python3`, and they skip with a stated reason when either is missing.

## Frontend — run it

Vanilla HTML/CSS/JS, no build step, no dependencies. Everything lives in `src/`.

```bash
cd src
python3 -m http.server 4701
# or: npx serve -l 4701
```

Then open `http://127.0.0.1:4701`. Port 4701 on purpose — the backend owns **4700** in this
env (see `AGENTS.md`); the frontend stays out of its way and the two can run side by side.

## Frontend structure

```
src/
  index.html      one "sheet": header box (hook + fund rows + entrants-by-round), the
                  results board (one row per RAM), coordinator log, idea slip + review
                  notice, "what counts" regulations
  styles.css      all styling — light paper on green felt, three inks, self-hosted Archivo
                  variable, no framework; tokens in :root (see DESIGN.md)
  app.js          wires the DOM to the mock data layer; diffs rows by id on every tick
  mock-data.js    <- the mock-data / real-API swap point, see below
  fonts/          archivo-variable.woff2 (the only face; width + weight axes)
  favicon.svg
```

## Mock data and the API swap point

`src/mock-data.js` is the **only** file that knows whether data is mocked or real. Every
render in `app.js` calls through the `RAMherdAPI` object exported from that file —
`getStats()`, `getFleet()`, `getChatSeed()`, `askCoordinator(question)`, `submitIdea(payload)`,
`subscribeLive(onTick)`. Nothing else in the frontend touches mock data directly.

To swap in the real backend once it's up:

1. Set `API_BASE` at the top of `mock-data.js` to the backend's URL (e.g.
   `http://127.0.0.1:4700`, matching `server/`'s `/api/*` routes).
2. Replace each `RAMherdAPI` method body with a `fetch()` call to the matching endpoint
   (`/api/ledger`, `/api/slots`, `/api/coordinator/summary`, `/api/coordinator/ask`,
   `/api/ideas`). The shapes the frontend already expects are documented in the comments
   above each method — keep them, or adjust `app.js`'s render functions to match whatever
   the real response actually looks like.
3. Delete `startMockLiveFeed` / `tickMockState` at the bottom of `mock-data.js` — the real
   backend updates this state itself; the frontend should poll or subscribe to it instead of
   simulating drift locally.

Nothing in `index.html`, `styles.css`, or `app.js` needs to change for that swap.

## What's mocked right now, specifically

- Fees collected, compute budget/spend, and active-slot counts — a small live-drifting mock
  state (`tickMockState`), not real pump.fun data.
- The 6-RAM results board: the launch roster, one RAM per real HashSmash track
  (`sha256-r31`, `sha256-r32`, `sha3-256-r5`, `sha3-256-r6`, `blake3-r1`, `blake3-r2`, matching
  `reference/hash-smash/tracks/` and `reference/hash-smash/lanes/exploratory/candidates/`),
  each row showing that RAM's real assigned OpenRouter model (same slugs as
  `server/lib/targets.js`), with invented but specific per-agent activity text.
- Coordinator chat — seeded with 5 realistic Q&A pairs plus keyword-matched replies for
  anything else typed in; a real backend would route this to an actual model call.
- Idea submission — client-side only; "submitting" increments a mock queue-position counter.
  The real version posts to the backend's human-review queue.

## Design notes

The second pass was built through Impeccable's actual process (`.claude/skills/impeccable/`),
not by eye. The artifacts it left behind are the source of truth for the look:

- `PRODUCT.md` — product truth from `/impeccable init`. Written from the PRD without a live
  interview (background run); inferred lines are marked.
- `.impeccable/surfaces/src-index-html.md` — the surface brief with the six-block direction
  contract (THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM / FINISH).
- `DESIGN.md` + `.impeccable/design.json` — the token-bearing design system, written from the
  built page by the documenter at finish.

**What the process changed versus the first pass.** The first pass was the category default:
near-black, one blue neon accent, status chips, same-size cards, Space Grotesk + IBM Plex Mono
(both on Impeccable's "training-data defaults" list; the craft floor names "monospace as a
costume for technical" as a refusal). `new-work.md`'s direction roll (`concept-seed`, seed key
`4c815091`, mode Persuade) assigned candidate 6 of a seven-item list drawn from the audience's
world and kept the dark-dashboard rut out of it. The result is **the tournament wallchart**:
the page is one off-white results sheet pinned to bottle-green felt, with HashSmash's rounds
as the chart's rounds, one written row per RAM, the fund printed in the header box, and three
inks — printed black for what the organiser set, blue-black pen for what is written live,
one red reserved for HashSmash's review state (the "in review" mark and the judge margin
rule). Light scene on purpose: a hall under fluorescent light, so a light page. Status is a
written word plus a drawn glyph, never a coloured chip; rows nobody has written to for five
minutes thin their ink. One face, Archivo variable, self-hosted; its width axis does the work
two families did before. One motion only: a changed cell is re-inked left to right (no
entrance animation, rows are diffed by id so a tick never re-renders the sheet). Six catalog
challengers were weighed and declined/competitive; each declined one donated a discipline
(committed stock colour, fixed cell geometry across states, discrete writes with stale-ink
thinning, one fixed legend, one reserved stamp colour) — all recorded in the brief's FORM block.

**What `detect` found and what was fixed.** `npx -y impeccable detect src/...` and the
installed binary were run after the build. First run: 9 anti-patterns + 1 advisory —
3× `side-tab` (the `3px double` section rules), 5× `cramped-padding`, 1× `layout-transition`
(the budget meter animated `width`), 2× gray-text-on-coloured-background (the felt's soft ink
was too desaturated), advisory `repeating-stripes-gradient` (the felt weave). Fixes: double
rules drawn as 1px pseudo-element pairs; bordered containers use plain rem padding stepped by
media query (the static detector can't read `clamp()` and flattens media queries); meter on
`transform`; felt ink retinted to `#9fd1b4`; weave as a drawn SVG tile. One scoped waiver,
stated inline: the ruled header box's inset lives in its cells like a table. Once DESIGN.md
existed the detector also raised 17 design-system advisories (a `currentColor` border and five
ad-hoc font sizes off the recorded ramp); the stamp now uses the judge token and the sizes were
collapsed onto a four-step ramp (0.74 / 0.82 / 0.92 / 1rem) recorded in DESIGN.md. **Final: 0
findings, 0 advisories.**

**Finish review.** A fresh reviewer agent (Impeccable's shipped finish-reviewer definition,
run as a general-purpose agent because this harness doesn't expose it by name) returned
**fix** with seven material items — first viewport missing the contract at 1440/1280, the
mock-feed label only at the page bottom, Judge-column copy over-claiming, missing red judge
margin, mobile row geometry and a mid-segment path break, meter animating on first paint,
felt reading as mesh. All seven were fixed and scored **resolved → ship** over two verdict
rounds. Screenshots were real this time: a headless Chromium exists on this machine
(`~/Library/Caches/ms-playwright/chromium_headless_shell-*`), captures live in
`.impeccable/review/` (gitignored).

Still true from the first pass: no system display face, no emoji-as-icons, no gradient text,
no kicker labels, no coloured card borders, no cards.

---

Built with help from Claude and OpenRouter. Cryptanalysis target and research framing from
[Zooko](https://x.com/zooko) and [Yukon](https://www.yukon.org/).
