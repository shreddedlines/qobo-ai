import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSlidingWindowLimiter } from '../src/lib/rate-limiter.ts';
import { createVirtualClock } from './helpers/virtual-clock.ts';

describe('createSlidingWindowLimiter', () => {
  it('admits requests up to the limit without waiting', async () => {
    const clock = createVirtualClock();
    const limiter = createSlidingWindowLimiter({ limit: 90, windowMs: 60_000, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 4; i++) await limiter.acquire(20);
    await limiter.acquire(10);
    assert.deepEqual(clock.sleeps, []);
  });

  it('waits until enough earlier units leave the window', async () => {
    const clock = createVirtualClock();
    const limiter = createSlidingWindowLimiter({ limit: 90, windowMs: 60_000, now: clock.now, sleep: clock.sleep });
    await limiter.acquire(40); // t=0
    await clock.sleep(10_000);
    await limiter.acquire(40); // t=10s
    clock.sleeps.length = 0;

    await limiter.acquire(20); // needs the t=0 entry to expire
    assert.equal(clock.now(), 60_000);
    assert.deepEqual(clock.sleeps, [50_000]);
  });

  it('never admits more than the limit in any window across a long run', async () => {
    const clock = createVirtualClock();
    const limiter = createSlidingWindowLimiter({ limit: 90, windowMs: 60_000, now: clock.now, sleep: clock.sleep });
    const admitted: Array<{ at: number; units: number }> = [];
    let remaining = 119;
    while (remaining > 0) {
      const units = Math.min(20, remaining);
      await limiter.acquire(units);
      admitted.push({ at: clock.now(), units });
      remaining -= units;
    }
    for (const { at } of admitted) {
      const inWindow = admitted.filter((entry) => entry.at > at - 60_000 && entry.at <= at).reduce((sum, entry) => sum + entry.units, 0);
      assert.ok(inWindow <= 90, `window ending at ${at} admitted ${inWindow}`);
    }
    assert.equal(clock.now(), 60_000, '119 units at 90/min should need exactly one minute of waiting');
  });

  it('serializes concurrent callers so they cannot share the same capacity', async () => {
    const clock = createVirtualClock();
    const limiter = createSlidingWindowLimiter({ limit: 10, windowMs: 1_000, now: clock.now, sleep: clock.sleep });
    await Promise.all([limiter.acquire(6), limiter.acquire(6)]);
    assert.equal(clock.now(), 1_000);
  });

  it('rejects impossible or invalid requests', async () => {
    const limiter = createSlidingWindowLimiter({ limit: 90, windowMs: 60_000 });
    await assert.rejects(limiter.acquire(91), /limit is 90/);
    await assert.rejects(limiter.acquire(0), /positive integer/);
    assert.throws(() => createSlidingWindowLimiter({ limit: 0, windowMs: 1 }), /positive integer/);
  });
});
