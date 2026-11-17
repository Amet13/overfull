/**
 * A fake `gh` for the .github/scripts tests: logs every call, answers from a list of
 * routes, and applies `--jq` with the real jq, as gh does.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Route {
  /** A regular expression tested against the call's arguments (without the --jq program). */
  match: string;
  /** Printed (JSON when not a string), through --jq when the call has one. */
  out?: unknown;
  code?: number;
}

const program = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const at = args.indexOf('--jq');
const jq = at >= 0 ? args[at + 1] : undefined;
const shown = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
const line = shown.join(' ');
appendFileSync(process.env.FAKE_GH_LOG, line + '\\n');
const routes = JSON.parse(readFileSync(process.env.FAKE_GH_ROUTES, 'utf8'));
const route = routes.find((r) => new RegExp(r.match).test(line));
if (!route) process.exit(0);
if (route.out !== undefined) {
  const text = typeof route.out === 'string' ? route.out : JSON.stringify(route.out);
  if (jq !== undefined) process.stdout.write(execFileSync('jq', ['-r', jq], { input: text }));
  else process.stdout.write(text);
}
process.exit(route.code ?? 0);
`;

export interface FakeGh {
  /** Directory to put first on PATH. */
  bin: string;
  env: Record<string, string>;
  /** Every call so far, one line each. */
  calls(): string[];
}

export function fakeGh(routes: Route[]): FakeGh {
  const bin = mkdtempSync(join(tmpdir(), 'overfull-gh-'));
  const log = join(bin, 'gh.log');
  writeFileSync(log, '');
  writeFileSync(join(bin, 'routes.json'), JSON.stringify(routes));
  writeFileSync(join(bin, 'gh'), program);
  chmodSync(join(bin, 'gh'), 0o755);
  return {
    bin,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_GH_LOG: log,
      FAKE_GH_ROUTES: join(bin, 'routes.json'),
      GH_TOKEN: 'x',
      GH_REPO: 'owner/repo',
      HOME: bin,
    },
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
  };
}

/** Runs a script with the fake gh; returns its output (also when it fails). */
export function runScript(
  gh: FakeGh,
  script: string,
  args: string[],
  env: Record<string, string> = {},
): { out: string; code: number } {
  try {
    const out = execFileSync('bash', [script, ...args], {
      env: { ...gh.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}
