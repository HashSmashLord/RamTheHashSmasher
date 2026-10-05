// Small sliding-window rate limiter, used only on the public idea-submission
// endpoint so it can't be used to spam the moderation queue.

/**
 * @param {{ max: number, windowMs: number, now?: () => number }} opts
 */
export function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError('max must be a positive integer');
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError('windowMs must be a positive integer');

  /** @type {Map<string, number[]>} */
  const hits = new Map();
  const sweep = setInterval(() => {
    const cutoff = now() - windowMs;
    for (const [key, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }, Math.min(windowMs, 60_000));
  sweep.unref?.();

  /** @param {string} key */
  function hit(key) {
    const t = now();
    const cutoff = t - windowMs;
    const times = (hits.get(key) || []).filter((x) => x > cutoff);
    times.push(t);
    hits.set(key, times);
    const allowed = times.length <= max;
    const remaining = Math.max(0, max - times.length);
    const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((times[0] + windowMs - t) / 1000));
    return { allowed, remaining, retryAfterSec };
  }

  return { hit, stop: () => clearInterval(sweep) };
}
