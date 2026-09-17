export interface RateLimiter {
  /** Waits until `units` more requests fit in the window, then records them. */
  acquire(units?: number): Promise<void>;
}

export interface SlidingWindowOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Client-side sliding-window limiter for provider quotas such as "100 embedding
 * requests per minute". Units are recorded when acquired, so retries that call
 * `acquire` again are counted too. Not safe across processes.
 */
export function createSlidingWindowLimiter({
  limit,
  windowMs,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: SlidingWindowOptions): RateLimiter {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const entries: Array<{ at: number; units: number }> = [];
  let queue: Promise<void> = Promise.resolve();

  async function acquireNow(units: number): Promise<void> {
    for (;;) {
      const current = now();
      while (entries.length > 0 && entries[0]!.at <= current - windowMs) entries.shift();
      const used = entries.reduce((sum, entry) => sum + entry.units, 0);
      if (used + units <= limit) {
        entries.push({ at: current, units });
        return;
      }
      // Wait until the oldest entries leave the window and free enough units.
      let freed = limit - used;
      let waitUntil = current;
      for (const entry of entries) {
        freed += entry.units;
        waitUntil = entry.at + windowMs;
        if (freed >= units) break;
      }
      await sleep(Math.max(1, waitUntil - current));
    }
  }

  return {
    acquire(units = 1) {
      if (!Number.isInteger(units) || units < 1) return Promise.reject(new Error('units must be a positive integer'));
      if (units > limit) return Promise.reject(new Error(`Cannot acquire ${units} units; the limit is ${limit} per window`));
      // Serialize callers so concurrent acquisitions cannot both claim the same capacity.
      const result = queue.then(() => acquireNow(units));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
