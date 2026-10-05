/*
 * r32.c - independent reimplementation of the HashSmash sha256-r32 exploratory
 * package's finite construction (fixed starting point, prefix table, tail set,
 * Section 5 first-block filter) plus a staged measurement of the second-block
 * tail yield, the package's weakest score-critical premise
 * ("fixed-slice-average-tail-yield": average over the 196,608 tails of the
 * probability of complete C32 second-block equality >= 2^-49).
 *
 * Everything here is derived from the package's own proof.md (sections 3-6)
 * and the published ePrint 2026/1080 witness reproduced in it. Nothing is
 * imported from the package authors' code (which is not in the repository).
 *
 * Build:  clang -O3 -march=native -o r32 r32.c -lpthread
 * Modes:
 *   ./r32 selftest                 build table + tails, print counts, write
 *                                  table/tail serializations to /tmp-free cwd
 *   ./r32 yield <mode> <n> <threads> <seed> <out.bin>
 *        mode = cond  : accepted prefixes from the conditioned uniform-state
 *                       sampler (package section 8, first method)
 *        mode = real  : accepted prefixes from genuinely random first blocks
 *                       B0 and real C32(IV,B0) (no state-uniformity model)
 *        seed = 0 uses arc4random (fresh OS entropy), otherwise xoshiro256**
 *        n = number of accepted prefixes to scan (all tails each)
 *   ./r32 sched <n> <seed>       schedule-only difference profile (dW16..dW31)
 *   ./r32 joint <n> <seed>       state-trail depth x schedule-match cross-tab (independence check)
 *   ./r32 schedfast <n> <seed> <out.bin>  same counts as sched, per prefix, W14-grouped (fast)
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <time.h>

typedef uint32_t u32;
typedef uint64_t u64;

static const u32 K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
static const u32 IV[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                          0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
static inline u32 S0(u32 a) { return ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22); }
static inline u32 S1(u32 e) { return ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25); }
static inline u32 s0(u32 x) { return ROR(x, 7) ^ ROR(x, 18) ^ (x >> 3); }
static inline u32 s1(u32 x) { return ROR(x, 17) ^ ROR(x, 19) ^ (x >> 10); }
static inline u32 IF(u32 x, u32 y, u32 z) { return (x & y) ^ (~x & z); }
static inline u32 MAJ(u32 x, u32 y, u32 z) { return (x & y) ^ (x & z) ^ (y & z); }

/* Standard reduced-round compression with feed-forward. */
static void compress(u32 out[8], const u32 cv[8], const u32 w16[16], int rounds) {
    u32 w[64];
    for (int i = 0; i < 16; i++) w[i] = w16[i];
    for (int i = 16; i < rounds; i++) w[i] = s1(w[i - 2]) + w[i - 7] + s0(w[i - 15]) + w[i - 16];
    u32 a = cv[0], b = cv[1], c = cv[2], d = cv[3], e = cv[4], f = cv[5], g = cv[6], h = cv[7];
    for (int i = 0; i < rounds; i++) {
        u32 t1 = h + S1(e) + IF(e, f, g) + K[i] + w[i];
        u32 t2 = S0(a) + MAJ(a, b, c);
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    out[0] = cv[0] + a; out[1] = cv[1] + b; out[2] = cv[2] + c; out[3] = cv[3] + d;
    out[4] = cv[4] + e; out[5] = cv[5] + f; out[6] = cv[6] + g; out[7] = cv[7] + h;
}

/* ---- Rows (leftmost char = bit 31) ---- */
typedef struct { u32 eqmask, v0mask, v0val, difmask, d0val; } row_t;
/* For a pair (x, x'): bits in eqmask must have x==x'; bits in v0mask must have x == v0val
 * (first branch value fixed); difmask bits must differ, with x == d0val on them. */
static row_t parse_row(const char *r) {
    row_t R = {0, 0, 0, 0, 0};
    for (int k = 0; k < 32; k++) {
        u32 bit = 1u << (31 - k);
        switch (r[k]) {
            case '=': R.eqmask |= bit; break;
            case '0': R.eqmask |= bit; R.v0mask |= bit; break;
            case '1': R.eqmask |= bit; R.v0mask |= bit; R.v0val |= bit; break;
            case 'u': R.difmask |= bit; break;             /* 0 -> 1 */
            case 'n': R.difmask |= bit; R.d0val |= bit; break; /* 1 -> 0 */
            default: fprintf(stderr, "bad row char\n"); exit(2);
        }
    }
    return R;
}
static inline int row_ok(const row_t *R, u32 x, u32 xp) {
    u32 d = x ^ xp;
    if (d & R->eqmask) return 0;
    if ((d & R->difmask) != R->difmask) return 0;
    if ((x & R->v0mask) != R->v0val) return 0;
    if ((x & R->difmask) != R->d0val) return 0;
    return 1;
}
static inline u32 bit(u32 x, int i) { return (x >> i) & 1; }

/* ---- Fixed starting point (proof section 3) ---- */
/* Arrays indexed by step; A[i], E[i] for the steps the package fixes. */
static u32 FA[2][16], FE[2][16], FW[2][16];
static void init_fixed(void) {
    const u32 A[13] = {0x66e7ba7c, 0x5ff9d9f8, 0x9123b13f, 0xb8560dbb, 0x677e1e2a, 0x9bcf7bbe, 0xf8677ad6,
                       0x4a299906, 0x44d24ab4, 0x39781650, 0x6c206d58, 0x35c5c2b8, 0x0508c8f0};
    const u32 Ap[13] = {0x66e7ba7c, 0x5ff9d9f8, 0x9123b13f, 0x98560dbb, 0x633b16ba, 0x9bcf7bbe, 0xf8677ad6,
                        0x4a299906, 0x44f24ab5, 0x39781650, 0x6422edc8, 0x574542b8, 0x0508c8f0};
    const u32 E[9] = {0x58f38fac, 0xb95f2294, 0x87431160, 0x11cae594, 0xd504bf23, 0x7f27d24c, 0xbf893f69,
                      0x2300f189, 0xfcc08ef5};
    const u32 Ep[9] = {0x5caf87bc, 0xa94f0a01, 0xa7421160, 0xf1cae594, 0xd0e1b7b4, 0xbf27d74c, 0xb78bbfd9,
                       0x3fffd0f9, 0xbf81c0f4};
    const u32 W[5] = {0x5100da8a, 0x0912e57b, 0xa96b2054, 0x45f2222c, 0x4d12f88a};
    const u32 Wp[5] = {0x5100da8a, 0x0912e57b, 0xa96b2054, 0x41b22a2c, 0x6d12f88a};
    for (int i = 1; i <= 13; i++) { FA[0][i] = A[i - 1]; FA[1][i] = Ap[i - 1]; }
    for (int i = 5; i <= 13; i++) { FE[0][i] = E[i - 5]; FE[1][i] = Ep[i - 5]; }
    for (int i = 9; i <= 13; i++) { FW[0][i] = W[i - 9]; FW[1][i] = Wp[i - 9]; }
}

#define DW7 0x0101108au
#define DW8 0x00080c00u

/* ---- Prefix table (proof section 4) ---- */
typedef struct { u32 am1, w7, w8, e3, e4, a0; } rec_t;
static rec_t *TABLE; static size_t NTAB;
static u32 *KEYIDX; /* direct index over 2^32 keys would be 16 GiB; use a hash instead */
/* open-addressing hash: key -> first index into sorted TABLE */
static u32 *HKEY; static u32 *HPOS; static u32 HMASK;

static int cmp_rec(const void *a, const void *b) {
    const u32 *x = a, *y = b;
    for (int i = 0; i < 6; i++) { if (x[i] < y[i]) return -1; if (x[i] > y[i]) return 1; }
    return 0;
}

static row_t R_E3, R_E4, R_W7, R_W8, R_W4, R_W5, R_W6, R_E14, R_E15, R_A14, R_A15;
static size_t n_w7_adm, n_w8_adm, n_w8_surv;

static int w8_rel(u32 w) {
    if (bit(w, 0) != bit(w, 28) || bit(w, 14) != bit(w, 25) || bit(w, 21) != bit(w, 6)) return 0;
    const int l[6] = {31, 23, 30, 15, 22, 8}, r[6] = {27, 2, 15, 26, 7, 4};
    for (int i = 0; i < 6; i++) if (bit(w, l[i]) == bit(w, r[i])) return 0;
    return 1;
}
static int w7_rel(u32 w) {
    const int l1[3] = {22, 13, 23}, r1[3] = {18, 9, 8};
    for (int i = 0; i < 3; i++) if (bit(w, l1[i]) == bit(w, r1[i])) return 0;
    const int l2[3] = {11, 14, 20}, r2[3] = {22, 31, 31};
    for (int i = 0; i < 3; i++) if (bit(w, l2[i]) != bit(w, r2[i])) return 0;
    return 1;
}

static void build_table(void) {
    /* admissible W7 / W8 path-one values: enumerate the free ('=') bits, fixed bits from row */
    u32 *w7s = malloc(sizeof(u32) << 20), *w8s = malloc(sizeof(u32) << 21);
    size_t n7 = 0, n8 = 0;
    u32 free7 = R_W7.eqmask & ~R_W7.v0mask, free8 = R_W8.eqmask & ~R_W8.v0mask;
    /* subset enumeration of free bits */
    u32 s = 0;
    do {
        u32 w = s | R_W7.v0val | R_W7.d0val;
        if (row_ok(&R_W7, w, w ^ DW7) && w7_rel(w)) w7s[n7++] = w;
        s = (s - free7) & free7;
    } while (s);
    s = 0;
    do {
        u32 w = s | R_W8.v0val | R_W8.d0val;
        if (row_ok(&R_W8, w, w ^ DW8) && w8_rel(w)) w8s[n8++] = w;
        s = (s - free8) & free8;
    } while (s);
    n_w7_adm = n7; n_w8_adm = n8;

    size_t cap = 1 << 21; TABLE = malloc(cap * sizeof(rec_t)); NTAB = 0; n_w8_surv = 0;
    for (size_t j = 0; j < n8; j++) {
        u32 e4[2], a0[2], w8[2] = {w8s[j], w8s[j] ^ DW8};
        for (int b = 0; b < 2; b++) {
            const u32 *A = FA[b], *E = FE[b];
            e4[b] = E[8] - A[4] - S1(E[7]) - IF(E[7], E[6], E[5]) - K[8] - w8[b];
            a0[b] = e4[b] + S0(A[3]) + MAJ(A[3], A[2], A[1]) - A[4];
        }
        if (!row_ok(&R_E4, e4[0], e4[1])) continue;
        if (bit(e4[0], 10) == bit(e4[0], 15)) continue;
        if (a0[0] != a0[1]) continue;
        n_w8_surv++;
        for (size_t i = 0; i < n7; i++) {
            u32 w7[2] = {w7s[i], w7s[i] ^ DW7}, e3[2], am1[2];
            for (int b = 0; b < 2; b++) {
                const u32 *A = FA[b], *E = FE[b];
                u32 E4 = e4[b];
                e3[b] = E[7] - A[3] - S1(E[6]) - IF(E[6], E[5], E4) - K[7] - w7[b];
                am1[b] = e3[b] + S0(A[2]) + MAJ(A[2], A[1], a0[b]) - A[3];
            }
            if (!row_ok(&R_E3, e3[0], e3[1])) continue;
            if (am1[0] != am1[1]) continue;
            if (NTAB == cap) { cap *= 2; TABLE = realloc(TABLE, cap * sizeof(rec_t)); }
            TABLE[NTAB++] = (rec_t){am1[0], w7[0], w8[0], e3[0], e4[0], a0[0]};
        }
    }
    qsort(TABLE, NTAB, sizeof(rec_t), cmp_rec);
    free(w7s); free(w8s);
    /* hash index */
    HMASK = (1u << 21) - 1;
    HKEY = malloc(sizeof(u32) << 21); HPOS = malloc(sizeof(u32) << 21);
    memset(HPOS, 0xff, sizeof(u32) << 21);
    for (size_t i = 0; i < NTAB; i++) {
        if (i && TABLE[i].am1 == TABLE[i - 1].am1) continue;
        u32 k = TABLE[i].am1, h = (k * 0x9E3779B1u) & HMASK;
        while (HPOS[h] != 0xffffffffu) h = (h + 1) & HMASK;
        HKEY[h] = k; HPOS[h] = (u32)i;
    }
    (void)KEYIDX;
}
static inline long lookup(u32 key) {
    u32 h = (key * 0x9E3779B1u) & HMASK;
    while (HPOS[h] != 0xffffffffu) { if (HKEY[h] == key) return HPOS[h]; h = (h + 1) & HMASK; }
    return -1;
}

/* ---- Tails (proof section 6) ---- */
typedef struct { u32 w14, w15; } tail_t;
static tail_t *TAILS; static size_t NTAIL; static size_t n_w14_adm;
/* per-tail derived states (prefix independent): A14,A15,E14,E15 both branches */
static u32 (*TST)[2][4];

static int cmp_tail(const void *a, const void *b) {
    const tail_t *x = a, *y = b;
    if (x->w14 != y->w14) return x->w14 < y->w14 ? -1 : 1;
    if (x->w15 != y->w15) return x->w15 < y->w15 ? -1 : 1;
    return 0;
}

static int tail_relations = 1; /* 1 = corrected inequalities (package), 0 = printed equalities */

static void build_tails(void) {
    size_t cap = 1 << 18; TAILS = malloc(cap * sizeof(tail_t)); NTAIL = 0; n_w14_adm = 0;
    u32 free14 = R_E14.eqmask & ~R_E14.v0mask, free15 = R_E15.eqmask & ~R_E15.v0mask;
    u32 s = 0;
    do {
        u32 e14[2], w14[2], a14[2];
        e14[0] = s | R_E14.v0val | R_E14.d0val; e14[1] = e14[0] ^ R_E14.difmask;
        for (int b = 0; b < 2; b++) {
            const u32 *A = FA[b], *E = FE[b];
            w14[b] = e14[b] - A[10] - E[10] - S1(E[13]) - IF(E[13], E[12], E[11]) - K[14];
            a14[b] = e14[b] - A[10] + S0(A[13]) + MAJ(A[13], A[12], A[11]);
        }
        int ok = row_ok(&R_E14, e14[0], e14[1]) && w14[0] == w14[1] && row_ok(&R_A14, a14[0], a14[1]);
        if (ok) {
            /* A14[18,8] (relation) A14[6,17] */
            int ne = bit(a14[0], 18) != bit(a14[0], 6) && bit(a14[0], 8) != bit(a14[0], 17);
            int eq = bit(a14[0], 18) == bit(a14[0], 6) && bit(a14[0], 8) == bit(a14[0], 17);
            ok = tail_relations ? ne : eq;
        }
        if (ok) {
            n_w14_adm++;
            u32 t = 0;
            do {
                u32 e15[2], w15[2], a15[2];
                e15[0] = t | R_E15.v0val | R_E15.d0val; e15[1] = e15[0] ^ R_E15.difmask;
                for (int b = 0; b < 2; b++) {
                    const u32 *A = FA[b], *E = FE[b];
                    w15[b] = e15[b] - A[11] - E[11] - S1(e14[b]) - IF(e14[b], E[13], E[12]) - K[15];
                    a15[b] = e15[b] - A[11] + S0(a14[b]) + MAJ(a14[b], A[13], A[12]);
                }
                int ok2 = w15[0] == w15[1] && row_ok(&R_A15, a15[0], a15[1]);
                if (ok2) ok2 = tail_relations ? (bit(a15[0], 29) != bit(FA[0][6], 29))
                                              : (bit(a15[0], 29) == bit(FA[0][6], 29));
                if (ok2) {
                    if (NTAIL == cap) { cap *= 2; TAILS = realloc(TAILS, cap * sizeof(tail_t)); }
                    TAILS[NTAIL++] = (tail_t){w14[0], w15[0]};
                }
                t = (t - free15) & free15;
            } while (t);
        }
        s = (s - free14) & free14;
    } while (s);
    qsort(TAILS, NTAIL, sizeof(tail_t), cmp_tail);
}

/* ---- Section 5 filter ---- */
/* Given CV, find the lexicographically first valid record; fill W0..W15 both
 * branches except W14/W15 (left 0). Returns 1 if accepted. */
static int filter(const u32 cv[8], u32 W[2][16], rec_t *chosen) {
    long pos = lookup(cv[0]);
    if (pos < 0) return 0;
    for (size_t r = (size_t)pos; r < NTAB && TABLE[r].am1 == cv[0]; r++) {
        const rec_t *R = &TABLE[r];
        u32 Aa[2][20], Ee[2][20]; /* index i+4 for step i, i in -4..12 */
#define AA(b, i) Aa[b][(i) + 4]
#define EE(b, i) Ee[b][(i) + 4]
        u32 w[2][7];
        for (int b = 0; b < 2; b++) {
            AA(b, -1) = cv[0]; AA(b, -2) = cv[1]; AA(b, -3) = cv[2]; AA(b, -4) = cv[3];
            EE(b, -1) = cv[4]; EE(b, -2) = cv[5]; EE(b, -3) = cv[6]; EE(b, -4) = cv[7];
            AA(b, 0) = R->a0;
            for (int i = 1; i <= 3; i++) AA(b, i) = FA[b][i];
            EE(b, 2) = AA(b, 2) + AA(b, -2) - S0(AA(b, 1)) - MAJ(AA(b, 1), AA(b, 0), AA(b, -1));
            EE(b, 1) = AA(b, 1) + AA(b, -3) - S0(AA(b, 0)) - MAJ(AA(b, 0), AA(b, -1), AA(b, -2));
            EE(b, 0) = AA(b, 0) + AA(b, -4) - S0(AA(b, -1)) - MAJ(AA(b, -1), AA(b, -2), AA(b, -3));
            EE(b, 3) = R->e3;
            EE(b, 4) = b ? (R->e4 ^ R_E4.difmask) : R->e4;
            EE(b, 5) = FE[b][5]; EE(b, 6) = FE[b][6];
            for (int i = 4; i <= 6; i++) AA(b, i) = FA[b][i];
            for (int i = 0; i <= 6; i++)
                w[b][i] = EE(b, i) - AA(b, i - 4) - EE(b, i - 4) - S1(EE(b, i - 1)) -
                          IF(EE(b, i - 1), EE(b, i - 2), EE(b, i - 3)) - K[i];
        }
        int ok = 1;
        for (int i = 0; i < 4; i++) if (w[0][i] != w[1][i]) ok = 0;
        if (!ok) continue;
        u32 w4 = w[0][4], w5 = w[0][5], w6 = w[0][6];
        if (!row_ok(&R_W4, w4, w[1][4])) continue;
        if (!(bit(w4, 1) != bit(w4, 12) && bit(w4, 8) != bit(w4, 25) && bit(w4, 18) == bit(w4, 14))) continue;
        if (!row_ok(&R_W5, w5, w[1][5])) continue;
        if (!(bit(w5, 0) == bit(w5, 28) && bit(w5, 1) == bit(w5, 18) && bit(w5, 30) == bit(w5, 9))) continue;
        if (!row_ok(&R_W6, w6, w[1][6])) continue;
        if (!(bit(w6, 1) == bit(w6, 12) && bit(w6, 8) == bit(w6, 25) && bit(w6, 18) != bit(w6, 14))) continue;
        for (int b = 0; b < 2; b++) {
            for (int i = 0; i <= 6; i++) W[b][i] = w[b][i];
            W[b][7] = b ? R->w7 ^ DW7 : R->w7;
            W[b][8] = b ? R->w8 ^ DW8 : R->w8;
            for (int i = 9; i <= 13; i++) W[b][i] = FW[b][i];
            W[b][14] = W[b][15] = 0;
        }
        if (chosen) *chosen = *R;
        return 1;
    }
    return 0;
}

/* Replays the prefix steps 0..13 from cv and checks the fixed states (section 5 last para). */
static int replay_prefix_ok(const u32 cv[8], u32 W[2][16]) {
    for (int b = 0; b < 2; b++) {
        u32 A[24], E[24];
        A[3] = cv[0]; A[2] = cv[1]; A[1] = cv[2]; A[0] = cv[3];
        E[3] = cv[4]; E[2] = cv[5]; E[1] = cv[6]; E[0] = cv[7];
        for (int i = 0; i <= 13; i++) {
            int j = i + 4;
            E[j] = A[j - 4] + E[j - 4] + S1(E[j - 1]) + IF(E[j - 1], E[j - 2], E[j - 3]) + K[i] + W[b][i];
            A[j] = E[j] - A[j - 4] + S0(A[j - 1]) + MAJ(A[j - 1], A[j - 2], A[j - 3]);
        }
        for (int i = 1; i <= 13; i++) if (A[i + 4] != FA[b][i]) return 0;
        for (int i = 5; i <= 13; i++) if (E[i + 4] != FE[b][i]) return 0;
    }
    return 1;
}

/* ---- Published trail differences (from trace.py on the published witness) ---- */
static u32 TDA[35], TDE[35], TDW[35];
static void init_trail(void) {
    memset(TDA, 0, sizeof TDA); memset(TDE, 0, sizeof TDE); memset(TDW, 0, sizeof TDW);
    TDA[14] = 0x20000000; TDE[15] = 0x00040010; TDE[16] = 0x02808000; TDE[18] = 0x20000000;
    TDW[20] = 0x01808000; TDW[22] = 0x20000000;
}

/* Check index layout per step k=16..31: 3*(k-16)+{0:dW,1:dE,2:dA}. 48 checks.
 * Value 48 = followed the trail through step 31. Separately: full C32 equality. */
#define NCHK 48

/* Scan all tails for one accepted prefix. hist[c] += number of tails whose first
 * failed check is c (c==NCHK means none failed). Returns number of full C32
 * second-block collisions (only tested for tails that follow the trail to step 22;
 * tails leaving the trail earlier are counted as non-collisions: a conservative
 * undercount of the yield). */
static u64 (*JOINT)[2] = NULL; /* optional: JOINT[fail][schedule_ok] for pairs past check 5 */
static int sched_ok_pair(u32 W[2][16], size_t t);
static u64 scan_tails(const u32 cv[8], u32 W[2][16], u64 *hist, u32 *perprefix) {
    /* precompute state at end of step 13 (fixed) as A10..A13,E10..E13 both branches */
    u64 coll = 0;
    for (size_t t = 0; t < NTAIL; t++) {
        u32 w[2][32];
        u32 A[2][32 + 4], E[2][32 + 4];
        int fail = NCHK;
        for (int b = 0; b < 2; b++) {
            for (int i = 0; i < 14; i++) w[b][i] = W[b][i];
            w[b][14] = TAILS[t].w14; w[b][15] = TAILS[t].w15;
            for (int i = 10; i <= 13; i++) { A[b][i + 4] = FA[b][i]; E[b][i + 4] = FE[b][i]; }
            A[b][14 + 4] = TST[t][b][0]; A[b][15 + 4] = TST[t][b][1];
            E[b][14 + 4] = TST[t][b][2]; E[b][15 + 4] = TST[t][b][3];
        }
        for (int k = 16; k < 32 && fail == NCHK; k++) {
            int j = k + 4;
            for (int b = 0; b < 2; b++)
                w[b][k] = s1(w[b][k - 2]) + w[b][k - 7] + s0(w[b][k - 15]) + w[b][k - 16];
            if ((w[0][k] ^ w[1][k]) != TDW[k]) { fail = 3 * (k - 16); break; }
            for (int b = 0; b < 2; b++)
                E[b][j] = A[b][j - 4] + E[b][j - 4] + S1(E[b][j - 1]) + IF(E[b][j - 1], E[b][j - 2], E[b][j - 3]) + K[k] + w[b][k];
            if ((E[0][j] ^ E[1][j]) != TDE[k]) { fail = 3 * (k - 16) + 1; break; }
            for (int b = 0; b < 2; b++)
                A[b][j] = E[b][j] - A[b][j - 4] + S0(A[b][j - 1]) + MAJ(A[b][j - 1], A[b][j - 2], A[b][j - 3]);
            if ((A[0][j] ^ A[1][j]) != TDA[k]) { fail = 3 * (k - 16) + 2; break; }
        }
        hist[fail]++;
        if (perprefix) perprefix[fail]++;
        if (JOINT && fail > 5) JOINT[fail][sched_ok_pair(W, t)]++;
        if (fail > 3 * (22 - 16) + 2) {
            /* followed through step 22: test the exact event with the plain compression */
            u32 o0[8], o1[8], m0[16], m1[16];
            for (int i = 0; i < 16; i++) { m0[i] = w[0][i]; m1[i] = w[1][i]; }
            compress(o0, cv, m0, 32); compress(o1, cv, m1, 32);
            if (!memcmp(o0, o1, sizeof o0)) coll++;
        }
    }
    return coll;
}


/* Schedule-only measurement: for every (prefix, tail) pair, the first k in 16..31
 * with (W_k xor W'_k) != published trail difference. Index 16 = none failed. */
static void sched_scan(u32 W[2][16], u64 *h) {
    for (size_t t = 0; t < NTAIL; t++) {
        u32 w[2][32]; int fail = 16;
        for (int b = 0; b < 2; b++) { for (int i = 0; i < 14; i++) w[b][i] = W[b][i]; w[b][14] = TAILS[t].w14; w[b][15] = TAILS[t].w15; }
        for (int k = 16; k < 32; k++) {
            for (int b = 0; b < 2; b++) w[b][k] = s1(w[b][k - 2]) + w[b][k - 7] + s0(w[b][k - 15]) + w[b][k - 16];
            if ((w[0][k] ^ w[1][k]) != TDW[k]) { fail = k - 16; break; }
        }
        h[fail]++;
    }
}

static int sched_ok_pair(u32 W[2][16], size_t t) {
    u32 w[2][32];
    for (int b = 0; b < 2; b++) { for (int i = 0; i < 14; i++) w[b][i] = W[b][i]; w[b][14] = TAILS[t].w14; w[b][15] = TAILS[t].w15; }
    for (int k = 16; k < 32; k++) {
        for (int b = 0; b < 2; b++) w[b][k] = s1(w[b][k - 2]) + w[b][k - 7] + s0(w[b][k - 15]) + w[b][k - 16];
        if ((w[0][k] ^ w[1][k]) != TDW[k]) return 0;
    }
    return 1;
}

/* Fast exact schedule-only count for one prefix. W16, W18 and W20 depend on the
 * tail only through W14 (tails are sorted by W14, 16,384 per group), so a whole
 * W14 group is skipped when dW20 fails. dW16..dW19 have zero target difference,
 * hence are carry-independent and are checked exactly on the group's first tail.
 * Returns the number of tails whose schedule matches the trail on dW16..dW31;
 * *n20 gets the number passing dW16..dW20. */
static u64 sched_prefix_fast(u32 W[2][16], u64 *n20) {
    u64 ok = 0; *n20 = 0;
    size_t t = 0;
    while (t < NTAIL) {
        size_t end = t;
        while (end < NTAIL && TAILS[end].w14 == TAILS[t].w14) end++;
        u32 w[2][32];
        for (int b = 0; b < 2; b++) { for (int i = 0; i < 14; i++) w[b][i] = W[b][i]; w[b][14] = TAILS[t].w14; w[b][15] = TAILS[t].w15; }
        int pass = 1;
        for (int k = 16; k <= 20 && pass; k++) {
            for (int b = 0; b < 2; b++) w[b][k] = s1(w[b][k - 2]) + w[b][k - 7] + s0(w[b][k - 15]) + w[b][k - 16];
            if ((w[0][k] ^ w[1][k]) != TDW[k]) pass = 0;
        }
        if (pass) {
            *n20 += end - t;
            for (size_t u = t; u < end; u++) ok += sched_ok_pair(W, u);
        }
        t = end;
    }
    return ok;
}

/* ---- RNG ---- */
typedef struct { u64 s[4]; int os; } rng_t;
static inline u64 rotl(u64 x, int k) { return (x << k) | (x >> (64 - k)); }
static u64 splitmix(u64 *x) { u64 z = (*x += 0x9e3779b97f4a7c15ULL); z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL; z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL; return z ^ (z >> 31); }
static void rng_seed(rng_t *r, u64 seed, int thread) {
    r->os = (seed == 0);
    u64 x = seed * 0x100000001b3ULL + (u64)thread * 0x9e3779b97f4a7c15ULL + 12345;
    for (int i = 0; i < 4; i++) r->s[i] = splitmix(&x);
}
static inline u64 rng_next(rng_t *r) {
    if (r->os) { u64 v; arc4random_buf(&v, sizeof v); return v; }
    u64 *s = r->s, res = rotl(s[1] * 5, 7) * 9, t = s[1] << 17;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], 45);
    return res;
}
/* arc4random per word is slow; buffer it */
typedef struct { rng_t r; u32 buf[1024]; int n; } wrng_t;
static inline u32 wnext(wrng_t *g) {
    if (g->n == 0) {
        if (g->r.os) arc4random_buf(g->buf, sizeof g->buf);
        else for (int i = 0; i < 1024; i += 2) { u64 v = rng_next(&g->r); g->buf[i] = (u32)v; g->buf[i + 1] = (u32)(v >> 32); }
        g->n = 1024;
    }
    return g->buf[--g->n];
}

/* ---- Yield experiment ---- */
typedef struct {
    int id, mode; u64 seed; u64 target; volatile u64 *done; pthread_mutex_t *mu;
    u64 hist[NCHK + 1]; u64 coll; u64 prefixes; u64 samples; u64 badreplay;
    FILE *out;
} job_t;

static u32 KEYS[1 << 19]; static size_t NKEYS;

static void *worker(void *arg) {
    job_t *J = arg;
    wrng_t g; memset(&g, 0, sizeof g); rng_seed(&g.r, J->seed, J->id);
    u32 per[NCHK + 1];
    for (;;) {
        u32 cv[8], W[2][16];
        int acc = 0;
        while (!acc) {
            J->samples++;
            if (J->mode == 0) {
                /* conditioned uniform-state sampler: uniform key from the table keys, other 7 words uniform */
                u32 r = wnext(&g);
                cv[0] = KEYS[(u64)r * NKEYS >> 32];
                for (int i = 1; i < 8; i++) cv[i] = wnext(&g);
            } else {
                u32 b0[16];
                for (int i = 0; i < 16; i++) b0[i] = wnext(&g);
                compress(cv, IV, b0, 32);
            }
            acc = filter(cv, W, NULL);
        }
        if (!replay_prefix_ok(cv, W)) { J->badreplay++; continue; }
        pthread_mutex_lock(J->mu);
        if (*J->done >= J->target) { pthread_mutex_unlock(J->mu); break; }
        (*J->done)++;
        pthread_mutex_unlock(J->mu);
        memset(per, 0, sizeof per);
        J->coll += scan_tails(cv, W, J->hist, per);
        J->prefixes++;
        pthread_mutex_lock(J->mu);
        if (J->out) {
            /* per-prefix record: cv[8], W0..W8 branch0, histogram[49] */
            fwrite(cv, sizeof(u32), 8, J->out);
            fwrite(W[0], sizeof(u32), 9, J->out);
            fwrite(per, sizeof(u32), NCHK + 1, J->out);
        }
        pthread_mutex_unlock(J->mu);
    }
    return NULL;
}

static void init_rows(void) {
    R_E3 = parse_row("=====1=====011======0======0====");
    R_E4 = parse_row("==n0=0=1===100=0==0=1===0==1=0=1");
    R_W7 = parse_row("=======n=======u===u====u=1=u=u=");
    R_W8 = parse_row("============u=======uu==========");
    R_W4 = parse_row("==n=============================");
    R_W5 = parse_row("=====u===u==========n===========");
    R_W6 = parse_row("==n=============================");
    R_E14 = parse_row("=0=100110000000=101=0000=110===0");
    R_E15 = parse_row("=1====0011===u10001=011===0n===1");
    R_A14 = parse_row("==u=============================");
    R_A15 = parse_row("================================");
}

static void prepare_tail_states(void) {
    TST = malloc(NTAIL * sizeof *TST);
    for (size_t t = 0; t < NTAIL; t++) {
        for (int b = 0; b < 2; b++) {
            const u32 *A = FA[b], *E = FE[b];
            u32 w14 = TAILS[t].w14, w15 = TAILS[t].w15;
            u32 e14 = A[10] + E[10] + S1(E[13]) + IF(E[13], E[12], E[11]) + K[14] + w14;
            u32 a14 = e14 - A[10] + S0(A[13]) + MAJ(A[13], A[12], A[11]);
            u32 e15 = A[11] + E[11] + S1(e14) + IF(e14, E[13], E[12]) + K[15] + w15;
            u32 a15 = e15 - A[11] + S0(a14) + MAJ(a14, A[13], A[12]);
            TST[t][b][0] = a14; TST[t][b][1] = a15; TST[t][b][2] = e14; TST[t][b][3] = e15;
        }
    }
}

static void setup(void) {
    init_rows(); init_fixed(); init_trail();
    build_table(); build_tails(); prepare_tail_states();
    NKEYS = 0;
    for (size_t i = 0; i < NTAB; i++) if (!i || TABLE[i].am1 != TABLE[i - 1].am1) KEYS[NKEYS++] = TABLE[i].am1;
}

static void put_be(FILE *f, u32 x) { fputc(x >> 24, f); fputc(x >> 16, f); fputc(x >> 8, f); fputc(x, f); }
static void put_le(FILE *f, u32 x) { fputc(x, f); fputc(x >> 8, f); fputc(x >> 16, f); fputc(x >> 24, f); }

static int selftest(void) {
    setup();
    size_t maxper = 0, run = 0;
    for (size_t i = 0; i < NTAB; i++) {
        run = (i && TABLE[i].am1 == TABLE[i - 1].am1) ? run + 1 : 1;
        if (run > maxper) maxper = run;
    }
    printf("admissible W7 %zu\nadmissible W8 %zu\nsurviving (W8,E4,A0) %zu\n", n_w7_adm, n_w8_adm, n_w8_surv);
    printf("table records %zu\ndistinct A(-1) keys %zu\nmax records per key %zu\n", NTAB, NKEYS, maxper);
    printf("admissible W14 %zu\ntails %zu\n", n_w14_adm, NTAIL);
    int pub = 0;
    for (size_t i = 0; i < NTAB; i++)
        if (TABLE[i].am1 == 0xc4369610 && TABLE[i].w7 == 0xdb9ec665 && TABLE[i].w8 == 0x6ec17218 &&
            TABLE[i].e3 == 0xa70d4308 && TABLE[i].e4 == 0x2932d839 && TABLE[i].a0 == 0xac311f10) pub = 1;
    printf("published record present %d\n", pub);
    int pubtail = 0;
    for (size_t t = 0; t < NTAIL; t++) if (TAILS[t].w14 == 0xd2701ecc && TAILS[t].w15 == 0x140976d1) pubtail = 1;
    printf("published tail present %d\n", pubtail);
    FILE *f;
    f = fopen("table_be.bin", "wb"); for (size_t i = 0; i < NTAB; i++) { const u32 *r = (const u32 *)&TABLE[i]; for (int k = 0; k < 6; k++) put_be(f, r[k]); } fclose(f);
    f = fopen("table_le.bin", "wb"); for (size_t i = 0; i < NTAB; i++) { const u32 *r = (const u32 *)&TABLE[i]; for (int k = 0; k < 6; k++) put_le(f, r[k]); } fclose(f);
    f = fopen("tails_be.bin", "wb"); for (size_t t = 0; t < NTAIL; t++) { put_be(f, TAILS[t].w14); put_be(f, TAILS[t].w15); } fclose(f);
    f = fopen("tails_le.bin", "wb"); for (size_t t = 0; t < NTAIL; t++) { put_le(f, TAILS[t].w14); put_le(f, TAILS[t].w15); } fclose(f);

    /* regression vector (proof section 5) */
    u32 cv[8] = {0xf3b8f7ae, 0x23d7ad68, 0xc61d47d1, 0xdeda8ba2, 0x8b60fb6e, 0x96529cbd, 0x3907ddc0, 0xde6affc9};
    u32 W[2][16]; rec_t R;
    int acc = filter(cv, W, &R);
    printf("regression accepted %d record %08x %08x %08x %08x %08x %08x replay %d\n", acc, R.am1, R.w7, R.w8, R.e3, R.e4, R.a0, acc ? replay_prefix_ok(cv, W) : 0);
    for (int b = 0; b < 2; b++) { printf("  W%s:", b ? "'" : " "); for (int i = 0; i < 14; i++) printf(" %08x", W[b][i]); printf("\n"); }

    /* exhaustive tail scan from the published C35 chaining value (section 6 check) */
    u32 cv35[8] = {0xc4369610, 0xc91f70a7, 0x87e430e6, 0xa5e58128, 0xd29cb97b, 0x9ab268d1, 0x8788f401, 0x629f6cb2};
    u32 Wp[2][16] = {
        {0xc0008214, 0xae65f3bf, 0xe93c006a, 0x5f195aa9, 0xa4d6cd0f, 0x21811cec, 0xea897317, 0xdb9ec665,
         0x6ec17218, 0x5100da8a, 0x0912e57b, 0xa96b2054, 0x45f2222c, 0x4d12f88a, 0, 0},
        {0xc0008214, 0xae65f3bf, 0xe93c006a, 0x5f195aa9, 0x84d6cd0f, 0x25c114ec, 0xca897317, 0xda9fd6ef,
         0x6ec97e18, 0x5100da8a, 0x0912e57b, 0xa96b2054, 0x41b22a2c, 0x6d12f88a, 0, 0}};
    int c32 = 0, c35 = 0;
    for (size_t t = 0; t < NTAIL; t++) {
        u32 m0[16], m1[16], o0[8], o1[8];
        memcpy(m0, Wp[0], 64); memcpy(m1, Wp[1], 64);
        m0[14] = m1[14] = TAILS[t].w14; m0[15] = m1[15] = TAILS[t].w15;
        compress(o0, cv35, m0, 32); compress(o1, cv35, m1, 32); if (!memcmp(o0, o1, 32)) c32++;
        compress(o0, cv35, m0, 35); compress(o1, cv35, m1, 35); if (!memcmp(o0, o1, 32)) c35++;
    }
    printf("published-CV exhaustive tail scan: C32 collisions %d, C35 collisions %d\n", c32, c35);
    u64 hist[NCHK + 1] = {0};
    u64 cc = scan_tails(cv35, Wp, hist, NULL);
    printf("staged scanner on published CV: full-trail %llu, C32 collisions %llu\n", (unsigned long long)hist[NCHK], (unsigned long long)cc);
    tail_relations = 0; build_tails();
    printf("tails with the printed (uncorrected) equalities: %zu\n", NTAIL);
    return 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "selftest")) return selftest();
    if (argc >= 4 && !strcmp(argv[1], "sched")) {
        u64 n = strtoull(argv[2], 0, 10), seed = strtoull(argv[3], 0, 10);
        setup();
        wrng_t g; memset(&g, 0, sizeof g); rng_seed(&g.r, seed, 0);
        u64 h[17] = {0}, pre = 0;
        while (pre < n) {
            u32 cv[8], W[2][16];
            cv[0] = KEYS[(u64)wnext(&g) * NKEYS >> 32];
            for (int i = 1; i < 8; i++) cv[i] = wnext(&g);
            if (!filter(cv, W, NULL)) continue;
            sched_scan(W, h); pre++;
        }
        u64 surv = pre * NTAIL;
        printf("sched mode seed %llu prefixes %llu pairs %llu\n", (unsigned long long)seed, (unsigned long long)pre, (unsigned long long)surv);
        for (int k = 0; k < 16; k++) { u64 after = surv - h[k]; printf("dW%d  in %llu pass %llu\n", 16 + k, (unsigned long long)surv, (unsigned long long)after); surv = after; }
        return 0;
    }
    if (argc >= 5 && !strcmp(argv[1], "schedfast")) {
        /* schedfast <n> <seed> <out.bin>: per-prefix (n20, nall) as two u64 */
        u64 n = strtoull(argv[2], 0, 10), seed = strtoull(argv[3], 0, 10);
        setup();
        FILE *out = fopen(argv[4], "wb");
        wrng_t g; memset(&g, 0, sizeof g); rng_seed(&g.r, seed, 0);
        u64 pre = 0, s20 = 0, sall = 0;
        while (pre < n) {
            u32 cv[8], W[2][16];
            cv[0] = KEYS[(u64)wnext(&g) * NKEYS >> 32];
            for (int i = 1; i < 8; i++) cv[i] = wnext(&g);
            if (!filter(cv, W, NULL)) continue;
            u64 n20, all = sched_prefix_fast(W, &n20);
            u64 rec[2] = {n20, all}; fwrite(rec, sizeof rec, 1, out);
            s20 += n20; sall += all; pre++;
        }
        fclose(out);
        printf("schedfast seed %llu prefixes %llu pairs %llu dW20-pass %llu all-pass %llu\n", (unsigned long long)seed,
               (unsigned long long)pre, (unsigned long long)(pre * NTAIL), (unsigned long long)s20, (unsigned long long)sall);
        return 0;
    }
    if (argc >= 4 && !strcmp(argv[1], "joint")) {
        /* joint <n> <seed>: conditioned prefixes; for pairs that pass the step-17 checks,
         * cross-tabulate how far the state trail gets vs whether the schedule alone
         * matches the published trail on dW16..dW31. Tests the independence premise. */
        u64 n = strtoull(argv[2], 0, 10), seed = strtoull(argv[3], 0, 10);
        setup();
        static u64 joint[NCHK + 1][2]; JOINT = joint;
        wrng_t g; memset(&g, 0, sizeof g); rng_seed(&g.r, seed, 0);
        u64 hist[NCHK + 1] = {0}, pre = 0, coll = 0;
        while (pre < n) {
            u32 cv[8], W[2][16];
            cv[0] = KEYS[(u64)wnext(&g) * NKEYS >> 32];
            for (int i = 1; i < 8; i++) cv[i] = wnext(&g);
            if (!filter(cv, W, NULL)) continue;
            coll += scan_tails(cv, W, hist, NULL); pre++;
        }
        printf("joint seed %llu prefixes %llu collisions %llu\n", (unsigned long long)seed, (unsigned long long)pre, (unsigned long long)coll);
        for (int c = 6; c <= NCHK; c++) printf("fail %d sched_bad %llu sched_ok %llu\n", c, (unsigned long long)joint[c][0], (unsigned long long)joint[c][1]);
        return 0;
    }
    if (argc >= 7 && !strcmp(argv[1], "yield")) {
        int mode = !strcmp(argv[2], "real");
        u64 n = strtoull(argv[3], 0, 10); int th = atoi(argv[4]); u64 seed = strtoull(argv[5], 0, 10);
        setup();
        FILE *out = fopen(argv[6], "wb");
        volatile u64 done = 0; pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
        job_t *J = calloc(th, sizeof(job_t)); pthread_t *T = calloc(th, sizeof(pthread_t));
        time_t t0 = time(0);
        for (int i = 0; i < th; i++) { J[i] = (job_t){.id = i, .mode = mode, .seed = seed, .target = n, .done = &done, .mu = &mu, .out = out}; pthread_create(&T[i], 0, worker, &J[i]); }
        u64 hist[NCHK + 1] = {0}, coll = 0, pre = 0, samp = 0, bad = 0;
        for (int i = 0; i < th; i++) {
            pthread_join(T[i], 0);
            for (int c = 0; c <= NCHK; c++) hist[c] += J[i].hist[c];
            coll += J[i].coll; pre += J[i].prefixes; samp += J[i].samples; bad += J[i].badreplay;
        }
        fclose(out);
        printf("mode %s seed %llu prefixes %llu samples %llu badreplay %llu seconds %ld\n", mode ? "real" : "cond",
               (unsigned long long)seed, (unsigned long long)pre, (unsigned long long)samp, (unsigned long long)bad, (long)(time(0) - t0));
        printf("pairs %llu\n", (unsigned long long)(pre * NTAIL));
        static const char *nm[3] = {"dW", "dE", "dA"};
        u64 surv = pre * NTAIL;
        for (int c = 0; c < NCHK; c++) {
            u64 after = surv - hist[c];
            if (surv) printf("step %2d %s  in %14llu  pass %14llu\n", 16 + c / 3, nm[c % 3], (unsigned long long)surv, (unsigned long long)after);
            surv = after;
        }
        printf("followed trail through step 31: %llu\nfull C32 second-block collisions: %llu\n", (unsigned long long)hist[NCHK], (unsigned long long)coll);
        return 0;
    }
    fprintf(stderr, "usage: r32 selftest | r32 yield cond|real <n> <threads> <seed> <out.bin>\n");
    return 2;
}
