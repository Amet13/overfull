import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, onTestFinished } from 'vitest';

/** Reference lookup options for tests: no request spacing and no retry delays. */
export const fast = { arxivIntervalMs: 0, crossrefIntervalMs: 0, retryDelayMs: 0 };

/** An arXiv API answer. */
export const atom = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'application/atom+xml' } });

const outsideTests: string[] = [];
const remove = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
afterAll(() => {
  for (const dir of outsideTests.splice(0)) remove(dir);
});

/** A fresh, empty temp dir, removed after the current test (or after the file, outside a test). */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'overfull-core-test-'));
  try {
    onTestFinished(() => remove(dir));
  } catch {
    outsideTests.push(dir);
  }
  return dir;
}
