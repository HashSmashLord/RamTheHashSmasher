# HashSmash technical brief

Research pass over `reference/hash-smash/` (clone of `mooselumph/hash-smash`), done
2026-10-05. Every claim below cites the exact file/section it comes from. Anything
the docs don't state is marked "unclear from the docs, needs asking the HashSmash
org" rather than guessed. This feeds `docs/PRD.md`.

---

## 1. Exact submission mechanics

### 1.1 Repository contract

A solver may edit **only** its assigned `lanes/<lane>/candidates/<target>/`
directory (`<lane>` is `exploratory` or `rigorous`, `<target>` e.g. `sha256-r31`).
Everything else — target profiles, cost models, schemas, judge prompts, verifier
code, workflows, generated outputs — is organizer-owned and protected
(`README.md` "Repository contract"; `TASK.md` "Select the assigned contract";
`AGENTS.md`).

A candidate package is three required pieces plus two optional ones, all inside
that one directory:

```
lanes/<lane>/candidates/<target>/
  claim.json                      # required — the strict JSON claim (schema below)
  proof.md                        # required — the markdown argument
  certificates/manifest.json      # optional, but required if claim declares certificate_manifest
  certificates/<files>            # optional witness message files the manifest points at
  experiments/manifest.json       # optional, but required if claim declares experiment_manifest
  experiments/<basename>.py       # optional — single flat .py files only, no subdirs/symlinks
```

This exact layout is enforced mechanically by `verifier/intake.py::_scan_candidate`
and `validate_candidate`: only `claim.json`, `proof.md`, and the two allowed
subdirectories `certificates/` and `experiments/` are permitted at the root; any
other file or subdirectory fails intake (`verifier/intake.py` lines 35-71). Files
must be regular files (no symlinks, no executable bit, no nested directories
inside `certificates/`/`experiments/`) — `verifier/intake.py` lines 42-70, 75-76.
Size limits are enforced per file type (`claim.json`, `proof.md`,
`certificates/manifest.json` each have their own byte caps; everything else uses
`MAX_CERTIFICATE_FILE_BYTES`) plus a total-package cap (`MAX_TOTAL_BYTES`,
`verifier/intake.py` line 157-159) and a Yukon-side 4,194,304-byte submission cap
per track (`docs/YUKON_DEV_SETUP.md` line 32, confirmed per-track in
`benchmark.json` `maxSubmissionBytes`).

### 1.2 The CLI commands a solver actually runs

From the repository root (`README.md` "Builder setup and local workflow",
`TASK.md`):

```sh
# one-time deterministic setup (no network, no credentials)
bash .yukon/setup.sh                                    # runs verifier/judge/tests unit suites

# inspect/validate without touching AI or the organizer judge
python3 scripts/local_tracks.py list                     # all local lanes
python3 scripts/local_tracks.py catalog                  # planned slots incl. deferred ones
python3 scripts/local_tracks.py show   sha256-r31-exploratory   # trusted profile+cost+reference
python3 scripts/local_tracks.py check  sha256-r31-exploratory   # mechanical validation only
python3 scripts/local_tracks.py status sha256-r31-exploratory   # best archived AI-reviewed score

# the actual pipeline (organizer-owned, deterministic + credentialed stages)
python3 scripts/hashsmash_pipeline.py intake --track sha256-r31-exploratory   # credential-free
python3 scripts/hashsmash_pipeline.py judge  --track sha256-r31-exploratory   # needs provider key
python3 scripts/hashsmash_pipeline.py score  --track sha256-r31-exploratory   # credential-free
python3 scripts/hashsmash_pipeline.py all    --track sha256-r31-exploratory   # all three in order

# convenience wrapper that runs check -> setup -> loads .env -> pipeline all
bash scripts/run-local-track.sh sha256-r31-exploratory
```

Every pipeline/verifier invocation takes an **explicit** `--track <target>-<lane>`
— there is no default track (`README.md` "Repository contract";
`scripts/hashsmash_pipeline.py` `_parse_args`, `--track required=True`).

Stage behavior, from `scripts/hashsmash_pipeline.py`:
- `run_intake`: wipes previously generated outputs for that track
  (`_remove_known_outputs`), calls `validate_candidate` then
  `verify_certificates`, runs any declared experiments through the sandboxed
  executor (`execute_experiments`, skipped if this exact package was already
  scored by a reorg source — `rescore.find_source`), then builds and writes
  `judge-evidence.json`. Exits `2` and prints `draft_not_submitted` if
  `submission_state` is `draft` — **a draft never reaches judge/score**
  (lines 141-166).
- `run_judge`: re-validates that the stored evidence still matches a fresh
  re-intake of the exact candidate (`_check_current_evidence`, line 229-236) —
  this is the "clean re-run" gate, see §4. Picks provider from
  `HASHSMASH_JUDGE_PROVIDER` (openrouter default, or bedrock), runs
  `run_paired_review`, writes `judge-dossier.json` and `aggregate.json`. Returns
  `0` only on `plausible_not_refuted` / `ai_rigor_qualified`; `2` on other
  resolved outcomes; `3` on infra failure (lines 239-309).
- `run_score`: re-checks every fingerprint (package/claim/evidence/dossier/config
  hashes) agrees before calling `verifier/score.py::build_score` to emit the
  final score JSON (lines 312-355).

Score output path: `lanes/<lane>/.yukon/scores/<target>-<lane>.json`. Reports/dossier:
`lanes/<lane>/.yukon/reports/tracks/<target>-<lane>/`. Both are git-ignored
(`README.md` "Repository contract"; `docs/YUKON_DEV_SETUP.md` table).

### 1.3 The exact claim JSON schema

`schemas/claim-frontier-v3.schema.json`, `additionalProperties: false`, required
top-level fields: `schema_version` (const `3`), `target_profile` (enum of the 12
concrete `<target>-prefix-v1` IDs — see §1.5), `attack_class` (const
`"ordinary-collision"`), `rounds` (integer 1-80), `claim` (object, see below),
`restrictions` (array of up to 64 free-text strings, 1-1024 chars each),
`baseline_improved` (string, 1-256 chars — a **required reference identifier,
not an improvement assertion**, per `docs/JUDGE_LANES.md` lines 23-31),
`submission_state` (enum `draft`|`ready`), `lane` (enum `exploratory`|`rigorous`),
`heuristics` (array, up to 32 entries).

`claim` object, required: `time_log2` (number >= 0), `time_unit` (const
`"target-compressions"`), `memory_log2_bytes` (number >= 0), `preprocessing_log2`
(number >= 0), `success_probability` (number, **minimum 0.39**, max 1),
`nonuniform_advice_log2_bytes` (number >= 0). Optional: `data_log2` — explicitly
legacy, unreviewed, and should be omitted on new claims
(`docs/OPTIONAL_DATA_METRIC.md`).

Each `heuristics[]` entry requires: `id` (pattern
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`), `statement` (<=4096 chars), `role` (enum
`score-critical`|`supporting`), `scope`, `extrapolation`, `limitations` (each
<=4096 chars), and `evidence_ids` (1-32 entries, each matching
`^(experiment:[id]|proof:<line>(-<line>)?)$`). Intake mechanically checks every
`evidence_ids` reference resolves: `experiment:<id>` must exist in the declared
experiment manifest, `proof:<n>-<m>` must be within the proof's actual line count
(`verifier/intake.py` lines 212-221). An unresolved/unknown reference fails
intake before any AI review runs.

`certificate_manifest` (if present) must be exactly the string
`"certificates/manifest.json"`; `experiment_manifest` (if present) must be exactly
`"experiments/manifest.json"` — these are consts, not free paths.

Certificate manifest schema (`schemas/certificate-manifest-local-v2.schema.json`):
`schema_version: 2`, `certificates[]` (max 16) each with `id`, `type` (const
`"hash-collision-witness-v2"`), `message_a`/`message_b` (paths under
`certificates/`, not the manifest itself), `expected_digest` (hex, 32/40/64 chars
= MD5/SHA-1/256-bit), `target_profile` (enum of 9 concrete profile IDs). An
**empty manifest is valid and expected when no certificates are supplied**
(`TASK.md` "Prepare a reviewable package").

Experiment manifest format and the three supported experiment kinds
(`addition-xor-exact-v1`, `addition-xor-sampled-v1`, `python-message-pairs-v1`)
are defined in `docs/HEURISTIC_EXPERIMENTS.md` "Supported experiments" and
"Candidate format" — see §4 below for the sandbox.

### 1.4 What `proof.md` actually needs to contain

Not separately schema'd (it's markdown, line-numbered by the verifier for
`proof:<line>` citations — `verifier/intake.py::_number_proof`), but
`CANDIDATE_QUALIFICATION.md` "What must replace each scaffold" and `TASK.md`
"Prepare a reviewable package" specify the substantive content obligations:

1. A concrete algorithm: exact messages, complete hash computation (not
   compression-only / free-start / truncated-output / different-round — these
   are explicitly rejected substitutes), data structures, stopping rule,
   collision check, success event.
2. Justified resource bounds matching every `claim.json` number, charged under
   the cost model (see §3): preprocessing, all trials including failures,
   randomness, sorting/lookups, verification, restarts. Peak memory must include
   code, advice, retained messages, tables, working state.
3. A success-probability argument >= 0.39, distinguishing "same input twice" from
   "collision of distinct inputs," accounting for restart/amplification cost.
4. Every heuristic's role/scope/evidence/limitations explicitly disclosed and
   resolvable to `proof:<line>` or `experiment:<id>`.
5. Consistent certificate/experiment declarations (valid-even-if-empty
   certificate manifest; experiments only when they actually support the claim).

The judge **does not fetch external links** — `TASK.md`: "include the
mathematical support needed to assess your claim." A proof that just cites a
paper without reproducing its argument fails this bar. The real `sha256-r31`
baseline (`lanes/exploratory/candidates/sha256-r31/proof.md`) is the model to
imitate: it reproduces the published differential characteristic, the exact
two 128-byte witness messages, a step-by-step preprocessing/matching/stopping
procedure, and a full byte-level codec proof for its table representation —
nothing is "trust the paper."

### 1.5 The 12 concrete target profiles (active + local-only)

From `schemas/claim-frontier-v3.schema.json` enum / `target-profiles/*.json`:
`md5-s63-prefix-v1`, `md5-s64-prefix-v1`, `sha1-r79-prefix-v1`,
`sha1-r80-prefix-v1`, `sha256-r31-prefix-v1`, `sha256-r32-prefix-v1`,
`sha3-256-r5-prefix-v1`, `sha3-256-r6-prefix-v1`, `blake3-r1-prefix-v1`,
`blake3-r2-prefix-v1`, `keccak800-r5-prefix-v1`, `keccak800-r6-prefix-v1`.
Each profile JSON (e.g. `target-profiles/sha256-r31-prefix-v1.json`) pins exact
IV, round-index range, padding, feed-forward, digest encoding, and lists
`out_of_scope` variants (compression-only/free-start, near-collision/truncation,
IV/padding/round-range changes, side-channel). Note only 9 of these 12 profiles
are accepted by the certificate-manifest schema (`md5-s8-prefix-v1` is also
listed there for a test fixture, not a real track; see §4 participant-heuristic
test).

### 1.6 What intake, judge review, and the scoring gate each check

| Stage | Credentials | Checks |
| --- | --- | --- |
| **Intake** (`validate_candidate` + `verify_certificates`, then declared experiments) | None — fully deterministic, no network | Filesystem shape, file-type/size/symlink/executable rules, strict JSON-schema validation of `claim.json` and (if present) `certificates/manifest.json` and `experiments/manifest.json`, cross-reference of every heuristic's `evidence_ids` against actual proof line count / declared experiment IDs, total-package byte cap, and (if declared) execution of Python experiments in the sandboxed Docker executor. Produces `package_sha256` over every file's path+size+sha256. Rejects immediately if `submission_state == draft` (never proceeds to judge/score) — `TASK.md`, `hashsmash_pipeline.py::run_intake`. |
| **Judge review** (`run_paired_review`) | Needs `OPENROUTER_API_KEY` or `AWS_BEARER_TOKEN_BEDROCK` | Re-validates the candidate is still exactly the one that produced the stored evidence (`_check_current_evidence`) before spending any model calls. Four independent roles (evaluability, cryptanalysis, cost, experiments) review the same immutable evidence; a cited fatal finding triggers a defender then an adjudicator (`docs/JUDGE_LANES.md` "Review sequence"). Produces `plausible_not_refuted` / `ai_rigor_qualified` / `refuted` / `not_evaluable` / `not_qualified` / `infra_failed` (table in `docs/JUDGE_LANES.md` and `judge/README.md`). |
| **Scoring gate** (`build_score`) | None — deterministic | Re-verifies every binding hash (package/claim/evidence/dossier/judge-config) matches before computing the scalar; only a lane that produced `plausible_not_refuted` (exploratory) or `ai_rigor_qualified` (rigorous) emits a score at all (`verifier/score.py` via `hashsmash_pipeline.py::run_score`). "Failed validation or qualification emits no score" — `README.md`. |

---

## 2. What's realistic for an AI agent to actually attempt

### 2.1 What's actually happening in this repo right now, per target

The **active Yukon manifest** (`benchmark.json`, confirmed by `README.md`,
`TASK.md`, `docs/FRONTIER_LANES.md`, `docs/YUKON_DEV_SETUP.md`) has exactly
**six exploratory tracks, zero rigorous tracks, zero Poseidon tracks**:

- `sha256-r31-exploratory`, `sha256-r32-exploratory`
- `sha3-256-r5-exploratory`, `sha3-256-r6-exploratory`
- `blake3-r1-exploratory`, `blake3-r2-exploratory`

Rigorous lanes for all of these, plus MD5/SHA-1/Keccak[800] exploratory+rigorous
lanes, exist as **local-only research lanes** (24 runnable candidate directories
total, per `docs/README.md`, `docs/BUILDER_GUIDE.md`) but are **not** imported
into Yukon — `docs/YUKON_DEV_SETUP.md` "Reconcile the existing challenge" lists
them as archived/retired from the live challenge.

**Poseidon is explicitly not open.** Two Poseidon exploratory slots are reserved
but deferred pending exact field/width/mode/constants/round-schedule definition
(`README.md`: "Two Poseidon targets remain deferred until their parameters and
round pair are defined"; `docs/FRONTIER_LANES.md` roster table: "Not yet
assigned... 4 reserved"; `docs/FRONTIER_RESEARCH.md` "Poseidon: Unresolved").
There is no Poseidon target profile, no Poseidon cost-model reference price, and
the schema's `target_profile` enum has no Poseidon entries at all. An agent
cannot submit a Poseidon claim today — there is nothing to submit against.

**Candidate-directory activity (what currently exists, read directly from the
candidate packages, not just the docs):**

| Target lane | Content quality | What it actually is |
| --- | --- | --- |
| `sha256-r31-exploratory` | Real literature replication | Reproduces Li/Liu/Wang/Dong/Sun ASIACRYPT 2024 (31-step practical collision), with the full differential characteristic, exact witness messages, and a from-scratch codec/memory proof. Score (old v3 model) 66.25. |
| `sha256-r32-exploratory` | Real literature adaptation, marked `READY FOR REVIEW` | Adapts a 2026 eprint (Li/Liu/Wang/Shi) 35-step construction down to the 32-round target; explicitly states "No complete standard-IV r32 collision was computed" and discloses two exploratory heuristics bounding success probability (0.9) and cost (time 86, memory 39). |
| `sha3-256-r5-exploratory` | Generic, not a real attack | A distribution-free generic birthday/radix-sort upper bound (`heuristics: []` — empty). Score 129, **worse** than the 128 nominal reference. Exploits no SHA3-256 structure at all. |
| `sha3-256-r6-exploratory` | Generic, not a real attack | Same generic birthday construction, tuned sample count. Score 128.08, also not an improvement over nominal 128. |
| `blake3-r1-exploratory` | **The one genuinely novel structural attack in the repo** | Exploits BLAKE3's round-1 column independence: the 256-bit digest splits into two independent 128-bit halves, each a 4-sum (Wagner generalized-birthday) problem solvable in ~2^44 instead of 2^64/2^128 generic. Declares one score-critical heuristic (`H1`) with experimental support. Score 48 — a real, structural improvement over the generic bound. |
| `blake3-r2-exploratory` | Generic, not a real attack | Same generic birthday construction as sha3/keccak, just re-priced under blake3-r2's C=430. Score 140. |
| `keccak800-r5/r6` (local only, not in Yukon) | Generic, not a real attack | Same generic birthday pattern. Score 149 for both — these are the organizer's own placeholder baselines per `docs/NEW_LANE_BASELINES.md`. |

Takeaway: of the six **live** tracks, only `sha256-r31` and `blake3-r1` currently
have anything resembling real cryptanalysis behind them; `sha256-r32` is a
partially-worked literature adaptation; `sha3-256-r5/r6` and `blake3-r2` are
generic birthday scaffolds that don't even beat the nominal reference and exist
mainly as mechanically-valid placeholders.

### 2.2 Legitimate approaches that fit the exploratory track

These are things a solver (human or AI) can genuinely do and get a real,
non-garbage review outcome:

1. **Literature-informed attack replication/adaptation** (what `sha256-r31` and
   `sha256-r32` already do). Take a published reduced-round differential or
   boomerang attack, reproduce its characteristic and witness in full (the judge
   doesn't fetch links — you must re-derive it in `proof.md`), and precisely
   translate its reported complexity into this repo's `collision-frontier-v5`
   word-RAM unit accounting (§3). This is the highest-value, most tractable
   approach for an LLM agent: it's reading comprehension + careful bookkeeping,
   not new mathematics.
2. **Structural/algebraic shortcuts specific to a target's round function**
   (what `blake3-r1` does): find dependency structure in the reduced-round
   function (e.g., independent output halves, linear/near-linear substructure
   in the first round) that turns a generic birthday search into a cheaper
   generalized-birthday (Wagner) or meet-in-the-middle problem. This is real,
   substantive cryptanalysis, and it's exactly the kind of thing worth having
   an agent search for on round-1/round-2 reduced targets, which are the
   shallowest and most tractable.
3. **SAT/SMT-based differential or preimage search** on the reduced-round
   target (explicitly anticipated by the harness: `proof.md` section 10 of
   `sha256-r31` says "A practical implementation may use equivalent carry-aware
   or SAT/SMT enumeration" and the harness's `addition-xor-exact-v1`/
   `addition-xor-sampled-v1` experiment kinds exist specifically to let a
   submission mechanically substantiate local differential-probability claims
   (`docs/HEURISTIC_EXPERIMENTS.md`). Finding a genuinely better characteristic
   for `sha256-r32`, `sha3-256-r6`, or `blake3-r2` via automated search and then
   writing up the resulting algorithm is realistic and would actually improve
   on the current placeholder scores.
4. **Cost-model / implementation-efficiency improvements on an already-correct
   algorithm**: tightening the `time_log2`/`memory_log2_bytes` bound of an
   *existing* qualified construction by a better data-structure choice (the
   `sha256-r31` package's whole §9 codec-compression argument is exactly this:
   repacking a 10-word table record into one 32-byte aligned word to shave
   memory). This is low-risk, well-scoped, and directly scoreable since the
   underlying collision relation is unchanged — only resource accounting
   changes, and reviewers specifically look for exactly this kind of tightening
   (`docs/RESCORING.md` "Submitted scores").
5. **Formal-verification-flavored argument tightening**: the judge committee
   includes a `formal-proof-v1` strategy role explicitly doing "theorem, lemma
   and dependency checking" (`judge/README.md`) — a submission that is unusually
   rigorous about its probability/injectivity argument (again, modeled on
   `sha256-r31` §9's injectivity proof) scores better on the cryptanalysis and
   evaluability roles even without a new attack, and is the most plausible path
   to `ai_rigor_qualified` rather than merely `plausible_not_refuted`.
6. **Novel search heuristics for differential trails** on the already-selected
   shallow targets (`sha3-256-r6`, `keccak800-r6`, `blake3-r2`) — these currently
   only have the generic birthday fallback, so *any* genuine structural
   improvement (even a partial one, properly disclosed as `plausible` rather
   than `established`) is a real improvement opportunity with low competitive
   noise floor.

### 2.3 Things that sound impressive but are not real attacks here

- **"Break SHA-256" in the literal/full-round sense.** Out of scope entirely —
  the only SHA-256 tracks are 31/32-round prefix reductions out of 64
  (`target-profiles/sha256-r31-prefix-v1.json`: `full_rounds: 64`).
- **Any attack on a different problem variant**: compression-only, free-start
  (attacker controls IV), near-collision, truncated-output, or quantum attacks
  are explicitly declared out of scope by every target profile's
  `out_of_scope` list and by `docs/FRONTIER_LANES.md` ("Free-start,
  compression-only, quantum, and truncated-output attacks do not solve these
  ordinary complete-message hash targets").
- **Treating the nominal reference (64/80/128 bits) as a real baseline to
  "beat."** It's explicitly not one: "Nominal references are neither
  established attacks nor qualified baselines" (`README.md`), repeated verbatim
  across `docs/FRONTIER_LANES.md`, `docs/CANDIDATE_QUALIFICATION.md`,
  `docs/JUDGE_LANES.md`. An agent claiming "I beat the 128-bit security claim"
  without a real structural argument is just restating the generic birthday
  bound, as `sha3-256-r5/r6` and `blake3-r2` already do, and that does not
  constitute a glorious or even interesting result.
- **A toy/sampled experiment "proving" a global probability.** The harness is
  explicit that fixed-seed, small-sample, or deterministic-PRNG experiments
  never establish independence or a full-scale success bound
  (`docs/HEURISTIC_EXPERIMENTS.md`: "Fixed seeds... can invalidate an advertised
  coverage claim"; "A finite run does not establish expected time"). An agent
  that runs a Monte Carlo check and calls it a proof will get flagged by the
  cost/experiments roles, not pass review.
- **Reusing a historical runtime/operation-count figure from a paper as the
  repo's `time_log2` directly.** The repo's cost unit (target-compression
  equivalents under `collision-frontier-v5`) is not the same as a paper's
  reported wall-clock or abstract operation count; `docs/FRONTIER_RESEARCH.md`
  "Cost and round conventions" and the `sha256-r31` proof's own `H-HISTORICAL-
  TIME` heuristic (an explicit, disclosed, scored-as-uncertain conversion
  factor `c`) show this conversion is itself a first-class, disclosed heuristic
  — never a free substitution.
- **Model-confidence as success probability.** "Model confidence is not
  algorithmic success probability" is stated near-verbatim in `README.md`,
  `docs/BUILDER_GUIDE.md`, `docs/JUDGE_LANES.md`. An agent cannot just assert
  "I'm 90% sure this works" as the `success_probability` field; that field is
  the fixed algorithm's own probability space over its random coins.
- **"Exploratory pass" as if it were acceptance.** `plausible_not_refuted` means
  "no confirmed fatal flaw survived adjudication," not mathematical truth or
  human acceptance (`README.md`, `docs/JUDGE_LANES.md` table). The product
  framing in `docs/PRD.md` already gets this right and should not be loosened.

---

## 3. Scoring mechanics

### 3.1 `log2(total charged computation)`, exactly

Current cost model is `collision-frontier-v5` (`cost-models/collision-frontier-v5.json`;
migration from v4 documented in `docs/TIME_ONLY_REORG.md`, from v3 in
`docs/FRONTIER_RESEARCH.md`/`docs/RESCORING.md`). The scalar emitted is
`metrics.timeLog2` = `time_log2` from the claim, i.e. `log2(T)` where `T` is
total work in **target-compression-equivalent units** under a "classical
probabilistic 256-bit word RAM" model (`cost-models/collision-frontier-v5.json`
`computation_model`):

- One selected-target reduced-round compression (or sponge permutation) call = **1 unit**.
- Every other primitive 256-bit word operation (load/store, add/sub mod 2^256,
  bitwise op, shift/rotate, compare, branch, one fresh random 256-bit word) =
  **1/C units**, where `C` is that target's `reference_operation_cost` —
  843/856 (MD5 s63/s64), 1957/1982 (SHA-1 r79/r80), 2140/2224 (SHA-256 r31/r32),
  1355/1626 (SHA3-256 and Keccak[800] r5/r6), 222/430 (BLAKE3 r1/r2) — table in
  `docs/RESCORING.md` and `cost-models/collision-frontier-v5.json`
  `reference_operation_costs`. `C` is reproducible via
  `scripts/reference_operation_costs.py`.
- `T` must include **everything**: preprocessing, message/differential
  construction, randomness draws, *all* trials including failures, sorting and
  lookup, collision checking, restart/success amplification
  (`cost-models/collision-frontier-v5.json` `total_time_includes`).
- Lower is better (`direction: lower-is-better`). Memory (`memory_log2_bytes`)
  is required and reviewed but contributes **zero** to the scalar and never
  breaks ties (`memory_scoring: "Required and reviewed as a metric only; no
  scalar contribution and no tie-break"`).
- Time is summed work **across all processors**, not parallel wall-clock
  (`parallel_computation`).
- Minimum required `success_probability` for any submitted claim is **0.39**
  (schema minimum, and stated throughout `TASK.md`/`docs/CANDIDATE_QUALIFICATION.md`).
- `data_log2` is optional legacy metadata with **no scoring or review effect**
  (`docs/OPTIONAL_DATA_METRIC.md`).

A worked numeric example lives in `sha256-r31/proof.md` §8: vector
`(time=41, memory=25.25, data=41, preprocessing=40.75, success=1, advice=9)`
gives a scalar that was `66.25` under the old `time + memory` (v3) formula but
would now be re-scored as just `41` under the current time-only v5 formula
(`docs/TIME_ONLY_REORG.md` "Consequences": "A time bound of 73 with memory
exponent 21 changes from score 94 to 73"). **Important nuance for the PRD**:
this means the committed `sha256-r31` package's displayed score (66.25) in its
own `proof.md` text is stated under the *retired* v3 model; the actual current
scalar for that exact construction would be the `time_log2` component alone
(41) once requalified under v5 — confirming the live `reference_operation_costs`
table lists `sha256-r31: 2140` as its current C.

### 3.2 Ranking surfaces

The docs describe **Frontier**, **All Rounds**, and **Time Series** views by
name only in `docs/PRD.md`'s own framing and are not independently defined
inside `reference/hash-smash/` docs under those exact labels — those three view
names come from the Yukon platform's generic benchmark UI, not from HashSmash's
own documentation set. **Unclear from the docs, needs asking the HashSmash
org / checking the live Yukon UI** for the precise definition of each view;
what *is* documented here is the underlying mechanism each view must be built
from:
- Per-track ranking is just the sorted `time_log2` scalar, lower-better, within
  one `<target>-<lane>` track (`docs/FRONTIER_LANES.md` "Lanes and scoring").
- `yukon benchmark show` reports a track's "current promoted best scalar" (seen
  live in `sha3-256-r5/proof.md`: "current promoted best scalar as 137.785").
- Promotion is `promotionMode: manual` on every track (`benchmark.json`,
  `docs/YUKON_DEV_SETUP.md`): a qualifying score that **improves** the current
  promoted best enters Yukon's `review` state without auto-merging; the
  benchmark owner must separately accept the exact candidate commit via
  `POST /api/submissions/:id/review` before promotion is queued (`docs/
  YUKON_DEV_SETUP.md` "Owner decisions"). A qualifying-but-non-improving result
  never enters review at all.
- A rejection or "reorg" judgment is distinct from a refutation: `reject` just
  means "does not currently qualify," not "proven wrong" (`docs/RESCORING.md`
  "Reorg judgments").

### 3.3 `plausible_not_refuted` vs `ai_rigor_qualified`, operationally

Both come from one shared review (`paired-lanes-v1`, `docs/JUDGE_LANES.md`):
one evidence package is reviewed once and produces **both** lane decisions; a
candidate submitted to one lane only gets that lane's score, but the sibling
lane's would-be verdict is still recorded for calibration.

| Outcome | Meaning | Exploratory emits score? | Rigorous emits score? |
| --- | --- | --- | --- |
| `plausible_not_refuted` | Relevant support exists; no fatal flaw survived defender+adjudicator review | Yes | No |
| `ai_rigor_qualified` | Material obligations discharged to ordinary cryptanalytic standards | Yes (via its paired exploratory side) | Yes |
| `refuted` | A concrete fatal flaw was confirmed by the adjudicator | No | No |
| `not_evaluable` | Required spec or supporting evidence missing | No | No |
| `not_qualified` | Material obligations unresolved for rigorous specifically | Exploratory may still pass | No |
| `infra_failed` | Provider/schema/binding/stage-coverage failure | No | No |

Operationally: **exploratory is the "plausible and not shot down" bar** — a
heuristic only needs to be `plausible` (relevant evidence exists, material
uncertainty remains) rather than `established`. **Rigorous requires every
heuristic to be `established`** to "ordinary cryptanalytic standards," and an
exploratory pass *never* auto-upgrades: "An exploratory result cannot qualify
the rigorous sibling" (`TASK.md`, `docs/CANDIDATE_QUALIFICATION.md`). Neither
outcome is "mathematical proof or human acceptance" — that's stated nearly
verbatim in `README.md`, `TASK.md`, `docs/FRONTIER_LANES.md`, and
`docs/JUDGE_LANES.md`. Given that **zero rigorous tracks are currently active**
in the live Yukon manifest (§2.1), `ai_rigor_qualified` is not achievable today
on any live track regardless of submission quality — it only matters for the
local research lanes.

---

## 4. What an automated agent loop needs

### 4.1 Environment variables (every one found in the docs/scripts)

| Variable | Purpose | Source |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter provider credential for judge calls | `.env.example`; `judge/README.md` |
| `AWS_BEARER_TOKEN_BEDROCK` | Bedrock provider credential | `.env.example`; `judge/README.md` |
| `HASHSMASH_JUDGE_PROVIDER` | `openrouter` (default) or `bedrock` | `scripts/hashsmash_pipeline.py::_provider_from_env` |
| `HASHSMASH_JUDGE_MODEL` | OpenRouter model override (default `openai/gpt-5.6-sol`) | `judge/README.md` |
| `HASHSMASH_BEDROCK_MODEL` | Bedrock model (default `us.anthropic.claude-opus-4-6-v1`; HashSmash's own workflows/docs pin `us.openai.gpt-5.6-sol`) | `.env.example`; `judge/README.md`; `docs/CANDIDATE_QUALIFICATION.md` |
| `HASHSMASH_BEDROCK_REGION` | Bedrock region (default `us-east-1`) | `.env.example`; `judge/README.md` |
| `HASHSMASH_JUDGE_MODE` | `single` (default) or `committee` (per-role model/strategy via `judge/committees/paired-roles-v1.json`) | `judge/README.md`; `scripts/run-local-track.sh` |
| `HASHSMASH_JUDGE_STRATEGY` | Override default prompting strategy (`formal-proof-v1` etc.) | `judge/README.md` |
| `HASHSMASH_REASONING_EFFORT` | Model reasoning effort (default `high`) | `judge/README.md`; `docs/CANDIDATE_QUALIFICATION.md` |
| `HASHSMASH_ROLE_COMMITTEE_PATH` | Alternate committee config file | `judge/README.md` |
| `HASHSMASH_OPENROUTER_ZDR` | Zero-data-retention routing toggle (default true) | `judge/README.md` |
| `HASHSMASH_EXPERIMENT_HOLDOUT_NONCE` | Organizer-chosen post-commitment nonce for holdout reruns | `docs/HEURISTIC_EXPERIMENTS.md`; `hashsmash_pipeline.py::run_intake` |
| `HASHSMASH_TEST_DOCKER` | `1` opts into real-Docker integration tests | `docs/FRONTIER_VALIDATION.md`; `docs/HEURISTIC_EXPERIMENTS.md` |
| `YUKON_API_KEY` / `YUKON_API_TOKEN` | Yukon dev import/reconcile credential (operator-only) | `docs/YUKON_DEV_SETUP.md` |
| `YUKON_BENCHMARK_IMPORTER_EMAILS` | Allowlist for who can import to Yukon dev | `docs/YUKON_DEV_SETUP.md` |

**Never** committed, printed, or copied: `.env` itself (`README.md`, `AGENTS.md`
wait — `docs/BUILDER_GUIDE.md`: "Never print, commit, copy, or upload `.env`").
Local wrapper scripts (`scripts/run-local-track.sh`, `scripts/run-*-smoke.sh`,
`scripts/run-participant-heuristic.sh`) source `.env` themselves **without
printing it**, and only after deterministic/credential-free stages have already
run.

### 4.2 Docker/sandbox requirements for heuristic experiments

Only needed if a submission *declares* an `experiments/manifest.json` with a
`python-message-pairs-v1` entry (the two `addition-xor-*` kinds are pure
organizer Python, no Docker). Full spec, `docs/HEURISTIC_EXPERIMENTS.md`
"Sandbox and setup":

- Pinned image: `python:3.12.12-slim-bookworm@sha256:2986c55feb36e6ca...`
  (exact digest in the doc), pulled explicitly ahead of time via
  `scripts/prepare_experiment_image.py --track <id>`; execution always uses
  `docker run --pull=never` against that pinned digest — no implicit pulls at
  run time.
- Container isolation: **no network**, read-only root filesystem and source
  mount, runs as unprivileged user `65534`, **all capabilities dropped**, `no
  new privileges`, default Docker seccomp profile, **1 CPU**, **128 MiB memory,
  no swap**, 32 processes max, 64 file descriptors max, no core dumps, a 16 MiB
  noexec tmpfs.
- Host watchdog enforces a **20-second** default timeout and a **2 MiB**
  combined stdout+stderr cap through bounded pipes; Docker log persistence is
  disabled.
- **No repository, candidate directory, Docker socket, home directory, or
  `.env` is ever mounted into the container.** The Docker CLI itself runs with
  a scrubbed environment; no provider key is ever forwarded to the container.
- The submitted program cannot select its own Docker flags — all of the above
  is organizer-controlled and not participant-configurable.
- Two fresh, independent container runs of the same request must produce
  **byte-identical stdout** (reproducibility gate); `PYTHONHASHSEED`, locale,
  architecture and image are all fixed by the runner.
- **There is no host-execution fallback.** Missing Docker / absent pinned image
  / unsupported sandbox settings raise `ExperimentSetupError` and the run stops
  as a dev-setup failure — not a rejected claim, not a workaround to improvise
  around (`TASK.md`: "A missing provider key is not a reason to alter the
  harness or bypass review" — same principle applies to a missing Docker
  daemon).
- For CI/Yukon deployment specifically: experiment execution and judge review
  must be **separate GitHub Actions jobs** — the experiment job is
  credential-free, the judge job holds the Bedrock/OpenRouter secret and never
  executes participant code (`docs/HEURISTIC_EXPERIMENTS.md` "For Yukon/GitHub
  Actions deployment"; also `docs/YUKON_DEV_SETUP.md` "GitHub and provider
  access": "Only the judge step receives the provider key; experiments and
  final scoring run in separate jobs").

For an agent loop that never runs Python experiments (i.e., a purely analytic
proof, like `sha256-r31`'s package), **none of this Docker machinery is
needed** — `docs/HEURISTIC_EXPERIMENTS.md`: "Experiments are required when
declared; an analytic proof need not include a meaningless empirical program."
This is the practical reason to prefer analytic-proof submissions for a first
agent loop (see §5).

### 4.3 What counts as a clean re-run if inputs change

Every stage is **fingerprint-bound** and the pipeline fails closed on any
mismatch, rather than silently reusing stale state:

- `package_sha256` = SHA-256 over the canonical JSON of every file's
  `{path, size_bytes, sha256}` (`verifier/intake.py` lines 222-230). Changing
  **any** byte in the candidate directory changes this.
- `target_config_sha256` binds the exact target profile/cost-model
  configuration used (`verifier/intake.py` line 251; `track.config_sha256()`).
- Before judge review, `_check_current_evidence` **re-runs intake from scratch**
  on the live candidate directory and byte-compares the freshly built evidence
  against the stored `judge-evidence.json`; any difference raises
  `VerificationError("stale or mismatched evidence: rerun intake for this
  track")` (`hashsmash_pipeline.py` lines 229-237). An agent **cannot** edit a
  candidate after intake and then run `judge` against the old evidence — it
  must always re-run `intake` first.
- Before scoring, `run_score` independently re-checks `judge_evidence_sha256`,
  `judge_config_sha256`, and `dossier_sha256` all still agree, and re-derives
  the deterministic lane aggregation from the stored reviews to confirm it
  matches the stored `lanes` decision (lines 312-344) — scoring cannot be
  spoofed by hand-editing a dossier file.
- At the TASK.md level: "Changed inputs require fresh evidence and review" is
  stated as a flat rule (`TASK.md` "Prepare a reviewable package", repeated in
  `docs/CANDIDATE_QUALIFICATION.md`, `docs/JUDGE_LANES.md`). There is no partial
  re-review — any edit means the full `intake -> judge -> score` cycle reruns.
- **Practical implication for an agent loop**: a clean iteration is always
  "edit candidate files -> `local_tracks.py check` (free, fast feedback) ->
  only once confident, `hashsmash_pipeline.py intake` -> `judge` (costs a model
  call) -> `score`." There is no cheaper way to get AI-review-quality feedback
  short of actually invoking the judge; `local_tracks.py check` only catches
  mechanical/schema problems, never argument quality.

---

## 5. Recommendation: which target+lane to point a first real agent loop at today

**`sha256-r31-exploratory`.**

Reasoning, concretely:

> **Correction (2026-10-05, found while building the pipeline runner):** point 1 below is
> wrong about the *existing* package. `experiments/manifest.json` in the accepted
> `sha256-r31` candidate declares a `python-message-pairs-v1` experiment
> (`experiments/replay.py`), and that kind runs **only** in the pinned Docker sandbox.
> On a machine without Docker, `hashsmash_pipeline.py intake --track sha256-r31-exploratory`
> on that package exits 3 with "Docker is unavailable; participant Python has no host
> execution fallback". A *new* package that declares no experiments needs no Docker
> (verified: `check` and `intake` run fine), so the recommendation still holds for
> new candidates. Reproducing or re-scoring the existing package locally needs Docker.

1. **Lowest setup cost.** It requires *zero* Docker/sandbox machinery — its
   existing package is a pure analytic proof with no declared experiments
   (`experiment_manifest` entry present with just a replay-check experiment
   kind that uses the organizer's own exact/sampled evaluator, not participant
   Python requiring Docker — confirmed by its `claim.json`'s
   `experiment_manifest` pointing at a manifest whose only entry type doesn't
   need the sandbox per `docs/HEURISTIC_EXPERIMENTS.md`'s three supported
   kinds). An agent loop against this track only ever needs
   `OPENROUTER_API_KEY` (or Bedrock) — no `docker pull`, no image prep, no
   sandbox resource limits to reason about.
2. **Clearest schema to imitate.** It is the single most complete, highest-
   quality example package in the entire repo: a real published attack
   (ASIACRYPT 2024), fully reproduced characteristic, exact byte-level witness
   messages, a worked and auditable memory-compression proof (§9 of its
   `proof.md`), and two cleanly separated, explicitly-scoped score-critical
   heuristics (`H-HISTORICAL-TIME`, `H-HISTORICAL-MEMORY`) with their own
   quantitative failure conditions spelled out. There is no better template in
   this repository for an agent to learn the expected shape of `claim.json` +
   `proof.md` from.
3. **Most existing activity to learn from and build on.** It's one of only two
   live tracks (with `blake3-r1`) that has a genuine, non-generic cryptanalytic
   result behind it already, and its sibling `sha256-r32` shows the natural
   next move (adapting a newer paper to a harder round count) half-done and
   explicitly marked `READY FOR REVIEW` with disclosed open heuristics — giving
   an agent loop a second, slightly harder target with a visible partial
   solution to extend or tighten, in the *same* hash family and cost-model
   conventions it just learned on `r31`.
4. **It's live in Yukon today** (unlike `keccak800-r5/r6`, which score equally
   well locally but aren't on the active manifest, and unlike any Poseidon
   target, which doesn't exist yet) — so a working submission is actually
   rankable and promotable, not just a local exercise.

Second choice, if the first agent loop should instead chase a genuinely open
research question rather than imitate an existing solved package:
**`blake3-r1-exploratory`** — it's the only other live track with a real
structural (non-generic) result, it's the shallowest BLAKE3 reduction (easiest
to find more structure in), and its current `H1` heuristic is explicitly scoped
as needing more experimental support, which is a concrete, bounded target for
an agent to actually improve rather than just replicate.

**Avoid as a first target:** anything requiring the Docker experiment sandbox
(adds an entire isolated-execution subsystem to get right before any model-
judgment feedback loop even starts), and Poseidon (no target profile exists —
there is nothing to submit against; confirmed in §2.1).

---

## Open questions for the HashSmash org (flagged, not guessed)

- Exact definitions of the "Frontier / All Rounds / Time Series" leaderboard
  views named in `docs/PRD.md` aren't in this repo's own docs — they appear to
  be generic Yukon platform UI concepts, not HashSmash-specific. Needs
  confirming against the live Yukon UI or asking the org directly.
- Whether `sha256-r31`'s committed package has actually been re-qualified and
  re-scored under the current `collision-frontier-v5` model (its own
  `proof.md` still quotes the retired v3 combined score 66.25) is not stated in
  any doc read here — `docs/TIME_ONLY_REORG.md` describes the *general*
  migration mechanics but no document confirms this specific candidate's
  post-migration status. An agent loop should not assume 41 (or 66.25) is this
  package's current live score without checking `lanes/exploratory/.yukon/scores/`
  directly (which is git-ignored and not present in this checkout).
