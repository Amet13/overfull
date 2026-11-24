/** Where a command writes and what it knows about its environment. Injected for tests. */
export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** True when stdout is an interactive terminal. */
  isTTY: boolean;
  /** True when stdin is an interactive terminal. Questions are asked only when stdin and stdout both are. */
  stdinIsTTY?: boolean;
  /** Asks a yes/no question (default no). Tests inject it; the CLI reads stdin. */
  ask?: (question: string) => Promise<boolean>;
  /** True when stderr is an interactive terminal (progress lines). Absent means no. */
  stderrIsTTY?: boolean;
  /** Overrides `globalThis.fetch` (tests, proxies). */
  fetch?: typeof fetch;
  /** Stops long-running commands (`check --watch`). The CLI wires it to Ctrl-C. */
  signal?: AbortSignal;
}

export function processIo(): Io {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    isTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
  };
}

/** Thrown for bad usage or configuration: printed without a stack, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Request spacing for the reference indexes in the CLI's own tests: with
 * OVERFULL_TEST_NO_SPACING=1 the arXiv, CrossRef and dblp SPARQL intervals and the retry
 * delay are 0. Honoured only inside a test runner (VITEST or NODE_ENV=test in
 * the real process environment), so a stray variable never makes the CLI
 * impolite to the indexes.
 */
export function testRefsTiming(env: Record<string, string | undefined>): {
  arxivIntervalMs?: number;
  crossrefIntervalMs?: number;
  dblpSparqlIntervalMs?: number;
  retryDelayMs?: number;
} {
  const testRun = Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
  if (!testRun || env.OVERFULL_TEST_NO_SPACING !== '1') return {};
  return { arxivIntervalMs: 0, crossrefIntervalMs: 0, dblpSparqlIntervalMs: 0, retryDelayMs: 0 };
}

/** Says on stderr which overfull.yml above the current folder a command uses. */
export function noteProject(io: Io, location: { above?: string }): void {
  if (location.above) io.stderr(`Using ${location.above}.\n`);
}

/** True when a person can answer a question: stdin and stdout are both terminals. */
export function canAsk(io: Io): boolean {
  return io.isTTY && io.stdinIsTTY === true;
}

export function useColor(io: Io): boolean {
  if (io.env.NO_COLOR !== undefined && io.env.NO_COLOR !== '') return false;
  if (io.env.FORCE_COLOR && io.env.FORCE_COLOR !== '0') return true;
  return io.isTTY;
}

/**
 * A one-line progress writer for stderr, or undefined when stderr is not a
 * terminal. The line is rewritten in place and cleared when the work is done.
 */
export function progressLine(
  io: Io,
  label: string,
): ((done: number, total: number) => void) | undefined {
  if (!io.stderrIsTTY) return undefined;
  return (done, total) => {
    io.stderr(done >= total ? '\r\u001b[K' : `\r${label} ${done}/${total}`);
  };
}
