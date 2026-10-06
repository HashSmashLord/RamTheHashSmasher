# HashSmashing

$RAM, our official token, whose creator fees fund a herd of RAMs — independent AI agent instances — doing
real cryptanalysis research against [HashSmash](https://yukon.org/hashsmash), the public,
judged competition testing SHA-256, SHA3-256, and BLAKE3. See `docs/PRD.md` for full context,
and `docs/research/hashsmash-technical-brief.md` for exactly how HashSmash's own submission
and scoring pipeline works.

## Status

| Piece | State |
|---|---|
| PRD + HashSmash technical brief | **done** — grounded in the real competition repo, vendored at `reference/hash-smash/` |
| Orchestration backend (`server/`) | **built, tested; real end-to-end, off by default.** Fee ledger, budget→slot allocator, RAM slots, read-only coordinator, moderated idea queue, HTTP API all real; fee numbers and LLM calls run on an in-process stand-in by default, not yet turned on in this deployment (proven to work for real — see "Going live" below) |
| Per-RAM compute cost (`server/lib/cost.js`) | **built, tested, backend-only.** Every real "thinking" LLM call (a RAM's or the Herder's) reports its prompt/completion/total tokens and OpenRouter's actual USD `cost` (always present on a real response; left `null`, not coerced to 0, on the rare response that omits it) against that slot, keyed by RAM id for owned (launchpad) slots too — whose own funding account (`ramfunds.js`) is charged automatically from the same entry. No route reads it yet, on purpose: the figures exist before the frontend has anywhere to put them. Tracks tokens and USD, deliberately not SOL — that needs a live price feed this doesn't have. Demo mode records an honest zero, never a fabricated number |
| Per-RAM models (OpenRouter) | **done, wired; real end-to-end, off by default.** Each of the six exploratory tracks carries its launch-roster model in `server/lib/targets.js` (RAM 1 `sha256-r31` → `anthropic/claude-opus-5.5`, 2 `sha256-r32` → `anthropic/claude-fable-5.1`, 3 `sha3-256-r5` → `openai/gpt-6.1-sol-pro`, 4 `sha3-256-r6` → `z-ai/glm-5.3-prime`, 5 `blake3-r1` → `deepseek/deepseek-v4-pro`, 6 `blake3-r2` → `qwen/qwen3.8-max-prime`; see `docs/PRD.md` "Decided"). Every slot sends its own model on each LLM call, a 7th+ slot inherits its track's model, and `/api/slots` shows it. Optional `RAMHERD_LLM_MODEL` forces one model on every slot (testing). Calls still run on the in-process stand-in unless `RAMHERD_LIVE=true` **and** `OPENROUTER_API_KEY` are both set — real end-to-end, including the per-RAM model slug, proven working 2026-10-05 (see "Going live" below); the deployed site just doesn't have the flag + key set yet |
| Frontend dashboard (`src/`) | **built; real UI/UX, with an in-browser fallback for when no backend answers.** Third visual pass (2026-10-05): pixel-art monochrome, every RAM a screen, the Herder a panel. Split into real pages the same day: the banner page, the Herd (`herd.html`, with a full page per RAM at `herd.html#ram/<id>`), the Herder (`herder.html`), ideas (`submit.html`), what counts (`rules.html`), the entry slip (`launch.html`). Real UI/UX, auto-detecting the real backend — see "Frontend structure", "Frontend data: fallback and real-backend auto-detection" and "Design notes" below |
| Real research content: `sha256-r32` (`research/sha256-r32/`) | **one real, modest, honest result; not judged, not submitted.** See "Real HashSmash pipeline" below |
| Solver-agent loop → real HashSmash pipeline (`server/lib/hashsmash.js`) | **pipeline integration working end to end, locally, for all six active exploratory tracks** (`sha256-r31`, `sha256-r32`, `sha3-256-r5`, `sha3-256-r6`, `blake3-r1`, `blake3-r2`). A RAM slot clones the vendored repo; on five of the six it writes a clearly labeled harness *draft* (that track's own `draft_claim()` template from the organizer's `verifier.frontier_tracks.get_frontier_track()` — already generic per hash family, not a SHA-256-only path — no attack claimed), and on `sha256-r32` it writes the one committed research package. Either way it runs HashSmash's real `local_tracks.py check` and `hashsmash_pipeline.py intake`. Result on every harness-draft track, verified individually against the real vendored repo: `check` → `mechanically_valid`, `intake` → `draft_not_submitted` with a real `package_sha256` and evidence file. Opt-in with `RAMHERD_PIPELINE=local`. **Not done:** the LLM doesn't write candidates (the one research package, r32, was written by hand by a Claude session), no judge run (paid, gated off), no live submission (not implemented on purpose). The real accepted r31 candidate can't pass local intake here because its experiment needs Docker, which isn't installed. See "Real HashSmash pipeline" below |
| Live VM view per RAM: E2B desktop sandbox (`server/lib/sandbox.js`, `src/sandbox-viewer.js`) | **view-only now enforced by the VNC server and proven with real input events; frontend viewer built; nothing runs inside the sandbox yet.** The previously flagged gap (noVNC `view_only` was only a page setting, so anyone holding the URL could take control) is **fixed**: x11vnc now runs with `-viewonly`, so it drops every pointer, key and clipboard message from every client, and no full-control VNC listener exists at all. Proven 2026-10-05 on a real sandbox (`scripts/prove-viewonly.mjs`): a raw RFB client authenticated on the public stream and sent moves, a click and keystrokes → pointer unmoved, nothing typed, 0 raw X input events; the same script against a test-only x11vnc *without* `-viewonly` moved the pointer and typed. A public `GET /api/slots/:id/stream` hands out that stream, and each board row has a "Watch desk" viewer that embeds only it. Opt-in with `RAMHERD_SANDBOX=e2b` + `E2B_API_KEY`; off by default; starting one stays admin-only. **Not done:** running the RAM's real work inside the sandbox, a smaller template (stock `desktop` = 8 vCPU / 8 GiB, about $0.53/hour each); every desk reads "no desktop running" for now, since nothing yet runs inside any sandbox. See "E2B desktop sandboxes" below |
| Deployment (Fly.io, app `ramherd-app`, region lhr) | **live**, at [hashrammers.com](https://hashrammers.com) and [hashsmashers.com](https://hashsmashers.com) (both custom domains, Fly certs on apex+www) and `ramherd-app.fly.dev`. One server serves the API (`/api/*`) and the static frontend (`src/`) on one URL; `Dockerfile` + `fly.toml` (shared-cpu-1x / 256 MB, health check on `/api/health`; the launchpad's RAM registry now survives a deploy/restart once `RAMHERD_DATA_DIR` points at a real Fly volume (`RAMHERD_DATA_DIR`, above) — everything else (fee ledger, roster slots, sandboxes, ramFunds/payouts) is still in memory and still resets). Redeployed after every change, same day: commit, then `scripts/deploy.sh` — it deploys the last *commit* only (uncommitted work never ships) and curls `/api/health` when done. `ADMIN_TOKEN` and `PINATA_JWT` are set as Fly secrets (`fly secrets list -a ramherd-app`), never in the Dockerfile/fly.toml. The code is ready to persist the RAM registry (`RAMHERD_DATA_DIR`, above); `fly.toml` still needs a `[[mounts]]` volume added and the env var set before this takes effect in production — see the code review/handoff notes for the exact command and snippet |
| Launchpad: user-created RAMs — tested for real | **built and tested (75 offline tests + an opt-in devnet simulation).** `server/lib/launchpad.js` validation (exactly one hash family of SHA-256 / SHA3-256 / BLAKE3, a track inside it, one of six catalog approaches plus a 20–600 char brief through the idea screen, one of the six roster models, token name/symbol, on-curve owner wallet, unknown fields refused). Ownership model: `rams.js` (draft → awaiting-signature → active, operator confirms + approves the brief), `ramfunds.js` (per-RAM ledger: 0.01 SOL create fee, its token's creator fees, its compute; separate from the shared pool), owned slots in `slots.js` outside the budget roster (a resize never retires them), `payouts.js` (an *accepted* HashSmash win → "wallet X is owed Y, because Z" record, idempotent per candidate). Unsigned launch transaction in `launchtx.js`, encoded by pump.fun's official `@pump-fun/pump-sdk` 2.0.0: transfer 0.01 SOL user→treasury, `create_v2` (creator = user), `create_fee_sharing_config`, `update_fee_shares` (treasury 100%, locked by pump). Only the user and a browser-generated mint sign; the server only sees public keys. Serialization round-trips, both signature slots are empty, and an inspector rejects a changed treasury/fee/creator/shareholder, an extra instruction or a flipped byte. **Devnet:** with `RAMHERD_DEVNET_SIM=1`, every launch instruction is simulated against pump.fun's live devnet programs (err `null`; fee-sharing message 1210 bytes, ~240k CU), in two messages, since the full one doesn't fit without the lookup table |
| Launchpad — live, real launches confirmed on chain | **Live in production** (`config.live` true: `LAUNCHPAD_LIVE` and a real lookup table are both set). Real Phantom wallets have signed and sent real launch transactions on mainnet (confirmed by hand reading the chain, 2026-10-06: CreateV2 ran, mint/treasury/owner all present, err `null`). `server/lib/launchverify.js` does that same check in code now, and `POST /api/launchpad/rams/:id/report-signature` (public) calls it: the client reports its own signature right after sending, the server verifies it for real against the chain, and only then activates the RAM — closing the gap where an operator had to find the signature and `POST /api/admin/launchpad/rams/:id/confirm` by hand every time (that admin route still exists, as the fallback for a report call that never went out). **The real risk now is state, not signing**: everything (the RAM registry, its owned slot, its funding ledger) is in memory with no volume, so it does not survive a restart — not just a redeploy; a same-version machine recreate (e.g. a `fly scale` resize) wipes it too, and did, mid-launch, during this exact work (2026-10-06): a real, finalized, fee-paid launch (`ram-0001`, mint `5eFeWtcbgvP6GLYNjG6jhYM9hazXAPxk97sBDkmXZgQB`) disappeared from the registry before it could be confirmed. The token itself is permanent on chain either way; only HashRammers' own bookkeeping of it is lost. Add a volume (or persist the store to disk on every write) before trusting this with real launches unattended |
| Launchpad — out of scope (blocked capability) | Creating the lookup table on chain, signing or broadcasting any launch, sending any payout (only the owed record exists), claiming creator fees. No code path here can do any of these, and none needs the treasury's private key |
| Real pump.fun token / real fee claiming / real compute spend | **blocked**, same as every real-money action this workspace runs into — needs the operator to do those parts directly |
| GitHub | **live and public**: [HashSmashLord/RamTheHashSmasher](https://github.com/HashSmashLord/RamTheHashSmasher). Pushed as it goes, real-authored-only (no rewritten/misattributed history) |
| Clean URLs | `/herd`, `/herder`, `/submit`, `/rules`, `/launch`, and `/` for home — no `.html` anywhere in the site's own links. The old `*.html` paths still work too (`server/app.js`'s static server tries a bare path's `.html` file when the path itself has no extension); nothing already shared breaks |
| Per-RAM uptime | Every tile and RAM page shows "Live for Xh Ym". Derived from the RAM's own oldest history line, not a second number that could drift out of sync with it; real backend equivalent is the slot's own `createdAt` (already on every `/api/slots` row) |
| Launchpad metadata → Pinata (`server/lib/pinata.js`) | **wired, verified against the real API.** Opt-in with `PINATA_JWT`: a launchpad draft's metadata JSON gets pinned to real IPFS right after creation, and its `token.uri` swaps from this server's own endpoint to the pinned gateway URL once the pin resolves. `createDraft` stays synchronous either way — a draft starts on the self-hosted URI and a slow/failed pin never blocks or breaks it. `waitForMetadataPin(id)` awaits the real outcome deterministically (used by tests and available to an operator). **Token image (required)**: the entry slip uploads it first (`POST /api/launchpad/images`, raw bytes, PNG/JPG/GIF/WEBP by file signature, 2 MB max; `server/lib/images.js`), it is pinned with `pinFileToIPFS` (own global cap, 10/hour) and the metadata's `image` field is its gateway URL; with no `PINATA_JWT`, over the cap or on a failed pin it is held in memory (16 MB total) and served at `/api/launchpad/images/:id` instead. Verified against the real API: image pinned, metadata pinned with that `image`, both fetched back from the gateway byte-for-byte |

## Launchpad settings

| Env var | Default | Effect |
|---|---|---|
| `TREASURY_WALLET` | the PRD's treasury address | public address that receives the 0.01 SOL fee and 100% of creator fees; the server refuses to start if it isn't a valid address. Its private key is never used or needed |
| `SOLANA_CLUSTER` / `SOLANA_RPC_URL` | `devnet` / public devnet RPC if unset; production sets `SOLANA_CLUSTER=mainnet-beta` | read-only RPC for the blockhash and the lookup table, only when a table is configured |
| `RAMHERD_LAUNCH_ALT` | unset | address of the launch lookup table. Unset → `POST /api/launchpad/rams/:id/transaction` answers 409 `lookup_table_required` with the measured size, without calling the RPC |
| `RAMHERD_LAUNCHPAD_LIVE=true` | off | asks for live; `live` is only true when the table is set too, and the page's own `LAUNCHPAD_LIVE` constant must also be flipped |
| `RAMHERD_PUBLIC_BASE_URL` | `http://127.0.0.1:$PORT` | base of each token's metadata URI (`/api/launchpad/rams/:id/metadata.json`) and of its metadata `external_url` (the token's website link): `<base>/herd#ram/<launchpad ram id>`, e.g. `https://hashrammers.com/herd#ram/ram-0004`. Keyed by the launchpad id because metadata is built (and pinned) at draft time, before the RAM has a slot; the herd page resolves it (`src/ram-resolve.js`): a slot 404 falls back to `/api/launchpad/rams/:id`, an active RAM settles on its real slot's page (`#ram/slot-N`), a draft / awaiting-signature / cancelled RAM gets an honest "not launched" page |
| `RAMHERD_DEVNET_SIM=1` | off | test-only: runs `tests/launchtx-devnet.test.js` against devnet (network, simulation only) |
| `PINATA_JWT` | unset | pins a draft's metadata JSON and its token image to real IPFS (`server/lib/pinata.js`); unset keeps the self-hosted `metadata.json` URI and serves the image from `/api/launchpad/images/:id`, both from memory |
| `RAMHERD_MAX_SLOTS` | `12` | the original roster's starting ceiling. Each launchpad RAM the operator confirms active adds 1 (`SLOTS_PER_CONFIRMED_LAUNCH`, `server/lib/budget.js` `withLaunchCeiling`, counted in `server/store.js`). Append-only: a later cancel or anything else never lowers it; in memory, so a restart resets it like all other state. Fees still have to pay for a seat (`usdPerSlot`) before it exists; launchpad RAMs run in owned slots outside the roster and never count toward it. `/api/allocation` reports `maxSlots` (with growth), `maxSlotsBase` and `launchesConfirmed` |
| `RAMHERD_DATA_DIR` | unset (no persistence — today's in-memory-only behaviour) | when set, the launchpad's RAM registry (`server/lib/rams.js`'s `rams` Map: draft/awaiting-signature/active/cancelled records, token info, owner, launch signature, slot id, history) is written to `<dir>/rams.json` on every real mutation (atomic write, `server/lib/persist.js`) and reloaded on boot, so it survives a restart. Production: a Fly volume mounted at e.g. `/data`. Local dev wanting the same survival: `.ramherd/data` (already git-ignored). An `active` RAM gets a freshly recreated owned slot on boot (idle, no sandbox — slot/sandbox state itself is never persisted); `ramFunds`/`payouts` (the RAM's funding account, any owed payouts) are not persisted yet either. See `rams.js`'s module header for the full honesty breakdown |
| `RAMHERD_FEE_SOURCE=onchain` | unset (the mock/admin/auto-seed-set fee number stays the default) | "Fees collected, lifetime" (the homepage stat) is read for real off chain (`server/lib/pumpfee.js`) instead of the mock, summing **two** real, separate pump.fun fee mechanisms, both confirmed live 2026-10-06: (1) `DistributeCreatorFees` (bonding-curve era), paid in native SOL straight into the treasury's balance; (2) `CollectCoinCreatorFee` (after a token migrates to pump's own AMM), paid in **the migrated token itself** into a token account the treasury owns — found only after the operator reported the real total was well above what mechanism 1 alone reported. Each collected token is priced individually via Jupiter's real per-mint price API (CoinGecko doesn't cover arbitrary pump.fun tokens); the SOL leg still prices off CoinGecko. A mint that fails to price is skipped and logged, never blocking the rest. Never the 0.01 SOL launch create-fee transfer that lands in the same wallet (a third, different real instruction, `CreateV2`). Needs no secret (every endpoint here is public/keyless), but is still gated like everything else here. Incremental after its first (capped) scan, refreshed every 10 minutes (`server/index.js`). **Real consequence once on:** `autoseed.js`'s roster-funding bootstrap only works against the mock source (`feeSource.kind === 'mock'`), so it honestly skips with this on — the roster is funded by real collected fees only, not a synthetic $5/seat bootstrap number |

Devnet finding worth keeping: when name + symbol + uri total exactly 37 bytes, the Token-2022 mint is 355 bytes (the SPL Multisig size, which Token-2022 pads), and pump's `create_v2` under-funds its rent (`InsufficientFundsForRent` on the mint). `buildLaunchInstructions` refuses that length.

## Real HashSmash pipeline (what's proven, what isn't)

`server/lib/hashsmash.js` drives the **real** vendored repo (`reference/hash-smash/`, git-ignored,
pinned at its own HEAD) through its own Python CLI. Stock `python3` (3.14 here) is all it needs.
HashSmash's own `bash .yukon/setup.sh` passes with no pip installs (168 tests, 5 Docker tests skipped).

- **Proven:** a RAM slot on any of the five harness-draft tracks (`sha256-r31`, `sha3-256-r5`,
  `sha3-256-r6`, `blake3-r1`, `blake3-r2`, all `-exploratory`) runs a real `check` + `intake` cycle
  and gets the pipeline's own verdict back into its feed (`server/lib/slots.js`, status `validated`).
  Each of the five is verified individually against the real vendored repo, not assumed to transfer
  unchanged from SHA-256 — every one lands on `check` → `mechanically_valid`,
  `intake` → `draft_not_submitted` with its own real `package_sha256` and evidence file
  (`tests/hashsmash.test.js`). The tests also show the real intake **rejects** broken packages (bad
  `success_probability`, extra file), and that the real pipeline refuses to judge a draft.
- **Not claimed (harness-draft tracks):** any cryptanalysis result, on any of the five. Each
  candidate is a harness test. Its numbers are that track's own organizer template, unmodified
  (`verifier.frontier_tracks.get_frontier_track(track).draft_claim()`), it says so in `claim.json`
  and `proof.md`, and it is a `draft`, so HashSmash itself stops it before the judge. "Passed
  intake" means well-formed, nothing more.
- **Real content (r32):** a slot on `sha256-r32-exploratory` copies `research/sha256-r32/package/`
  into its clone. It is `ready`, so real intake passes it (exit 0) and the slot stops at a `gated`
  judge — not submitted anywhere. `tests/hashsmash.test.js` recompiles `research/sha256-r32/r32.c`
  and re-checks its reproduction against its own `proof.md`.
- **Isolation:** each slot works in its own clone under `.ramherd/workspaces/<slot>/` (git-ignored).
  The vendored repo and its real accepted candidate are never written to, and a test checks this.
  Python runs without a shell and with a minimal environment, so no keys reach credential-free stages.
- **Attribution:** every real pipeline run also writes `.ramherd/attribution/<slotId>__<track>.json`
  (git-ignored, outside the candidate package and outside the workspace clone, so the organizer's own
  `check`/`intake` never sees it) recording which RAM — slot id, real model id, approach — produced
  that candidate, plus its claimed `time_log2`/`success_probability`. There is still no real external
  submission path (see "Yukon submission CLI" below), so nothing is sent anywhere with it yet; it
  exists so that attribution is ready the moment one exists. `writeAttribution` in `hashsmash.js`.

| Env var | Default | Effect |
|---|---|---|
| `RAMHERD_PIPELINE=local` | off | all six roster tracks run the real local pipeline (free, credential-free) instead of the simulated step: five as a harness draft (`sha256-r31`, `sha3-256-r5`, `sha3-256-r6`, `blake3-r1`, `blake3-r2`), `sha256-r32` as the committed research package |
| `RAMHERD_HASHSMASH_JUDGE=true` | off | allows the paid `judge`/`score` stages, **only** when `RAMHERD_LIVE=true` and `OPENROUTER_API_KEY` are also set |
| `RAMHERD_HASHSMASH_SUBMIT=true` | off | recorded only, read nowhere. `submitLive()` always refuses; the real external path, if ever used, is `server/lib/yukon-submit.js` below, not this flag |

Known environment gap: the real accepted r31 package declares a `python-message-pairs-v1`
experiment, which HashSmash only runs in its pinned Docker sandbox, with no host fallback.
Docker isn't installed on this machine, so intake on that package exits `3`. The runner reports
this as `environment-blocked` (a setup problem, not a verdict on the candidate).

## Yukon submission CLI (built, gated off, never run)

`server/lib/yukon-submit.js` wraps the **real** external HashSmash/Yukon submission path — a
separate CLI (`yukon`), not a GitHub PR against `Layr-Labs/hash-smash`: `yukon login`, `yukon clone
<track-benchmark-id>`, `yukon setup --track`, `yukon run --track`, then `yukon submit --track <track>
--model <model> --harness <harness> --note-file <file>`. `--model`/`--harness` are the real
attribution mechanism for a real submission; this module feeds them from exactly the attribution
record described above, never a fabricated name.

**Nothing in this repo has ever run this for real.** It refuses unless BOTH `RAMHERD_YUKON_SUBMIT=true`
and a real `YUKON_API_KEY` are set, and even then a caller still has to decide to call `submit()` —
the gate is not the operator's go-ahead. Every test (`tests/yukon-submit.test.js`) runs against a
fake CLI function, the same way `tests/sandbox.test.js` fakes the E2B SDK; none of them ever sets
both env vars and a real key together. Per-track benchmark id is unconfirmed beyond one example
(`blake3-r1-exploratory` → `86d5040e-d37d-4f41-bab6-1f2cd57e7398`); `clone()` takes it as a required
argument rather than guessing the other five.

| Env var | Default | Effect |
|---|---|---|
| `RAMHERD_YUKON_SUBMIT=true` | off | opt-in gate; without it every step of `createYukonSubmitter()` refuses before touching a process |
| `YUKON_API_KEY` | unset | required in addition to the flag; a missing/blank key refuses even with the flag on |

`writeSubmissionNote()` (writing the honest note file to disk) and `commandFor()` (a safe command
preview) both work with the gate off — only `login`/`clone`/`setup`/`run`/`submit` are gated.

### Running it inside a sandbox (`server/lib/yukon-sandbox.js`)

The CLI steps above have to run **inside** a RAM's E2B desktop sandbox, not on this host (that's
where `yukon run` would actually do its work). `yukon-sandbox.js` adapts `yukon-submit.js`'s
`run(cmd, args, opts)` shape onto the sandbox's own authenticated command channel
(`sbx.commands.run`) and is scoped to exactly one roster slot: `blake3-r1-exploratory`, the only
track with a confirmed real benchmark id. `slots.js` calls it exactly once, right after that slot's
one-time workbench intro finishes on a fresh sandbox — never for any other slot, and gated by the
same `RAMHERD_YUKON_SUBMIT` + `YUKON_API_KEY` pair as above (checked inside the module itself, so it
stays a no-op by default even though the wiring is always present when sandboxes are on). Real steps,
in order, each landing in the feed as `yukon-step`: `curl ... | sh` (install), `yukon login` (the key
reaches the sandbox only as a process env var on that one call, referenced in the command text as
`"$YUKON_API_KEY"`, never the literal value — and never typed into a visible terminal, unlike the
workbench intro), `yukon clone 86d5040e-...` (its real stdout's own `cd <dir>` line is parsed, never
guessed), `yukon setup --track` and `yukon run --track` in that directory. Only after all of that
succeeds does `decideYukonSubmission()` decide whether to ever call `yukon submit`: it requires a
real numeric measurement (`slot.bestResult`, the same tracker the active loop uses) with a
genuinely positive success probability — never a guess. **Keeps improving, submits again only on a
genuine improvement:** once a real submission ever succeeds, `slots.js` remembers it on the slot
(`lastSubmittedResult`) and feeds it back in on the slot's next fresh sandbox session (a restart);
`decideYukonSubmission` then only says yes a second time if the current `bestResult` is a real,
strictly lower `time_log2` than what was actually submitted last time — an equal or worse number is
correctly never resubmitted. This still runs once per fresh sandbox session, not on a tight loop
against Yukon's own CLI mid-session; a restart (E2B's own timeout, or `RAMHERD_SANDBOX_AUTORESTART`)
is what gives it its real cadence. Today there is no real experiment runner for
`blake3-r1-exploratory`, so the very first decision is always "no" and the feed says so honestly
(`yukon-submit-skipped`), the same pattern as "no real runner for this track yet" elsewhere in this
codebase. `tests/yukon-sandbox.test.js` covers all of it against a fake sandbox; its one
non-negotiable test asserts the real CLI is never invoked while the gate is off.

## E2B desktop sandboxes (what's proven, what isn't)

`server/lib/sandbox.js` wraps `@e2b/desktop` (the API shape was read from the installed SDK source, not guessed):
`Sandbox.create('desktop', { apiKey, timeoutMs, metadata, lifecycle: { onTimeout: 'kill' } })`, then its
own view-only VNC launch through `sbx.commands.run(...)` (see below), then `kill()`.

**How view-only is enforced (server side, not by the page).** The stock `desktop` template only
*installs* x11vnc, noVNC and websockify. It starts none of them at boot (checked against
e2b-dev/desktop's template definition). The SDK's `stream.start()` launches them at runtime as
`x11vnc ... -shared -usepw`, with no `-viewonly`, and its `getUrl({ viewOnly: true })` only adds noVNC's
`view_only=true` page parameter. So this module never calls `stream.start()`. It launches x11vnc
itself over the same authenticated command channel:
`x11vnc -bg -forever -shared -wait 50 -display :0 -rfbport 5900 -viewonly -localhost -nosel -noremote -usepw`.
`-viewonly` makes x11vnc discard all pointer/key input from every client, `-nosel` turns off
clipboard exchange, and `-noremote` turns off x11vnc's remote-control commands. Then it reads back the
real process list (`ps -C x11vnc`) and **kills the sandbox** unless exactly one x11vnc is running and it
carries every one of those flags. Only then does it start noVNC on 6080. There is one stream, it is
view-only, and it is the only thing the public route or the viewer can get. There is no full-control
VNC listener: if an admin ever needs to drive a desktop, the server can do it through the SDK's
authenticated xdotool calls, never through a URL. A custom E2B template (`Template` builder,
`Template.build(..., { cpuCount, memoryMB })`) was not needed for this, because there is no VNC autostart
to override. It is still the next step for **cost**.

- **Proven 2026-10-05, real sandboxes, real input** (`RAMHERD_PROVE_VIEWONLY=yes node scripts/prove-viewonly.mjs`).
  This starts a sandbox through the production `createSandboxManager().start()`, then speaks raw RFB
  (RFB 3.8, VNC auth with the URL's password) over `wss://6080-<id>.e2b.app/websockify`:
  - Observers in the sandbox: a focused terminal running `cat > /tmp/keys.txt`, `xinput test-xi2 --root`
    and `xdotool getmouselocation`. Sanity check: local `xdotool` typing shows up in all three.
  - **Public (view-only) stream:** auth OK, connection stays open, and it accepts 4 PointerEvents (moves +
    a button-1 click) and 20 KeyEvents (`viewprobe` + Return). Result: pointer still `20,20`, nothing
    typed, **0 new raw X input events**.
  - **Positive control** (test-only, in the proof script, never in app code): the same client against a
    second x11vnc on the same desktop *without* `-viewonly`. Pointer moved to `640,400`, `ctrlprobe`
    typed, 28 raw X input events. This shows the client really delivers input when the server allows it.
  - Other doors: raw RFB port 5900 through E2B's proxy → HTTP 502. The sandbox's envd (command API)
    without its per-sandbox access token → HTTP 401 (E2B issued a token). Note: E2B forwards
    localhost ports onto the sandbox interface (5900 also listens on `169.254.x`), so `-localhost` is not
    the barrier here. `-viewonly` is, because it's the only VNC server on the desktop.
  - Two runs (the first one's verdict step was cut short by a cleanup bug in the script, but its
    measurements were identical): 27.4 s + 31.8 s at 8 vCPU / 8 GiB, about **$0.0088**. Each was killed,
    E2B then reported "not found", and 0 sandboxes were left running.
  - **End-to-end through the HTTP server** (same day): admin start → `GET /api/slots/slot-0/stream` gave
    only `{ sessionId, streamUrl, viewOnly: "server", expiresAt }` → the viewer's `loadDesk()` went
    idle → live → idle. E2B's noVNC page returned 200 with no X-Frame-Options or CSP, so it can be framed.
    5.7 s, about $0.0008.
- **Simulated:** the whole test suite (`tests/sandbox.test.js`, `tests/sandbox-viewer.test.js`) uses a fake
  SDK, so no test run ever creates a real sandbox. The fake records every command, so the tests check the
  real launch order, the flags, and the kill when the x11vnc process check fails.
- **Cost rails:** nothing is created unless an admin calls start. Every sandbox has an E2B-side hard
  timeout (it gets killed even if this server dies), there's a concurrency cap, retiring a slot kills
  its sandbox, and server shutdown kills them all.
- **The server learns when E2B ends a sandbox on its own.** Nothing tells this process when E2B's hard
  timeout kills a sandbox, so while any is live the manager asks E2B every `RAMHERD_SANDBOX_RECONCILE_SEC`
  (default 15 s) with `Sandbox.getInfo(id)`: once it answers "not found" (HTTP 404) or a state other than
  `running`, the slot goes to `sandbox.status: "expired"` with `endedBy: "timeout"` (its hard stop was
  reached: the normal end of a visible session) or `"provider"` (gone earlier), a `sandbox-expired` line
  lands in the feed, and the public stream route stops handing out the dead URL. An admin stop that finds
  the sandbox already gone records the same, never a stop that did not happen. Before 2026-10-05 a
  timeout-killed sandbox stayed "running" here forever. Proven that day on real sandboxes (a 1-minute hard
  stop): E2B ended it at 21:19:12.2, the server had it as expired/timeout at 21:19:13.3 without any call
  from an admin, `getInfo` independently threw `SandboxNotFoundError`, and the RAM's page read "ran its
  full time and closed" 8 s later.
- **Why there is no desk, said plainly.** A slot's `sandbox` field tells the cases apart (`null` never
  started; `starting`; `running`; `stopped` by this server; `expired` by E2B; `failed`, with the scrubbed
  error on the slot only, never on the stream route). `src/sandbox-viewer.js` (`deskWhy`) turns that into one
  line and badge per case, the same facts in the house voice: "No desk running" (never, the usual case),
  "Desk starting", "Desk session done" (stopped or ran its full time), "Desk session closed" (ended early on
  E2B's side), "Desk did not start" (a real failure, named, not dressed up). Demo pages have no slot record
  and keep the plain idle line.
- **Frontend viewer** (`src/sandbox-viewer.js`): every RAM's tile on the Herd page (`herd.html`) is a
  screen, and the RAM's full page (`herd.html#ram/<id>`) has the same screen larger. A screen embeds the RAM's desktop in a
  sandboxed iframe (`allow-scripts allow-same-origin` only, no-referrer, `pointer-events: none`, never
  focusable) only for a stream labelled `viewOnly: "server"` whose URL is
  `https://6080-<id>.e2b.app/vnc.html`; anything else reads as "no desk running": the intact pixel
  HASH block and the words NO DESK RUNNING, a calm idle state, not an error. Pages allow framing of
  `https://*.e2b.app` only (`frame-src`). **How a screen finds its stream without a single failed
  request:** at boot the page does one HEAD of itself and looks for that `frame-src` CSP, which only
  the API server sends (`deskFeedAvailable()`); a bare static server (`python3 -m http.server`) has no
  feed, so the screens idle and `/api/` is never asked. With the feed, one `GET /api/slots` per 10 s
  (`createDeskDirectory()`, always 200) says which slots exist and whose sandbox is `running`, and only
  those slots get a `GET /api/slots/:id/stream`. The iframe is only touched when the stream itself
  changes, so a poll never reloads a live desk. Until a RAM's own real feed gives it a `slotId`,
  this falls back to deriving one from its id: `ram-NN` maps to the server's `slot-(NN-1)`. Verified 2026-10-05 against the
  real server (no slots, sandboxes off): HEAD, then `/api/slots` at 0 s and 10 s, 0 console errors.
- **Not built yet:** running the RAM's real work inside the sandbox (the intended content is written up
  at the top of `sandbox.js`). The stream password is in the public URL, which is fine because it only
  grants watching.

| Env var | Default | Effect |
|---|---|---|
| `RAMHERD_SANDBOX=e2b` | off | enables sandboxes (also needs `E2B_API_KEY`); without it the SDK is never even imported |
| `RAMHERD_SANDBOX_TEMPLATE` | `desktop` | template name/id (a smaller custom template is the next cost step) |
| `RAMHERD_SANDBOX_TIMEOUT_MIN` | 15 | E2B-side hard kill timeout per sandbox (1 to 1440) |
| `RAMHERD_SANDBOX_MAX` | 6 | max concurrent sandboxes from this server (1 to 100) — roster only; a launched RAM's own (owned) sandbox is exempt from this count entirely (`server/lib/sandbox.js`'s `exempt` Set, set by `slots.js` for every `slot.kind === 'owned'`), so a real launch is never blocked by roster sandboxes already running. Still real E2B billing either way — exempt from the cap, not from cost |
| `RAMHERD_SANDBOX_RECONCILE_SEC` | 15 | how often, while any sandbox is live, to ask E2B whether each still runs (0 turns the check off) |
| `RAMHERD_SANDBOX_AUTORESTART` | unset (off) | `true` = when E2B's hard timeout ends an active roster RAM's sandbox, start a fresh one (workbench task + banner rerun; nothing carries over). Never for owned RAMs, admin-stopped sandboxes, or ones gone before their hard stop. Switch at runtime: `POST /api/admin/sandboxes/autorestart {"enabled": false}` |
| `RAMHERD_SANDBOX_AUTORESTART_BACKOFF_SEC` | 30 | wait before retrying a failed restart; doubles each retry, capped at 10 min |
| `RAMHERD_SANDBOX_AUTORESTART_MAX_FAILURES` | 5 | consecutive failed restarts for one RAM before it gives up (feed line says so) |
| `RAMHERD_SANDBOX_ACTIVE_LOOP` | unset (off) | `true` = after the workbench intro, a roster RAM's real research cycle (`advance()`) runs step after step for as long as its sandbox is up. Each step's feed line is typed into a Mousepad notes window; a running-experiment step also opens (or reuses) a terminal that looks at the RAM's own real cloned candidate files (`git log`, `ls`, `cat claim.json`/`proof.md`/`TASK.md`, cycled, so the desktop is not just the notes editor on repeat); when its model asks (`SEARCH:` line), at most every 2nd thinking step opens a real IACR ePrint search in Chrome and logs the real result titles. Each thinking prompt is grounded in the slot's own best REAL result so far this session (lowest `time_log2`, highest `success_probability` it has actually produced) and explicitly asked to try to beat it, honestly, not just cycle statuses (`updateBestResult`, `LOOP_THINKING_SYSTEM`). Never starts in mock mode or while the paid judge gate is open; stops with the sandbox. Each thinking step is a real billed model call (about $0.009 on anthropic/claude-opus-5.5, roughly 30 an hour per RAM). `server/lib/sandbox-activity.js`, proof `scripts/prove-active-loop.mjs` |
| `RAMHERD_SANDBOX_ACTIVE_LOOP_PAUSE_SEC` | 5 | pause between two steps (2 to 30; out of range falls back to 5). Keeps every RAM under 60 s idle unless a step is mid-call |
| `RAMHERD_SANDBOX_ACTIVE_LOOP_BROWSE_EVERY` | 2 | at most one literature search per this many thinking steps |
| `RAMHERD_SANDBOX_ACTIVE_LOOP_MAX_CALLS` | 60 | real thinking calls one sandbox session may make before the loop stops (feed line says so) |
| `RAMHERD_AUTO_SEED` | unset (off) | `true` = on boot (`server/index.js`, `server/lib/autoseed.js`), set the fee ledger's balance directly to the smallest total that funds the full roster (`ACTIVE_TRACKS.length` RAMs, capped by `RAMHERD_MAX_SLOTS`) and reallocate, before the server listens; then, if sandboxes are on, start one per active roster slot in the background. Same calls as `POST /api/admin/fees` + `/reallocate` + `/slots/:id/sandbox/start`. Roster only, never lowers a higher fee total, a failed start is logged + on that slot's feed and the rest continue. Every sandbox bills. Proven 2026-10-05 on a real local server with real E2B |

Admin routes (`x-admin-token`): `POST /api/admin/slots/:id/sandbox/start`, `POST /api/admin/slots/:id/sandbox/stop`,
`GET /api/admin/slots/:id/sandbox` (stream URL plus session details).
Public route: `GET /api/slots/:id/stream` → `{ enabled, stream: null | { sessionId, streamUrl, viewOnly: "server", expiresAt }, sandbox: null | { status, endedBy } }`
(`sandbox` says why there is no desk: see "Why there is no desk" above).

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

The site is six static pages sharing one top bar, one stylesheet and one data layer. Each
page has its own small bootstrap script that calls into the shared modules for just what that
page needs; nothing is a long scroll, and the only in-page route is a RAM's page over the
Herd.

```
src/
  index.html + index.js    the banner page: hook, pills, the brand plate, the printed fund
                           lines, then the listing (one line per page, with the herd's live
                           counts on the Herd line)
  herd.html + herd.js      the Herd, live: one screen per RAM (the board), the key, and the
                           RAM page shell that herd.html#ram/<id> fills, over the board
  herder.html + herder.js  the Herder's panel: summary, the herd by status, one line per RAM
                           (each linking to herd.html#ram/<id>), the chat
  submit.html + submit.js  the idea slip and the human-review notice
  rules.html + rules.js    what this can and can't claim (nothing dynamic but the menu)
  launch.html + launch.js + launch.css + launchpad-rules.js   the entry slip (not live)
  discover.html + discover.js + discover-view.js   every actually-launched RAM's token,
                           browsable with no id needed: image, name, symbol, hash family and
                           round, model, a link to its own herd.html#ram/<id> page, and its
                           real pump.fun link once a mint is on record

  nav.js            the top bar's menu toggle, called by every page
  ui.js             the listing's primitives: status words, pixel glyphs, the judge's column,
                    the print (the one motion), the diffing writers, herd-counts, RAM hrefs
  fund-lines.js     the fund lines and block bars (index)
  board.js          the tiles, diffed by id on every tick; the shared desk feed (one probe,
                    one slot directory, one poll for every screen on the page) (herd)
  ram-page.js       the #ram/<id> route: facts, history, the larger screen; Escape / Back
                    restore scroll and focus (herd)
  herder-panel.js   the Herder's summary, counts, lines and chat (herder)
  idea-slip.js      the idea form (submit)
  sandbox-viewer.js a RAM's screen: embeds its server-side view-only E2B stream, or "no desk
                    running"; the feed probe and the slot directory that keep it request-clean
  mock-data.js      <- real-backend auto-detection + in-browser fallback, see below
  styles.css        all styling — black screen, white pixel ink on a 4px unit, one amber for
                    what is live, inverse video for the judge; tokens in :root (see DESIGN.md)
  brand/            ram-smashing-hash-main.png (the operator's pixel ram, source of truth),
                    ram-hero.png (its transparent 1-bit crop, the banner plate), ram-mark.png (40px)
  fonts/            jersey10.woff2 (display), silkscreen.woff2 (labels), archivo-variable.woff2 (reading)
  favicon.png / favicon.svg
```

The nav is the same markup on every page (The Herd / The Herder / Ideas / What counts, then
X / GitHub / HashSmash and the "Enter a RAM" pill; the current page's link is in full ink via
`aria-current="page"`). The Herd and the Herder are separate pages on purpose: neither has to
be scrolled past to reach the other. A RAM's page stays a hash route on the Herd page
(`herd.html#ram/<id>`) rather than a seventh file, because it opens over the board, which
keeps ticking underneath, and closing it restores the board's scroll position and focus;
the Herder's per-RAM lines deep-link to it.

## Frontend data: fallback and real-backend auto-detection

`src/mock-data.js` is the **only** file that decides whether a page's data comes from the real
backend or from its own in-browser fallback. Every render in the page modules (`fund-lines.js`,
`board.js`, `ram-page.js`, `herder-panel.js`, `idea-slip.js`, `launch.js`) calls through the
`RAMherdAPI` object exported from that file — `getStats()`, `getFleet()`, `getRamDetail(id)`
(a RAM plus its whole history, for its page), `getHerderSummary()` (the Herder's one-paragraph
summary of the herd), `getChatSeed()`, `askCoordinator(question)`, `submitIdea(payload)`,
`subscribeLive(onTick)`, and (`RAMherdAPI.launchpad`) `getConfig()`, `uploadImage(file)`,
`createRam(draft)`, `buildTransaction(id, mint)`. Nothing else in the frontend fetches anything
directly.

Every one of those methods already auto-detects the real backend (`backendReady`, from
`deskFeedAvailable()` in `sandbox-viewer.js`: one HEAD of the page itself, checking for the API
server's distinguishing `frame-src` CSP header) and fetches it same-origin when it's there —
there's no manual step left to wire one up. A page only ever falls back to the in-browser state
below when that HEAD comes back without the header: this page served by a bare static file
server (`python3 -m http.server`), or the real server genuinely unreachable. The desk streams
are the one exception by design: they're never on the fallback path, `sandbox-viewer.js` only
ever asks the same-origin API server directly (see "E2B desktop sandboxes").

Nothing in the pages, `styles.css`, or the page modules needs to change for any of this.

## What the in-browser fallback shows, when no backend answers

- Fees collected, compute budget/spend, and active-slot counts — a small live-drifting
  in-memory state (`tickMockState`), not real pump.fun data. When the real backend answers,
  `getStats()` reports the real ledger/allocation/slots instead.
- The 6-RAM herd on `herd.html`: the launch roster, one RAM per real HashSmash track
  (`sha256-r31`, `sha256-r32`, `sha3-256-r5`, `sha3-256-r6`, `blake3-r1`, `blake3-r2`, matching
  `reference/hash-smash/tracks/` and `reference/hash-smash/lanes/exploratory/candidates/`),
  each tile showing that RAM's real assigned OpenRouter model (same slugs as
  `server/lib/targets.js`), with invented but specific per-agent activity text and, on its
  page, an invented but specific history (4–5 earlier lines each, newest first). A tile is
  Screen / Entrant / Round / Now / Judge; a status is exactly "Running an experiment",
  "Thinking", "Idle" or "Submitted". The Judge column is HashSmash's side: a submitted candidate reads
  "in review" (their "In review — Awaiting manual review" intake state; nothing from the herd
  has been accepted, and on the real site every submission on these tracks is in review) and
  carries a `log2T` score field, HashSmash's log₂(T) (total charged computation, lower is
  better), null and shown as an em dash until their judge scores it, which today is every row.
  When the real backend answers, `getFleet()` shows the real roster from `GET /api/slots`
  instead: each RAM's actual feed activity (never invented), and the same honest `judge: null` /
  `log2T: null` either way, since nothing automated here has reached HashSmash's real review
  queue yet.
- The Herder's summary paragraph and its chat — seeded here with 5 realistic Q&A pairs plus
  keyword-matched replies for anything else typed in. When the real backend answers, this
  already routes to a real model call instead (`POST /api/coordinator/ask`, a real LLM call
  when `RAMHERD_LIVE=true`).
- Every RAM's screen reads "no desk running": true either way today, because nothing yet runs
  inside a sandbox — that line is the real status, not this fallback; see "E2B desktop
  sandboxes" for what makes a screen come alive.
- Idea submission — here, client-side only; "submitting" increments a placeholder
  queue-position counter. When the real backend answers, this already posts to its real
  human-review queue instead (`POST /api/ideas`).

## Design notes

Three visual passes so far. Each was built through Impeccable's actual process
(`.claude/skills/impeccable/`: `context` → `new-work.md`'s direction roll → `craft-floor.md` →
`detect` → a finish review → the documenter), not by eye, and each left its artifacts behind:

- `PRODUCT.md` — product truth from `/impeccable init` (background run, inferred lines marked).
- `.impeccable/surfaces/src-index-html.md` — the surface brief with the six-block direction
  contract (THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM / FINISH) for the current pass.
- `DESIGN.md` + `.impeccable/design.json` — the token-bearing design system, written from the
  built page by the documenter at finish.

**The third pass (2026-10-05): the pixel listing.** The operator said the second pass "isn't what
I envision" and gave five reference sites (chordpf.com, nearos.io, trykyoto.ai, dexora.tech,
homefi.space; screenshotted, not just read) whose common thread is a near-black ground, oversized
bold sans headline type, pill buttons (one filled, one ghost), a small mark with a minimal centred
nav, lots of negative space and a subtle accent glow. Then he supplied a real brand asset,
`src/brand/ram-smashing-hash-main.png` (a pixel-art ram charging a HASH block, binary digits
scattering off it), and pinned the whole site's look to that style: monochrome, pixel-art, the
scattering-digits motif recurring; the references now supply structure only. That pins the
materials. Impeccable's direction roll (`concept-seed`, seed key `cbda8d1b`, mode Persuade)
assigned candidate 7 of a seven-item list drawn from the audience's world (arcade high-score
table, virtual-pet LCD, cracktro, handheld-RPG party roster, BBS door game, 1-bit desktop,
dot-matrix tournament printout); a brief-pinned world beats the roll, so the printout donated
only its topology and ritual, translated into the pinned materials. The result is **a
line-printer listing on a black screen**: a banner page in giant pixel letters, then one appended
line per thing that happened, every line permanent. Pure black (the asset's own black, so the
plate sits on it with no seam), white 1-bit ink on a 4px pixel unit that governs every border,
stepped corner, glyph and the dither, one amber reserved for what is live (a running RAM's
glyph, a live stream's frame, the Herder's live dot), inverse video (white block, black text)
for HashSmash's review state instead of a colour. The glow the references share is executed as
an ordered dither (three concentric rings of amber pixels behind the burst, no smooth gradient).
Three faces with fixed jobs, all self-hosted: Jersey 10 (display: banner, section heads, RAM
ids, fund figures), Silkscreen (labels: nav, pills, status words, stamps; it is caps-only, so
identifiers such as model slugs and lane paths are never set in it), Archivo (reading). Pills
are pixel pills (stair-stepped 24px corners cut with `clip-path`), frames are 1-unit rules with
notched corners, status is a pixel glyph plus a word plus a clock, and the asset's digit spray
is the rule that opens every part of the page. The dealt challengers each donated one
discipline, recorded in the brief's FORM block (one grid unit for all geometry; append-only
lines; every pixel load-bearing; the budget meter as a block bar in RAM-slot units; one named
transformation, tile to page; the single accent marks only what is live). The one motion is
"the print": a changed line appears left to right in `steps()`, the running glyph blinks
between two pixel frames; nothing fades or slides, and under reduced motion changes simply
appear.

**What the pass added, functionally.** Every RAM tile is a screen (the view-only desk stream
when one runs; the intact HASH block and NO DESK RUNNING otherwise), clicking a screen opens
the RAM's full page at `#ram/<id>` (its screen larger, its facts, its whole history, newest
first; Escape or the back pill returns to the board with scroll and focus restored), and the
Herder has a full-width panel, visibly bigger than any tile (1104×644 against 347×450 at
1440), with its summary, the herd by status, one line per RAM and the chat. The sandbox
discipline is unchanged and request-clean; see "E2B desktop sandboxes".

**The pages (2026-10-05, same day).** The operator wanted real pages instead of one long
scroll, so the single page was split without touching the visual system: `index.html` keeps the
banner and gains the listing (one printed line per page, the Herd's line carrying the live
counts); the board became `herd.html` under the heading "The Herd, live" (renamed from "The
board, live"); the Herder's panel became `herder.html`, so neither it nor the board has to be
scrolled past to reach the other; the slip is `submit.html` and the rules are `rules.html`. The
one script became shared modules (`ui.js`, `nav.js`, `fund-lines.js`, `board.js`,
`ram-page.js`, `herder-panel.js`, `idea-slip.js`) with a few-line bootstrap per page, and the
entry slip's duplicated menu code now calls the same `nav.js`. A RAM's page is still the hash
route, now `herd.html#ram/<id>`; the sandbox viewer and its view-only discipline were not
touched. The operator also found the site too narrow and tall, so the same change widens the
framing without changing the language: the column is 1440px (was 1200), and above 1000px every
row that can be a column of a wider row is one (the banner's copy beside the plate, the three
fund lines across one row, the four listing entries across one row, each section's heading
beside its lead); above 1200px a tile lays its screen beside its printed lines in two columns,
so six RAMs are three short rows instead of two tall ones, and a RAM's page puts its facts
beside its screen. The narrow layouts are unchanged. `impeccable detect` over the eight page
and style files: 0 findings, 0 advisories. In
browser mode at 1440 and 390 it flagged the Herder's lines truncating with an ellipsis (they now
wrap; nothing is hidden) and read the Herder's blinking live dot, now in the first viewport of
its own page, as a decorative typing-cursor effect; that rule is scoped off for `herder.html` only in
`.impeccable/config.json` (two globs: `src/herder.html` for file scans and `**/herder.html` for
browser-mode scans, which see the page by URL path), because the dot is the design system's
one live marker (DESIGN.md, "Live Amber"), not a cursor. After that: 0 anti-patterns in
browser mode at 1440 and 390. Its remaining advisory is em-dash density on the Herd page, which
comes from the fallback's per-agent activity text and the judge column's em-dash placeholders, both
deliberate. Verified on a static server at 4712 with Playwright's headless Chromium at 1440,
1024 and 390: all six pages load, every nav, pill, listing and foot link resolves, no console
errors, no horizontal scroll anywhere (the RAM page included), the mobile menu opens inside the
viewport on every page, the fund lines and listing counts fill, the Herder prints six lines and
its seeded chat, the slip hands in, `herd.html#ram/<id>` opens from a tile (focus to the id),
closes on Escape with focus back on the tile, and opens from a fresh deep link. The one
`requestfailed` Playwright reports is the page's own HEAD probe under `python3 -m http.server`
(a body-less HEAD that Chromium books as aborted), identical on the pre-split page, with no
console message either way.

**What `detect` found and what was fixed.** `impeccable detect` over the six changed files,
first run (against the second pass's DESIGN.md): 0 anti-patterns, 29 advisories, all
design-system drift against the felt palette and the old type ramp, which this pass replaces; the
type ramp was collapsed to 0.75 / 0.85 / 0.95 / 1 rem reading and 1.25 / 1.5 / 1.75 / 2 rem
display plus the fluid banner sizes, and the one stray literal became a token (`--ink-press`).
Second run, after the new DESIGN.md: 7 anti-patterns + 2 advisories. The ghost pill read as
white-on-white to the static reader (its black face is a pseudo-element; bisected to the hover
rule, which now sets the face and the word together), the entry slip's two question labels were
uppercase at 38–40 characters (they are sentences, so they moved to the reading voice), the
RAM page's bar had no inset, and the Herder's summary and the slip's part headings sat off the
recorded ramp. **Final: 0 findings, 0 advisories.**

**Finish review.** A fresh reviewer agent (Impeccable's finish-reviewer brief, run as a
general-purpose agent because this harness doesn't expose it by name) returned **fix** with four
material items: the mobile menu clipped the "Enter a RAM" pill; the 1440 first viewport showed
neither the ram nor a fund line (the real cause was the inline `<svg hidden>` sprite rendering as
a 300×150 box, since `hidden` is an HTML attribute the UA sheet never applies to SVG, plus a
headline and plate too tall for a 900px fold); the RAM page at 390 drew the caption over the idle
HASH block; and ram-03, the one RAM with a candidate in review, was dimmed as stale. All four
were fixed and scored **resolved → ship** on the verdict pass. Its minor notes were taken too
(log frame edge, uniform tile heads, the block's faces made opaque so the dither never shows
through, 0/1 glyphs as the board's texture, nav order matched to page order, OFL texts for the
two pixel faces). Captures live in `.impeccable/review/` (gitignored).

**Verified.** Served `src/` statically on 4711 and through the real API server on 4713;
Playwright's headless Chromium at 1440 and 390: no console errors on either server, no
horizontal scroll at either width, the idle screens read as intended, `#ram/<id>` opens and
closes correctly (focus to the banner, Escape closes, scroll restored), the mobile menu opens
anchored to the header. Captures live in `.impeccable/review/` (gitignored).

**The second pass (the tournament wallchart), for the record.** Light paper on bottle-green
felt, three inks, Archivo's width axis doing the work of two families, one red for the judge,
"the pen writes" as the one motion; seed key `4c815091`. Its detect and finish-review history
is in the git log (commit `e5c38d1` and before). It was not wrong, it was not what the
operator envisioned; the old look was treated as evidence of the subject, not as authority
over what it became.

Still true from every pass: no system display face, no emoji-as-icons, no gradient text, no
kicker labels, no coloured card borders, no cards.

---

Built with help from Claude and OpenRouter. Cryptanalysis target and research framing from
[Zooko](https://x.com/zooko) and [Yukon](https://www.yukon.org/).
