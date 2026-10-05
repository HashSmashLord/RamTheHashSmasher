"""Analyze per-prefix records written by `r32 yield ... <out.bin>`.

Record layout (little-endian u32): cv[8], W0..W8 (branch 0), hist[49], where
hist[c] counts the tails whose first failed trail check is c (c = 3*(k-16) +
{0: dW_k, 1: dE_k, 2: dA_k}, k = 16..31; c = 48 means followed through step 31).

Usage: python3 analyze.py out.bin [out2.bin ...]
"""
import math
import struct
import sys

NTAIL = 196608
REC = 66 * 4
NAMES = ("dW", "dE", "dA")


def poisson_interval(k, conf=0.95):
    """Two-sided 95% interval for a Poisson mean: exact (Garwood) up to 100 events, normal above."""
    a = (1 - conf) / 2
    if k > 100:  # exp(-lam) underflows for large lam; the normal approximation is fine here
        z = 1.959963984540054
        return max(0.0, k - z * math.sqrt(k)), k + z * math.sqrt(k)

    def cdf(lam, n):  # P[X <= n]
        term, tot = math.exp(-lam), math.exp(-lam)
        for i in range(1, n + 1):
            term *= lam / i
            tot += term
        return tot

    def solve(f, lo, hi):
        for _ in range(200):
            mid = (lo + hi) / 2
            if f(mid):
                lo = mid
            else:
                hi = mid
        return (lo + hi) / 2

    lower = 0.0 if k == 0 else solve(lambda lam: 1 - cdf(lam, k - 1) < a, 0.0, k + 50 * math.sqrt(k + 1) + 50)
    upper = solve(lambda lam: cdf(lam, k) > a, 0.0, k + 50 * math.sqrt(k + 1) + 50)
    return lower, upper


def lg(x):
    return math.log2(x) if x > 0 else float("-inf")


def main(paths):
    tot = [0] * 49
    n = 0
    step17 = []  # per-prefix number of tails passing the step-17 checks
    for p in paths:
        data = open(p, "rb").read()
        m = len(data) // REC
        for i in range(m):
            h = struct.unpack_from("<49I", data, i * REC + 17 * 4)
            for c in range(49):
                tot[c] += h[c]
            step17.append(NTAIL - sum(h[:6]))
        n += m
    pairs = n * NTAIL
    print(f"prefixes {n}  pairs {pairs} = 2^{lg(pairs):.3f}")
    print(f"{'check':>10} {'in':>14} {'pass':>14} {'cond log2':>10} {'cum log2':>9}  cum 95% interval (log2)")
    surv = pairs
    for c in range(48):
        after = surv - tot[c]
        if after != surv:
            lo, hi = poisson_interval(after)
            print(f"step{16 + c // 3:3d} {NAMES[c % 3]} {surv:14d} {after:14d} {lg(after / surv):10.3f} {lg(after / pairs):9.3f}"
                  f"  [{lg(lo / pairs):.2f}, {lg(hi / pairs):.2f}]")
        surv = after
    print(f"followed trail through step 31: {tot[48]}")
    # Heterogeneity of the step-17 survivor count across prefixes.
    nz = sum(1 for x in step17 if x)
    mean = sum(step17) / n
    var = sum((x - mean) ** 2 for x in step17) / n
    top = sorted(step17, reverse=True)
    share = sum(top[: max(1, n // 100)]) / max(1, sum(step17))
    print(f"step-17 survivors per prefix: mean {mean:.3f}, var {var:.3f}, prefixes with >=1: {nz}/{n},"
          f" top 1% of prefixes hold {100 * share:.1f}% of survivors, max {top[0]}")


if __name__ == "__main__":
    main(sys.argv[1:])
