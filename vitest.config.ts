import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSrc = (file: string) =>
  fileURLToPath(new URL(`packages/core/src/${file}`, import.meta.url));

export default defineConfig({
  // Tests import @overfull/core from its sources, so `pnpm test` never runs stale built code
  // after a core edit. The more specific `/text` entry must come first.
  resolve: {
    alias: [
      { find: /^@overfull\/core\/text$/, replacement: coreSrc('report/shared.ts') },
      { find: /^@overfull\/core$/, replacement: coreSrc('index.ts') },
    ],
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'scripts/test/**/*.test.ts',
      'site/tests/**/*.test.ts',
      'bench/refs/test/**/*.test.ts',
      'evals/test/**/*.test.ts',
      'packaging/*.test.ts',
    ],
    testTimeout: 20000,
    // `pnpm test:coverage` (the Linux CI job): fails when coverage of the shipped code
    // drops below these floors, set a little under the measured numbers.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.generated.ts', 'packages/cli/src/bin.ts'],
      reporter: ['text-summary'],
      thresholds: { lines: 90, branches: 76, functions: 88, statements: 88 },
    },
  },
});
