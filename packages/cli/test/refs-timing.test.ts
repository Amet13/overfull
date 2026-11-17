import { afterEach, describe, expect, it } from 'vitest';
import { testRefsTiming } from '../src/io.js';

describe('testRefsTiming (test hook for request spacing)', () => {
  const saved = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('turns the arXiv and CrossRef spacing off only with OVERFULL_TEST_NO_SPACING=1', () => {
    expect(testRefsTiming({})).toEqual({});
    expect(testRefsTiming({ OVERFULL_TEST_NO_SPACING: '1' })).toEqual({
      arxivIntervalMs: 0,
      crossrefIntervalMs: 0,
      retryDelayMs: 0,
    });
  });

  it('ignores the variable outside a test runner', () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    expect(testRefsTiming({ OVERFULL_TEST_NO_SPACING: '1' })).toEqual({});
  });
});
