import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export default defineConfig({
  // Tests import @overfull/core (and the Action imports overfull) from the sources, as the
  // Action bundle does, so `pnpm test` never runs stale built code. `/text` must come first.
  resolve: {
    alias: [
      { find: /^@overfull\/core\/text$/, replacement: src('packages/core/src/report/shared.ts') },
      { find: /^@overfull\/core$/, replacement: src('packages/core/src/index.ts') },
      { find: /^overfull$/, replacement: src('packages/cli/src/index.ts') },
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
      include: ['packages/*/src/**/*.ts', 'action/src/**/*.ts'],
      // Entry points that only call into tested code: bin.ts runs main(), the Action's
      // index.ts runs run() from action/src/main.ts.
      exclude: [
        'packages/*/src/**/*.generated.ts',
        'packages/cli/src/bin.ts',
        'action/src/index.ts',
      ],
      reporter: ['text-summary'],
      thresholds: { lines: 94, branches: 82, functions: 95, statements: 92 },
    },
  },
});
