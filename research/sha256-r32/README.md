# sha256-r32: independent reproduction and tail-yield measurement

Research content for the `sha256-r32-exploratory` RAM slot. `package/` is the HashSmash
candidate package the slot copies into its own clone and runs through HashSmash's real
`check` + `intake` (`server/lib/hashsmash.js`, `RESEARCH_CANDIDATES`).

`package/proof.md` sections 1-11 are the existing r32 package from the vendored HashSmash
repo, byte for byte. Section 12 and the updated heuristic/restriction text in
`package/claim.json` are ours. The claimed bound is unchanged (time 86, memory 39,
success 0.9). Nothing here is a collision, and nothing has been judged.

| File | What it is |
|---|---|
| `r32.c` | Independent C implementation of proof sections 3-6 (table, tails, filter) plus the staged yield measurement. `clang -O3 -o r32 r32.c -lpthread` |
| `trace.py` | Trace of the published second block in the proof's alternate notation; checks the row conventions and prints the trail differences |
| `analyze.py` | Turns the per-prefix records from `r32 yield` into the staged table with Poisson intervals |
| `results/` | Raw stdout of every run quoted in proof section 12 |

Reproduce (Apple M4, 10 cores; times are wall clock):

```sh
./r32 selftest                                        # ~1 s, counts + table/tail files whose SHA-256 match the proof
./r32 yield cond 1048576 5 20261005 cond.bin          # ~20 min, 2^37.6 prefix-tail pairs
./r32 yield real 240 4 0 real.bin                     # ~1 h, fresh OS entropy first blocks
./r32 schedfast 32768 <seed> sf.bin                   # schedule-only factor, per prefix
./r32 joint 65536 <seed>                              # independence check
python3 analyze.py cond.bin
```

`tests/hashsmash.test.js` compiles `r32.c` and asserts the selftest output against the
numbers printed in the proof.
