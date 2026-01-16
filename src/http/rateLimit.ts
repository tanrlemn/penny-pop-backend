type RateLimitEntry = {
  count: number;
  resetAtMs: number;
};

const buckets = new Map<string, RateLimitEntry>();

export function checkRateLimit(opts: {
  key: string;
  windowMs: number;
  max: number;
}): { allowed: boolean; remaining: number; resetAtMs: number } {
  const now = Date.now();
  const existing = buckets.get(opts.key);
  if (!existing || now >= existing.resetAtMs) {
    const entry = { count: 1, resetAtMs: now + opts.windowMs };
    buckets.set(opts.key, entry);
    return { allowed: true, remaining: opts.max - 1, resetAtMs: entry.resetAtMs };
  }

  if (existing.count >= opts.max) {
    return { allowed: false, remaining: 0, resetAtMs: existing.resetAtMs };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, opts.max - existing.count),
    resetAtMs: existing.resetAtMs,
  };
}
