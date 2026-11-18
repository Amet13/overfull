/** .github/scripts/automerge.sh with a fake gh: safety checks, behind main, what starts after a merge. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { fakeGh, type Route, runScript } from './fake-gh.js';

const script = fileURLToPath(new URL('../../.github/scripts/automerge.sh', import.meta.url));
const imageYml = fileURLToPath(new URL('../../.github/workflows/image.yml', import.meta.url));
const SHA = 'a'.repeat(40);

interface Options {
  prs?: unknown[];
  checks?: { name: string; status?: string; conclusion?: string | null; suite?: number }[];
  behind?: number;
  updateFails?: boolean;
  files?: string[];
}

function automerge(o: Options = {}, env: Record<string, string> = {}) {
  const routes: Route[] = [
    {
      match: '^pr list',
      out: o.prs ?? [
        {
          number: 12,
          headRefOid: SHA,
          labels: [{ name: 'automerge' }],
          isCrossRepository: false,
          author: { login: 'app/github-actions' },
        },
      ],
    },
    {
      match: '^api repos/owner/repo/commits/a+/check-runs',
      out: {
        check_runs: (o.checks ?? [{ name: 'CI passed' }]).map((c) => ({
          name: c.name,
          status: c.status ?? 'completed',
          conclusion: c.conclusion === undefined ? 'success' : c.conclusion,
          check_suite: { id: c.suite ?? 1 },
        })),
      },
    },
    { match: '^api repos/owner/repo/compare/main\\.\\.\\.a+', out: { behind_by: o.behind ?? 0 } },
    {
      match: '^api -X PUT repos/owner/repo/pulls/12/update-branch',
      code: o.updateFails ? 1 : 0,
      out: '{}',
    },
    {
      match: '^api repos/owner/repo/pulls/12/files',
      out: (o.files ?? ['packages/core/src/index.ts']).map((filename) => ({ filename })),
    },
    { match: '^issue list', out: [] },
  ];
  const gh = fakeGh(routes);
  const res = runScript(gh, script, ['automation/pins', SHA, '99'], env);
  expect(res.code, res.out).toBe(0);
  return { calls: gh.calls(), out: res.out };
}

const started = (calls: string[]) =>
  calls.filter((c) => c.startsWith('workflow run')).map((c) => c.split(' ')[2]);

describe.skipIf(process.platform === 'win32')('automerge.sh', () => {
  it('merges an up-to-date pull request whose checks passed', () => {
    const { calls } = automerge();
    expect(calls).toContain('pr merge 12 --squash --delete-branch');
  });

  it('keeps the safety checks: label, same repository, author and head commit', () => {
    const pr = {
      number: 12,
      headRefOid: SHA,
      labels: [{ name: 'automerge' }],
      isCrossRepository: false,
      author: { login: 'app/github-actions' },
    };
    for (const bad of [
      { ...pr, labels: [] },
      { ...pr, isCrossRepository: true },
      { ...pr, author: { login: 'someone' } },
      { ...pr, headRefOid: 'b'.repeat(40) },
    ]) {
      const { calls } = automerge({ prs: [bad] });
      expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    }
  });

  it('does not merge while a check failed or is still running', () => {
    const failed = automerge({ checks: [{ name: 'Analyze', conclusion: 'failure' }] });
    expect(failed.calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    expect(failed.out).toContain('Analyze');
    const pending = automerge({
      checks: [{ name: 'Analyze', status: 'in_progress', conclusion: null }],
    });
    expect(pending.calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    expect(pending.out).toContain('waiting for');
  });

  it("ignores the calling run's own check suite", () => {
    const { calls } = automerge({
      checks: [{ name: 'automation', status: 'in_progress', suite: 99 }],
    });
    expect(calls).toContain('pr merge 12 --squash --delete-branch');
  });

  it('brings a branch behind main up to date and starts ci on it instead of merging', () => {
    const { calls, out } = automerge({ behind: 3 });
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    expect(calls).toContain(
      `api -X PUT repos/owner/repo/pulls/12/update-branch -f expected_head_sha=${SHA}`,
    );
    expect(calls).toContain('workflow run ci.yml --ref automation/pins');
    expect(out).toContain('3 commit(s) behind main');
  });

  it('opens an issue when the branch cannot be brought up to date', () => {
    const { calls } = automerge({ behind: 1, updateFails: true });
    expect(calls.some((c) => c.startsWith('pr merge'))).toBe(false);
    expect(calls.some((c) => c.startsWith('workflow run'))).toBe(false);
    expect(calls.find((c) => c.startsWith('issue create'))).toContain(
      'Automation pull request #12 is behind main',
    );
  });

  it('starts image only when a changed file matches its path filters', () => {
    expect(started(automerge({ files: ['docs/guide/cli.md', 'site/src/x.astro'] }).calls)).toEqual([
      'ci.yml',
      'codeql.yml',
      'regenerate.yml',
      'pages.yml',
    ]);
    expect(started(automerge({ files: ['docs/guide/cli.md', 'docker/Dockerfile'] }).calls)).toEqual(
      ['ci.yml', 'codeql.yml', 'regenerate.yml', 'image.yml', 'pages.yml'],
    );
  });

  // One case per path filter of image.yml (each runs the script once; on macOS a run
  // takes about 2 s, so all of them in one test would not fit its time limit).
  const imagePaths: string[] = parse(readFileSync(imageYml, 'utf8')).on.push.paths;
  it('image.yml has path filters to test', () => {
    expect(imagePaths.length).toBeGreaterThan(5);
  });
  it.each(imagePaths)("image.yml's path filter %s starts image", (p) => {
    const file = p.replace('**', 'sub/dir/file.txt');
    expect(started(automerge({ files: [file] }).calls), p).toContain('image.yml');
  });
});
