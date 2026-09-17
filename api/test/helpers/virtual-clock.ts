/** Deterministic time for rate-limit and retry tests: sleeping advances the clock instantly. */
export function createVirtualClock(start = 0) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
  };
}
