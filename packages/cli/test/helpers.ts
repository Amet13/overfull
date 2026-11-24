import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Problem, Report } from '@overfull/core';
import { afterAll, onTestFinished } from 'vitest';
import type { Io } from '../src/io.js';

export interface MemIo extends Io {
  out: string[];
  err: string[];
  stdoutText(): string;
  stderrText(): string;
}

export function memIo(cwd: string, env: Record<string, string | undefined> = {}): MemIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd,
    // Keep PATH so tool detection works, but no colors and no real network by default.
    // OVERFULL_TEST_NO_SPACING: no arXiv/CrossRef/dblp SPARQL request spacing in tests (see testRefsTiming).
    // No Docker either, unless the test brings its own PATH (with a fake docker): a
    // slow or hanging Docker daemon on the test machine must not time tests out.
    env: {
      PATH: process.env.PATH,
      NO_COLOR: '1',
      OVERFULL_TEST_NO_SPACING: '1',
      ...('PATH' in env ? {} : { OVERFULL_NO_DOCKER: '1' }),
      ...env,
    },
    isTTY: false,
    out,
    err,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
    fetch: (() => Promise.reject(new Error('network disabled in tests'))) as typeof fetch,
  };
}

// Temp dirs go away when the test that made them finishes. Dirs made outside a test
// (in beforeAll or at collection time) go away after the test file.
const outsideTests: string[] = [];
const remove = (dir: string) => rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
afterAll(() => {
  for (const dir of outsideTests.splice(0)) remove(dir);
});

/** A fresh, empty temp dir, removed after the current test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'overfull-test-'));
  try {
    onTestFinished(() => remove(dir));
  } catch {
    outsideTests.push(dir);
  }
  return dir;
}

/** Copies a fixture directory to a fresh temp dir and returns its path. */
export function tempCopy(fixture: string): string {
  const dir = tempDir();
  cpSync(new URL(`./fixtures/${fixture}`, import.meta.url), dir, { recursive: true });
  return dir;
}

/** A directory of fake executables (shell scripts) to put first on PATH. POSIX only. */
export function fakeBin(scripts: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, body] of Object.entries(scripts)) {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

/** Runs git in `cwd` without system config and with a fixed identity; returns trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.org',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.org',
    },
  }).trim();
}

/** Every problem in a report, across checks. */
export const problems = (r: Report): Problem[] => r.checks.flatMap((c) => c.problems);

/** The rule id of every problem in a report. */
export const rules = (r: Report): string[] => problems(r).map((p) => p.rule);
