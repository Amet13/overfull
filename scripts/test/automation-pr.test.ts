/** .github/scripts/automation-pr.sh with fake gh and git push: fork PRs are never taken over. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../.github/scripts/automation-pr.sh', import.meta.url));
const realGit =
  process.platform === 'win32' ? '' : execFileSync('which', ['git']).toString().trim();

/** Runs the script in a fresh repository with one change; `prs` is what `gh pr list` returns. */
function run(prs: unknown[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'overfull-apr-'));
  const bin = mkdtempSync(join(tmpdir(), 'overfull-apr-bin-'));
  const log = join(bin, 'gh.log');
  writeFileSync(join(bin, 'prs.json'), JSON.stringify(prs));
  const write = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  write(
    'gh',
    `printf '%s\\n' "$*" >> "${log}"\ncase "$1 $2" in "pr list") cat "${join(bin, 'prs.json')}";; esac`,
  );
  write('git', `[ "$1" = push ] && exit 0\nexec "${realGit}" "$@"`);
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: '1',
    GH_TOKEN: 'x',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_WORKFLOW: 'test',
    GITHUB_RUN_ID: '1',
  };
  execFileSync(realGit, ['init', '-q', '-b', 'main'], { cwd: dir, env });
  writeFileSync(join(dir, 'a.txt'), 'changed\n');
  writeFileSync(join(bin, 'body.md'), 'Body\n');
  execFileSync('bash', [script, 'regenerate', 'Regenerate', join(bin, 'body.md')], {
    cwd: dir,
    env,
  });
  return readFileSync(log, 'utf8').trim().split('\n');
}

describe.skipIf(process.platform === 'win32')('automation-pr.sh', () => {
  it('opens a new PR when the only PR on that branch name comes from a fork', () => {
    const calls = run([{ number: 7, isCrossRepository: true }]);
    expect(calls.some((c) => c.startsWith('pr create'))).toBe(true);
    expect(calls.some((c) => c.startsWith('pr edit'))).toBe(false);
    expect(calls.find((c) => c.startsWith('pr list'))).toContain('isCrossRepository');
  });

  it('updates the PR from this repository, never the fork one', () => {
    const calls = run([
      { number: 7, isCrossRepository: true },
      { number: 9, isCrossRepository: false },
    ]);
    expect(calls.some((c) => c.startsWith('pr edit 9 '))).toBe(true);
    expect(calls.some((c) => c.startsWith('pr edit 7 '))).toBe(false);
    expect(calls.some((c) => c.startsWith('pr create'))).toBe(false);
  });

  it('opens a PR when there is none, and starts CodeQL and CI on its branch', () => {
    const calls = run([]);
    expect(calls.some((c) => c.startsWith('pr create'))).toBe(true);
    expect(calls).toContain('workflow run codeql.yml --ref automation/regenerate');
    expect(calls.at(-1)).toMatch(/^workflow run ci\.yml --ref automation\/regenerate/);
  });
});
