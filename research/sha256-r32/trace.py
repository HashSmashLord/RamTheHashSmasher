"""Alternate-notation trace of the published ePrint 2026/1080 second block.

Used to check the transcription conventions of the sha256-r32 package
(row strings, u/n signs, relations) against the published witness, and to
print the per-step XOR differences of the published characteristic.
Run from anywhere: python3 trace.py
"""
import struct

MASK = 0xFFFFFFFF
K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
]
IV = (0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19)


def ror(x, n):
    return ((x >> n) | (x << (32 - n))) & MASK


def S0(a): return ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)
def S1(e): return ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)
def s0(x): return ror(x, 7) ^ ror(x, 18) ^ (x >> 3)
def s1(x): return ror(x, 17) ^ ror(x, 19) ^ (x >> 10)
def IF(x, y, z): return (x & y) ^ (~x & z & MASK)
def MAJ(x, y, z): return (x & y) ^ (x & z) ^ (y & z)


def schedule(w16, n):
    w = list(w16)
    for i in range(16, n):
        w.append((s1(w[i - 2]) + w[i - 7] + s0(w[i - 15]) + w[i - 16]) & MASK)
    return w


def trace(cv, w16, n):
    """Return dicts A, E (index -4..n-1) and W in alternate notation."""
    A = {-1: cv[0], -2: cv[1], -3: cv[2], -4: cv[3]}
    E = {-1: cv[4], -2: cv[5], -3: cv[6], -4: cv[7]}
    W = schedule(w16, n)
    for i in range(n):
        E[i] = (A[i-4] + E[i-4] + S1(E[i-1]) + IF(E[i-1], E[i-2], E[i-3]) + K[i] + W[i]) & MASK
        A[i] = (E[i] - A[i-4] + S0(A[i-1]) + MAJ(A[i-1], A[i-2], A[i-3])) & MASK
    return A, E, W


def words(hexstr):
    return [int(x, 16) for x in hexstr.split()]


M1 = words("c0008214 ae65f3bf e93c006a 5f195aa9 a4d6cd0f 21811cec ea897317 db9ec665 "
           "6ec17218 5100da8a 0912e57b a96b2054 45f2222c 4d12f88a d2701ecc 140976d1")
M1p = words("c0008214 ae65f3bf e93c006a 5f195aa9 84d6cd0f 25c114ec ca897317 da9fd6ef "
            "6ec97e18 5100da8a 0912e57b a96b2054 41b22a2c 6d12f88a d2701ecc 140976d1")
CV35 = words("c4369610 c91f70a7 87e430e6 a5e58128 d29cb97b 9ab268d1 8788f401 629f6cb2")


def row_ok(row, x, xp):
    """Check a Figure-6 style row (leftmost char = bit 31)."""
    for k, ch in enumerate(row):
        b = 31 - k
        u, v = (x >> b) & 1, (xp >> b) & 1
        if ch == '=' and u != v: return False
        if ch == '0' and (u, v) != (0, 0): return False
        if ch == '1' and (u, v) != (1, 1): return False
        if ch == 'u' and (u, v) != (0, 1): return False
        if ch == 'n' and (u, v) != (1, 0): return False
    return True


if __name__ == "__main__":
    A, E, W = trace(CV35, M1, 35)
    Ap, Ep, Wp = trace(CV35, M1p, 35)
    print("step  dA        dE        dW")
    for i in range(35):
        print(f"{i:4d}  {A[i]^Ap[i]:08x}  {E[i]^Ep[i]:08x}  {W[i]^Wp[i]:08x}")
    rows = {
        ('E', 3): "=====1=====011======0======0====",
        ('E', 4): "==n0=0=1===100=0==0=1===0==1=0=1",
        ('W', 7): "=======n=======u===u====u=1=u=u=",
        ('W', 8): "============u=======uu==========",
        ('W', 4): "==n=============================",
        ('W', 5): "=====u===u==========n===========",
        ('W', 6): "==n=============================",
        ('E', 14): "=0=100110000000=101=0000=110===0",
        ('E', 15): "=1====0011===u10001=011===0n===1",
        ('A', 14): "==u=============================",
    }
    src = {'A': (A, Ap), 'E': (E, Ep), 'W': (W, Wp)}
    for (v, i), r in rows.items():
        x, xp = src[v][0][i], src[v][1][i]
        print(v, i, row_ok(r, x, xp), f"{x:08x} {xp:08x}")
    print("record (A-1,W7,W8,E3,E4,A0):", " ".join(f"{t:08x}" for t in (A[-1], W[7], W[8], E[3], E[4], A[0])))
