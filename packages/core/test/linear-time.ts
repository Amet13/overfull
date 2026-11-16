/**
 * Timing for the "stays linear on crafted input" tests.
 *
 * These tests catch regular expressions and scans that turned quadratic on crafted
 * input (a long run of spaces, an unclosed brace). On their inputs (100 KB to 1 MB) a
 * linear scan takes under 100 ms on a laptop; a quadratic one takes tens of seconds or
 * more. The budget sits between the two with room on both sides: the CI job that
 * measures coverage instruments every line, and a shared runner can be busy with other
 * test files, which together made a 66 ms scan take 316 ms. A budget close to the
 * normal time fails on a slow runner without catching anything more.
 */
export const LINEAR_BUDGET_MS = 1500;

/**
 * Best of three runs, stopping at the first one within the budget: one sample can be
 * slowed by garbage collection or a busy runner; a quadratic scan is slow every time.
 */
export function timed(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3 && best >= LINEAR_BUDGET_MS; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}
