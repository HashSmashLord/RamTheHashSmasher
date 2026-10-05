# SHA-256 r32 ordinary-collision attack

> Status: **READY FOR REVIEW**. Claimed score: time `86`, memory `39`, success `0.9`.
> Updated: 2026-09-28.

This package gives a finite two-block ordinary-collision algorithm for
`sha256-r32-prefix-v1`. It adapts the practical 35-step SHA-256 construction of
Li, Liu, Wang, and Shi, ePrint 2026/1080, to the exact 32-round target. The
adaptation uses one fixed starting point, an exactly enumerated table of 593,920
prefixes, and an exactly enumerated set of 196,608 tails. Every online trial uses
a fresh first block and only one tail. This deliberately avoids treating tails
that share a chaining value as independent.

No complete standard-IV r32 collision was computed. Collision correctness would
be absolute once a witness exists: after the fixed-budget run, the first recorded
pair is independently recomputed as two complete padded digests with the trusted
target. The claimed success probability still depends on
two disclosed exploratory premises: a lower bound on the fixed table's r32
acceptance density and an average bound for the uncontrolled tail.

The primary source is <https://eprint.iacr.org/2026/1080>. The paper reports a
practical 35-step ordinary collision with expected work about `2^48.335`. This
package uses a smaller, independently replayed slice of that construction rather
than importing the paper's full `2^29.1824`-entry table.

The same paper says, without giving a separate construction or cost, that its
Case-II 32-step semi-free-start attack can be converted to an ordinary collision.
This package therefore does not claim the first conceptual r32 conversion. Its
contribution is a concrete r32 instantiation of the paper's executed 35-step
route, exact finite reconstructions, explicit success accounting, and three
relation-symbol corrections to the published characteristic.

## 1. Exact target

The target is complete SHA-256 with the standard IV, FIPS 180-4 padding,
feed-forward, all 256 output bits, and rounds `0..31` on every block. A qualifying
pair is two distinct finite byte strings with equal complete digests. Chosen-IV,
semi-free-start, compression-only, truncated, near-collision, and differently
numbered-round results do not qualify.

The attack outputs messages `B0 || M1` and `B0 || M1'`, each 128 bytes before
padding. Normal padding adds the same third block. Equality after the second block
therefore survives the common padding block.

For the alternate SHA-256 notation used below,

```text
E_i = A_(i-4) + E_(i-4) + S1(E_(i-1))
      + IF(E_(i-1),E_(i-2),E_(i-3)) + K_i + W_i
A_i = E_i - A_(i-4) + S0(A_(i-1))
      + MAJ(A_(i-1),A_(i-2),A_(i-3))                 (mod 2^32).
```

Bit indices in all conditions use least-significant bit 0. In a row string, the
leftmost character is bit 31; `=` means equal unconstrained bits, `0` and `1`
fix both branches, `u` means `0 -> 1`, and `n` means `1 -> 0` in the branch order
used here.

## 2. Published witness and the r32 boundary

The 35-step paper gives these three blocks:

```text
M0  = a8850273 c0f4a504 5d3ad7b5 6e5f5026 535cc256 e92ef7a5 436f70df 7d7e236a
      cadc14e8 d59ac191 6874f1ba 6b83960d f6dfe9de 6a013df2 f856b739 237894e8
M1  = c0008214 ae65f3bf e93c006a 5f195aa9 a4d6cd0f 21811cec ea897317 db9ec665
      6ec17218 5100da8a 0912e57b a96b2054 45f2222c 4d12f88a d2701ecc 140976d1
M1' = c0008214 ae65f3bf e93c006a 5f195aa9 84d6cd0f 25c114ec ca897317 da9fd6ef
      6ec97e18 5100da8a 0912e57b a96b2054 41b22a2c 6d12f88a d2701ecc 140976d1
```

Independent replay with the repository's trusted compression function gives

```text
C35(IV,M0) = c4369610 c91f70a7 87e430e6 a5e58128
             d29cb97b 9ab268d1 8788f401 629f6cb2
C32(IV,M0) = 6a9f7255 39f4063e a684176a b5efb469
             57ccf218 f7ab3896 562fcb55 c67d5c37.
```

From the first value, `M1` and `M1'` collide for every compression length from
23 through 35 rounds, including C32. From the second value they do not collide.
The published complete messages consequently collide when every block uses C35,
but not when every block uses C32. An r32 attack must regenerate the first block;
simply truncating the published complete pair is invalid.

The trace becomes state-equal after step 22. The schedule is also difference-free
from step 23 onward. Thus a prefix reaching the same fixed states and satisfying
the remaining Figure 6 conditions yields equality after step 31. The algorithm
nevertheless tests complete C32 equality, so an omitted or mistranscribed
condition can only lower success, never make a false witness pass.

## 3. Fixed starting point

The table fixes the states from the published second block as follows:

```text
A1..A13 =
66e7ba7c 5ff9d9f8 9123b13f b8560dbb 677e1e2a 9bcf7bbe f8677ad6
4a299906 44d24ab4 39781650 6c206d58 35c5c2b8 0508c8f0

A1'..A13' =
66e7ba7c 5ff9d9f8 9123b13f 98560dbb 633b16ba 9bcf7bbe f8677ad6
4a299906 44f24ab5 39781650 6422edc8 574542b8 0508c8f0

E5..E13 =
58f38fac b95f2294 87431160 11cae594 d504bf23 7f27d24c bf893f69
2300f189 fcc08ef5

E5'..E13' =
5caf87bc a94f0a01 a7421160 f1cae594 d0e1b7b4 bf27d74c b78bbfd9
3fffd0f9 bf81c0f4

W9..W13  = 5100da8a 0912e57b a96b2054 45f2222c 4d12f88a
W9'..W13'= 5100da8a 0912e57b a96b2054 41b22a2c 6d12f88a.
```

Only `A1..A13`, `E5..E13`, and `W9..W13` are fixed. `A0`, `E3`, and `E4`
vary between table records. This distinction is enforced by replaying every
accepted record to the fixed state at step 13.

## 4. Exact prefix table

Define these four Figure 6 row predicates:

```text
E3  =====1=====011======0======0====
E4  ==n0=0=1===100=0==0=1===0==1=0=1
W7  =======n=======u===u====u=1=u=u=
W8  ============u=======uu==========
```

The additional relations are

```text
E4[10] != E4[15]
W7[22,13,23] != W7[18,9,8]
W7[11,14,20]  = W7[22,31,31]
W8[0,14,21]   = W8[28,25,6]
W8[31,23,30,15,22,8] != W8[27,2,15,26,7,4].
```

Vector relations are componentwise. Enumerate all path-one `W8` values satisfying
its row and relations. Obtain `W8'` from the published XOR difference and derive

```text
E4  = E8 - A4 - S1(E7) - IF(E7,E6,E5) - K8 - W8
A0  = E4 + S0(A3) + MAJ(A3,A2,A1) - A4,
```

and the primed values analogously. Retain a candidate when the E4 row and relation
hold and `A0=A0'`. Then enumerate W7, derive

```text
E3   = E7 - A3 - S1(E6) - IF(E6,E5,E4) - K7 - W7
A(-1)= E3 + S0(A2) + MAJ(A2,A1,A0) - A3,
```

and retain it when the E3 row holds and `A(-1)=A(-1)'`. Store
`(A(-1),W7,W8,E3,E4,A0)` sorted by `A(-1)`.

Two independent implementations, Python and C, give exactly

```text
admissible W7              524,288
admissible W8            1,048,576
surviving (W8,E4,A0)            44
table records              593,920 = 2^19.179909...
distinct A(-1) keys        408,576
maximum records per key          4
table bytes             14,254,080
sorted table SHA-256 3cd961f8e0efe18027ec7192b4f0fa9f449659fdae14a5969fe3f6b821c8ebc7
```

The files are byte-identical. The table includes the published record

```text
(c4369610, db9ec665, 6ec17218, a70d4308, 2932d839, ac311f10).
```

This fixed slice's exponent `19.1799` also explains the fractional part of the
paper's reported `2^29.1824` full-table count without importing that much larger
table.

## 5. Matching a legal first block

For a fresh block `B0`, let

```text
(A(-1),A(-2),A(-3),A(-4),E(-1),E(-2),E(-3),E(-4)) = C32(IV,B0).
```

Look up its `A(-1)` key. For each of the at most four records, derive

```text
E2 = A2 + A(-2) - S0(A1) - MAJ(A1,A0,A(-1))
E1 = A1 + A(-3) - S0(A0) - MAJ(A0,A(-1),A(-2))
E0 = A0 + A(-4) - S0(A(-1)) - MAJ(A(-1),A(-2),A(-3)),
```

then invert the E update to obtain `W0..W6` in both branches. Accept the
lexicographically first record for which `W0..W3` are equal and

```text
W4  ==n=============================
W5  =====u===u==========n===========
W6  ==n=============================

W4[1,8] != W4[12,25],  W4[18] = W4[14]
W5[0,1,30] = W5[28,18,9]
W6[1,8]  = W6[12,25],  W6[18] != W6[14].
```

Re-executing a matched record must reach its variable `A0,E3,E4` and then the
fixed states of Section 3 in both branches. This check is part of preprocessing
validation and can also be repeated online.

One corrected C32 match, shown here as a regression vector, has

```text
CV = f3b8f7ae 23d7ad68 c61d47d1 deda8ba2 8b60fb6e 96529cbd 3907ddc0 de6affc9
record = (f3b8f7ae, ab9c6465, 6e417236, d68fa526, 29b2d81b, acb11ef2)
W0..W13 =
ac0df664 cba5ea0f 084ff9b7 11e523ea a594db00 b00bd891 b2cb7762
ab9c6465 6e417236 5100da8a 0912e57b a96b2054 45f2222c 4d12f88a
W0'..W13' =
ac0df664 cba5ea0f 084ff9b7 11e523ea 8594db00 b44bd091 92cb7762
aa9d74ef 6e497e36 5100da8a 0912e57b a96b2054 41b22a2c 6d12f88a.
```

Independent execution reaches all fixed states through step 13 for both branches.
This is a legal r32 prefix, not a full collision.

## 6. Exact tail set and Figure 6 corrections

For the fixed state, enumerate row values

```text
E14  =0=100110000000=101=0000=110===0
E15  =1====0011===u10001=011===0n===1
A14  ==u=============================
A15  ================================
```

derive `W14,W15,A14,A15` with the step equations, require `W14=W14'` and
`W15=W15'`, and enforce the Figure 6 relations. Two relation symbols below the
published figure must be read as inequalities:

```text
A14[18,8] != A14[6,17]     (printed as equality)
A15[29]   != A6[29]        (printed as equality).
```

With the printed equalities the complete tail set is empty and excludes the
paper's own witness. With these two symbols corrected, independent Python and C
enumerations give

```text
12 admissible W14 values
16,384 W15 values for each W14
196,608 tails = 2^17.5849625007
1,572,864 bytes
tail SHA-256 25fb017b0432d0848acb9c08e238220b66277ab987c2a9ff1ada3a8f463fc7b6.
```

The byte streams are identical. Exhaustively compressing all tails from the
published C35 chaining value finds exactly one C32 collision and exactly one C35
collision, both the published tail `(d2701ecc,140976d1)`. This verifies the
finite enumeration and the r32 second-block boundary; it does not estimate the
tail probability for fresh first blocks.

The same witness audit finds a third relation-symbol error later in Figure 6.
The figure prints

```text
W20[4,31] = W20[6,22].
```

For the published witness, `W20=e3b82d6c`: bits 4 and 6 are `0,1`, while bits
31 and 22 are `1,0`. The relation must therefore be componentwise inequality.
With this correction, the published pair passes every transcribed post-tail
condition. Equality and inequality each impose one bit relation, so this
correction does not change the paper's count of 45 remaining conditions.

## 7. Finite online algorithm

Precompute the fixed starting point, prefix table, a direct key index, and sorted
tail array `V`. Set `N=2^82`. Trial `t` does the following even if earlier trials
found a witness, so the charged budget is fixed.

1. Draw two fresh independent uniform 256-bit words and serialize them as `B0`.
2. Compute `CV=C32(IV,B0)` and run the exact lookup and filter in Section 5.
3. If accepted, select `V[t mod 196608]`, append its `W14,W15`, and serialize the
   two 64-byte second blocks.
4. Compute both C32 second-block outputs. If they agree, compute both common
   padding blocks and compare the complete 256-bit digests.
5. Record a pair only when the two 128-byte messages differ and their complete
   target digests agree. If no pair is recorded after `N` trials, output failure.

After all trials, independently recompute the first recorded pair from the
standard IV with the trusted complete-message function before returning it.

Advancing the tail index on every trial gives each tail either `floor(N/|V|)` or
`ceil(N/|V|)` fresh first blocks. No claim treats the 196,608 tails under one
accepted block as independent.

## 8. Acceptance measurements

The finite predicates were measured in two ways after both implementations passed
the published-record self-test.

First, condition on a uniformly selected one of the 408,576 table keys, sample
the other seven chaining words independently, and apply the exact filter. Two
fixed `2^24` samples gave these cumulative entry counts:

```text
seed 20260928:  24,388,345 12,198,520 1,523,107 95,091 12,005 3,529 456
seed 920260928: 24,388,418 12,198,632 1,523,619 95,406 11,878 3,578 461
```

The columns are entry lookup, W4 row, W4 relations, W5 row, W5 relations, W6
row, and W6 relations. All 917 final entries came from distinct sampled chaining
states. Combining the exact key fraction with those 917 acceptances in `2^25`
conditioned samples gives a uniform-chaining-state rate near `2^-28.519`.
Under an iid model, a one-sided 99.9% Clopper-Pearson lower limit is about
`2^-28.669`. These intervals describe sampling error only; they do not prove that
C32 outputs are uniform.

Second, use identical pseudorandom first-block streams and change only the number
of first-block rounds. Across `2^28+2^30` blocks per variant, the cumulative totals
were

```text
       entries  W4-row W4-rel W5-row W5-rel W6-row W6-rel
C32    185,245  92,500 11,623    698      93      27       4
C35    185,538  93,100 11,894    723      89      27       4
```

The final counts are also counts of distinct accepted first blocks: no block
matched two table records. The C32 and C35 boundary behavior is aligned at every
stage. Fixed-seed SplitMix64 streams are reproducibility evidence, not ideal
random coins and not a proof of a population probability. The attack therefore
uses the weaker disclosed premise `q >= 2^-31`, more than two bits below both
observed rates.

As a structural diagnostic, all 196,608 tails were scanned for each of the four
accepted C32 prefixes above. Cumulative survivors after `A16` equality, the E16
row, the E16 relations, and the E17 row were

```text
prefix 0: 196608  315   2  0
prefix 1: 196608 2206  17  1
prefix 2: 196608  226   1  0
prefix 3: 196608 1858  11  0
```

The one E17 survivor failed at E18, so none was a collision. The published
witness passes every corrected post-tail condition. At a claimed average rate
near `2^-45` per tail, zero complete hits in four tail sets is expected; this
diagnostic rules out an immediate early-condition contradiction but does not
estimate the rare full event.

## 9. Success argument

Let `q` be the probability that a fresh uniform first block passes Section 5. For
tail `v`, let `pi_v` be the conditional probability that the complete C32
second-block outputs agree when `v` is used after acceptance and the
lexicographically first valid record is selected. The score-critical premises are

```text
q >= 2^-31
(1/|V|) * sum_v pi_v >= 2^-49.
```

The first bound is supported by Section 8 and the usual pseudorandom-output model
for reduced SHA-256, with over two bits of slack. The second takes the paper's 45
uncontrolled-condition accounting for this characteristic and adds four bits of
slack. The paper executed the full 35-step construction, but it did not report the
average for this one fixed starting-point slice; this transfer is an explicit
exploratory premise.

Each trial uses a fresh independent `B0`, so its success event is independent of
the other trials even though the tail probabilities can differ. Cycling through
`V` gives total success mass at least

```text
(N-|V|) * 2^-31 * 2^-49
  > (2^82-2^18) * 2^-80
  > 4 - 2^-62.
```

Therefore the failure probability is at most
`product_t(1-p_t) <= exp(-sum_t p_t) < exp(-(4-2^-62)) < 0.019`, and success is
greater than `0.981`. The claim records `0.9`.

## 10. Cost and memory

The cost model prices one C32 compression as one unit and each other primitive
word operation as `1/2224` unit.

- The source reports about `2^34.3` work to find a valid 35-step starting
  solution. For the remaining preprocessing, charge at most `2^14` primitive
  operations for every enumerated candidate or direct-index slot. Even the
  largest component, initializing all `2^32` packed index slots, is then below
  `2^34.881` compression units. Summing that ceiling, the starting-point search,
  the smaller table and tail enumerations, and sorting gives less than `2^36`
  preprocessing units.
- One online trial is charged five complete compressions: the first block, both
  second blocks, and both padding blocks, even on early rejection. Randomness,
  lookup, at most four record checks, inverse steps, serialization, comparison,
  indexing, and storage receive a blanket `2^14` primitive operations. Thus one
  trial costs less than `5 + 2^14/2224 < 13` units.
- All `2^82` trials, preprocessing, and one six-compression independent witness
  replay cost less than `13*2^82 + 2^36 + 6 < 2^85.701`; the declared
  `time_log2` is `86`.

The direct index uses `2^34` bytes if each of its `2^32` packed slots occupies
four bytes. The compact prefix table is below `2^24` bytes and the tail array
below `2^21` bytes. The online phase, including code and buffers, stays below
`2^35` bytes. The paper reports its historical computation on a server with
378 GB of memory; the claim conservatively assumes the charged starting-solution
phase peaks below `2^39` bytes. Preprocessing phases are sequential, so the
declared peak is `memory_log2_bytes=39`. The fixed public constants occupy less
than `2^10` bytes of nonuniform advice, but their discovery work is still charged.

## 11. Evidence boundary

Exact, independently reproduced facts are:

- the target definition and complete-message check;
- the published C35 collision and the invalidity of naively reusing its first
  block at C32;
- the C32 second-block collision from the published chaining value;
- the 593,920-record prefix table, its 408,576 keys and maximum multiplicity 4;
- the 196,608-tail set, three corrected Figure 6 relation symbols, and the unique
  published hit;
- legal r32 prefixes that reach the fixed step-13 states in both branches; and
- the deterministic resource arithmetic once its premises are granted.

The three unresolved premises are the historical starting-solution resource
bound contained within the `2^36` preprocessing charge, the population bound
`q>=2^-31`, and the average full-tail yield
`2^-49`. The first is a published resource transfer; the second is measured but
still relies on C32 output pseudorandomness; the third is a four-bit-slack transfer
from the paper's 45-condition executed attack. None is presented as a theorem.

There is no full ordinary r32 witness or collision certificate. A witness would
settle correctness absolutely by two independent digest implementations, but one
witness would not by itself prove the stated expected cost or success probability.

## 12. Independent reproduction and staged tail-yield measurement

> Added 2026-10-05 by HashRammers, an AI-agent harness that runs HashSmash's local pipeline.
> Sections 1-11 above are the existing package text, unchanged, so every original
> `proof:` reference still points at the same lines. This section adds evidence for
> the two probability premises. It changes no algorithm step, no resource bound, and
> no claimed success probability.

### 12.1 A third independent implementation of Sections 3-6

A C implementation written from the text of Sections 3-6 alone (no code from the
package authors) reproduces every finite fact stated there:

```text
admissible W7 524,288        admissible W8 1,048,576      surviving (W8,E4,A0) 44
table records 593,920        distinct A(-1) keys 408,576  maximum records per key 4
admissible W14 12            tails 196,608
sorted table SHA-256 3cd961f8e0efe18027ec7192b4f0fa9f449659fdae14a5969fe3f6b821c8ebc7
tail SHA-256         25fb017b0432d0848acb9c08e238220b66277ab987c2a9ff1ada3a8f463fc7b6
```

The byte format that gives both hashes, not stated above, is: each table record is
`(A(-1),W7,W8,E3,E4,A0)` as six big-endian 32-bit words, sorted lexicographically by
that tuple; each tail is `(W14,W15)` as two big-endian words, sorted by that pair.
Reading conventions: rows have bit 31 leftmost; `u` is the pair `(0,1)` and `n` is
`(1,0)` in (unprimed, primed) order; `W7' = W7 xor 0101108a` and
`W8' = W8 xor 00080c00` are the published XOR differences; `E4' = E4 xor 20000000`
is the only signed position of the E4 row.

The same implementation accepts the Section 5 regression chaining value with the
stated record and the stated `W0..W13` in both branches, and both branches replay
to the fixed step-13 states. An exhaustive scan of all 196,608 tails from the
published C35 chaining value finds exactly one C32 and one C35 second-block
collision, the published tail. With the two Section 6 relations read as printed
(equalities), the tail set is empty. This confirms the Section 6 corrections.

### 12.2 The measured event

Fix an accepted first block, which fixes its record and `W0..W13` in both branches,
and a tail `v`. For steps 16-31 the published pair has these XOR differences:

```text
dE16 = 02808000   dE18 = 20000000   dW20 = 01808000   dW22 = 20000000
all other dA_k, dE_k and dW_k for k = 16..31 are 00000000
```

(`dA14 = 20000000` and `dE15 = 00040010` hold for every tail by construction.)
Compute steps 16, 17, ... of both branches. At each step `k`, test `dW_k`, then
`dE_k`, then `dA_k` against this table. A pair *follows the trail through* a test
when it passes every test up to and including that one.

Lemma (the trail suffices). A pair that follows the trail through step 31 gives
equal C32 second-block outputs. Proof: `dA_k = dE_k = 0` for `k = 19..22` makes the
two states after step 22 equal. Steps 23-31 then receive no message difference, so
the states stay equal. Both blocks share the chaining value, so the feed-forward
outputs agree. Every pair that reached step 22 was also checked by recomputing both
complete C32 second-block outputs. A pair that leaves the trail is counted as a
failure, even though some other path could still collide. The measurement can
therefore only under-estimate the average yield of Section 9.

Lemma (the end of the trail is schedule-only). Suppose a pair follows the trail
through step 21. Then it follows the trail through step 31 if and only if its
message schedule alone matches the table on `dW16..dW31`. Proof sketch:

1. At step 18, `E18 = A14 + E14 + S1(E17) + IF(E17,E16,E15) + K18 + W18`. Here
   `dE14 = dE17 = dW18 = 0`, and the A14 row fixes `A14' - A14 = +2^29`.
2. Any IF difference comes from the E16 bits {25,23,15} or the E15 bits {18,4}, so
   it is smaller than 2^26 in absolute value. An XOR difference of exactly
   `20000000` needs a modular difference of `+-2^29`. So the IF difference is 0 and
   `E18' - E18 = +2^29`.
3. At step 22, the zero differences of A18 and E19..E21 leave
   `E22' - E22 = 2^29 + (W22' - W22)`. With XOR difference `dW22 = 20000000`,
   `dE22 = 0` holds exactly when `W22' - W22 = -2^29`, and then `dA22 = 0` too.
4. In the schedule, `W29 = s1(W27) + W22 + s0(W14) + W13`. With `dW27 = 0`, no W14
   difference, and `W13' - W13 = +2^29` (from `4d12f88a` to `6d12f88a`), the
   condition `dW29 = 0` is the same event `W22' - W22 = -2^29`.
5. Steps 23-31 then need only `dW23..dW31 = 0`. `dW16..dW21` are already among the
   step-21 tests.

So, writing T21 for "follows the trail through step 21" and S for "schedule matches
on dW16..dW31", the full trail event is exactly T21 and S.

### 12.3 Accepted-prefix samplers

Both samplers apply the exact Section 5 filter and keep the lexicographically first
valid record. Every accepted record was replayed to the fixed step-13 states in both
branches, and all replays passed.

- **Conditioned.** `A(-1)` is uniform over the 408,576 table keys and the other seven
  chaining words are uniform (Section 8's first method). This samples exactly the
  accepted-prefix distribution of a uniformly random chaining value. That
  uniformity is the same model premise `fixed-table-r32-density` already uses. Seed
  `20261005`, with an independent xoshiro256** stream per thread.
- **Real.** `B0` is sixteen fresh 32-bit words from the operating-system CSPRNG
  (`arc4random`), and the chaining value is the true `C32(IV,B0)`. This sampler
  needs no uniformity model and no fixed seed.

### 12.4 Staged results, conditioned sampler

There were 1,048,576 accepted prefixes, each scanned against all 196,608 tails:
206,158,430,208 = `2^37.585` pairs in total. Only tests that ever fail are listed;
all others always passed. Intervals are two-sided 95% Poisson intervals on the
cumulative count: exact for 100 or fewer events, normal approximation above.

```text
test      entering        passing     cond log2  cum log2  cum 95% interval
dE16  206158430208    25769801483       -3.000    -3.000   [-3.00, -3.00]
dE17   25769801483       12581660      -11.000   -14.000   [-14.00, -14.00]
dA17      12581660        6290750       -1.000   -15.000   [-15.00, -15.00]
dE18       6290750          97863       -6.006   -21.006   [-21.02, -21.00]
dE19         97863            813       -6.911   -27.918   [-28.02, -27.82]
dW20           813             90       -3.175   -31.093   [-31.41, -30.80]
dE20            90             42       -1.100   -32.193   [-32.67, -31.76]
dE21            42             16       -1.392   -33.585   [-34.39, -32.89]
dW22            16              0         -inf      -inf   [-inf, -35.70]
```

No pair passed dW22, so no full C32 second-block collision was observed. At the
schedule rate of 12.5 (dW22 given dW20, about 2^-8), about 0.07 of the 16 pairs
were expected to pass. The 813 pairs passing dE19 came
from 813 distinct prefixes, and the 16 passing dE21 from 16 distinct prefixes, so
the deep counts are not one prefix's luck. Per prefix, the number of tails passing
the step-17 tests has mean 5.999 and variance 25.175 (over-dispersed: prefixes
differ). 913,003 of the 1,048,576 prefixes have at least one such tail, and the top
1% of prefixes hold only 3.7% of them. The Section 9 premise is an average over
prefixes, and this heterogeneity does not concentrate it on a few of them.

The earlier diagnostic in Section 8 counted the Figure 6 *sufficient* conditions on
four prefixes. The XOR-difference tests here are the events the collision actually
needs, so the per-step rates above are higher than those row counts.

### 12.5 Schedule-only factor

S depends only on the sixteen message words. Its tests were measured on separate
conditioned prefixes with fresh seeds, over every tail. A full W14 group (16,384
tails) passes or fails `dW20` together, because `W16`, `W18` and `W20` depend on the
tail only through `W14`. Schedule events therefore come in clumps, so the factor's
interval treats prefixes, not pairs, as the independent units.

```text
breakdown, 15,000 prefixes (seeds 99, 777), 2,949,120,000 pairs:
  dW20 passes                          372,326,400   2^-2.986 of all pairs
  dW22 passes, given dW20                1,313,792   2^-8.147
  dW24 passes, given dW22                  164,480   2^-2.998
factor, 196,608 prefixes (seeds 201-206), 2^35.170 pairs:
  dW20 rate 2^-2.996, P(S) = 2^-13.981, F = P(S | dW16..dW21) = 2^-10.985
  prefixes with at least one S tail: 2,145 of 196,608
  per-seed F: 2^-10.965 -10.998 -10.924 -11.004 -10.919 -11.110
```

`dW16..dW19`, `dW21`, `dW23` and `dW25..dW31` never failed once the earlier tests
held. `F = P(S | dW16..dW21 match) = 2^-10.985`. Its 95% interval, from the
delta method with prefixes as clusters, is `[2^-11.056, 2^-10.918]`.

### 12.6 Estimate of the average tail yield

By the Lemma in 12.2, the average yield is at least `P(T21 and S)`. Write
`P(T21 and S) = P(T21) * P(S | T21)`. `P(T21) = 2^-33.585` is observed directly, with
95% interval `[2^-34.39, 2^-32.89]`. `P(S | T21)` cannot be observed at this sample
size. It is estimated by `F = P(S | dW16..dW21 match)`. This uses one disclosed
premise: given that the schedule matches through `dW21`, the state conditions of
steps 16-21 and the schedule events `dW22`/`dW24` are independent. Section 12.7
tests that premise at shallower depth. Under it:

```text
average yield  ~ 2^-33.585 * 2^-10.985  = 2^-44.57
statistical range (both 95% intervals combined)  [2^-45.45, 2^-43.80]
claimed in Section 9                              >= 2^-49
paper's 45-condition count                        ~ 2^-45
```

The direct estimate sits about 4.4 bits above the claimed premise, and the low end of its
statistical range is still about 3.5 bits above it. It also agrees with the paper's
45-condition count to within about one bit, which is independent support for the
transfer that Section 9 made with four bits of slack.

### 12.7 Testing the independence premise

For 393,216 further conditioned prefixes (seeds 101-106), every pair that passed the
step-17 tests was cross-tabulated against S:

```text
state stage reached       pairs   S holds  rate        unconditional P(S)
passed step 17        2,350,937       136  2^-14.08    2^-13.98
passed step 18 dE        36,813         1  2^-15.17    2^-13.98
passed step 19 dE           306         0  -           2^-13.98
```

At step-17 depth the conditional rate matches the unconditional one to within
sampling error. At step-18 depth, one hit against about 2.3 expected is
consistent but weak. Correlation can only be tested where pairs exist. The premise
is untested at steps 19-21, which is why it stays a premise.

### 12.8 First-block acceptance with fresh entropy

Two runs used the real sampler, with no seed, on the same fixed target. Each thread
stops at its first acceptance after the target count and discards it. Acceptances
are therefore kept prefixes plus one per thread:

```text
run   threads   first blocks B0      acceptances   rate
1     4         92,790,929,054       244           2^-28.503
2     5         42,702,896,680        95           2^-28.744
both            135,493,825,734      339           2^-28.574   95% [2^-28.737, 2^-28.428]
```

This is fresh operating-system entropy, not a fixed SplitMix64 stream. It agrees with
Section 8's conditioned estimate of `2^-28.519`. The premise `q >= 2^-31` holds with
about 2.3 bits to spare at the low end of the interval.

The 330 kept real prefixes were scanned against all tails (64,880,640 pairs):

```text
test   passing   cond log2   cum 95% interval      conditioned-sampler cum
dE16   8110142     -3.000    [-3.00, -3.00]        -3.000
dE17      3924    -11.013    [-14.06, -13.97]      -14.000
dA17      1996     -0.975    [-15.05, -14.93]      -15.000
dE18        38     -5.715    [-21.20, -20.25]      -21.006
dE19         0       -inf    [-inf, -24.07]        -27.918
```

Every conditioned-sampler value lies inside the real-prefix interval. At this sample
size, prefixes from true C32 outputs are indistinguishable from the uniform-state model
through step 18. Deeper stages could not be compared: about 0.3 dE19 passes were
expected.

### 12.9 What this section does and does not establish

Established exactly: the Section 3-6 finite objects and their hashes; the byte format
behind those hashes; the Section 5 regression vector; the Section 6 relation
corrections; and the two Lemmas of 12.2.

Measured, not proved: the staged pass rates of the trail through step 21; the
schedule factor F; the acceptance rate with fresh entropy; and the independence
check at shallow depth. These measurements come from HashRammers' own programs. They
are not organizer-recomputed experiments: a `python-message-pairs-v1` experiment
would have to fit the sandbox's 20-second, 128 MiB budget, and this machine has no
Docker to run one. The programs and their raw outputs are published with the
package source (HashRammers repository, `research/sha256-r32/`).

Not established: any full r32 collision; the average tail yield itself, which still
rests on the 12.6 premise and on uniformity of C32 outputs for the conditioned
sampler; and the starting-solution resource premise. The claim, the algorithm and
every resource bound remain those of Sections 7-10.
