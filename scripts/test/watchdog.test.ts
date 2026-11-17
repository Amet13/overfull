/** .github/scripts/watchdog.sh with a fake gh: issues follow the newest run, re-runs, stuck runs. */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeGh, type Route, runScript } from './fake-gh.js';

const script = fileURLToPath(new URL('../../.github/scripts/watchdog.sh', import.meta.url));
const NOW = Date.parse('2026-11-17T12:00:00Z') / 1000;
const ago = (minutes: number) =>
  new Date((NOW - minutes * 60) * 1000).toISOString().replace('.000', '');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Run {
  id: number;
  name?: string;
  workflow_id?: number;
  head_branch?: string;
  event?: string;
  status?: string;
  conclusion?: string | null;
  run_attempt?: number;
  created?: number;
  updated?: number;
  repo?: string;
  path?: string;
}

function run(r: Run) {
  const name = r.name ?? 'ci';
  return {
    id: r.id,
    name,
    workflow_id: r.workflow_id ?? 11,
    head_branch: r.head_branch ?? 'main',
    event: r.event ?? 'push',
    status: r.status ?? 'completed',
    conclusion: r.conclusion === undefined ? 'success' : r.conclusion,
    run_attempt: r.run_attempt ?? 1,
    created_at: ago(r.created ?? 10),
    updated_at: ago(r.updated ?? 5),
    html_url: `https://github.com/owner/repo/actions/runs/${r.id}`,
    head_repository: { full_name: r.repo ?? 'owner/repo' },
    path: r.path ?? `.github/workflows/${name}.yml`,
  };
}

const workflowRuns = (wf: number, branch: string | null, runs: Run[]): Route => ({
  match: `^api ${esc(`repos/owner/repo/actions/workflows/${wf}/runs?`)}${branch ? esc(`branch=${branch}&`) : 'per_page'}`,
  out: { workflow_runs: runs.map(run) },
});
const issues = (list: { number: number; title: string; body?: string }[]): Route => ({
  match: '^issue list',
  out: list.map((i) => ({ body: '', ...i })),
});

function report(routes: Route[], name: string, branch: string, wf = 11) {
  const gh = fakeGh(routes);
  const res = runScript(gh, script, ['report', String(wf), name, branch], { NOW: String(NOW) });
  expect(res.code, res.out).toBe(0);
  return { calls: gh.calls(), out: res.out };
}

describe.skipIf(process.platform === 'win32')('watchdog.sh report', () => {
  it('opens an issue when the newest run on main failed', () => {
    const { calls } = report(
      [
        workflowRuns(11, 'main', [
          { id: 1, conclusion: 'success', created: 60 },
          { id: 2, conclusion: 'failure', created: 10 },
        ]),
        issues([]),
      ],
      'ci',
      'main',
    );
    const create = calls.find((c) => c.startsWith('issue create'));
    expect(create).toContain('--title Automation failed: ci --body-file');
  });

  it('closes the issue when the newest run succeeded, even after an older failure', () => {
    const { calls } = report(
      [
        workflowRuns(11, 'main', [
          { id: 2, conclusion: 'failure', created: 60 },
          { id: 3, conclusion: 'success', created: 10 },
        ]),
        issues([{ number: 5, title: 'Automation failed: ci' }]),
      ],
      'ci',
      'main',
    );
    expect(calls.some((c) => c.startsWith('issue close 5 '))).toBe(true);
  });

  it('waits while the newest run is still running, and ignores pull request runs', () => {
    const { calls } = report(
      [
        workflowRuns(11, 'main', [
          { id: 2, conclusion: 'failure', created: 60 },
          { id: 3, status: 'in_progress', conclusion: null, created: 10 },
          { id: 4, conclusion: 'failure', created: 1, event: 'pull_request' },
        ]),
        issues([{ number: 5, title: 'Automation failed: ci' }]),
      ],
      'ci',
      'main',
    );
    expect(calls.some((c) => c.startsWith('issue'))).toBe(false);
  });

  it('says nothing about a cancelled run', () => {
    const { calls } = report(
      [workflowRuns(11, 'main', [{ id: 2, conclusion: 'cancelled' }]), issues([])],
      'ci',
      'main',
    );
    expect(calls.some((c) => c.startsWith('issue'))).toBe(false);
  });

  it('reports release tags as one branch, and automation branches each on their own', () => {
    const tags = report(
      [
        workflowRuns(12, null, [
          { id: 7, name: 'release', head_branch: 'v3.2.0', conclusion: 'failure', created: 30 },
          { id: 8, name: 'release', head_branch: 'main', conclusion: 'success', created: 5 },
        ]),
        issues([]),
      ],
      'release',
      'v3.2.0',
      12,
    );
    expect(tags.calls.find((c) => c.startsWith('issue create'))).toContain(
      '--title Automation failed: release on a release tag',
    );
    const branch = report(
      [
        workflowRuns(11, 'automation/pins', [
          { id: 9, head_branch: 'automation/pins', conclusion: 'failure' },
        ]),
        issues([]),
      ],
      'ci',
      'automation/pins',
    );
    expect(branch.calls.find((c) => c.startsWith('issue create'))).toContain(
      '--title Automation failed: ci on automation/pins',
    );
  });

  it('does not report other branches', () => {
    const { calls, out } = report([], 'ci', 'feature/x');
    expect(out).toContain('not watched');
    expect(calls).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('watchdog.sh missed and sweep', () => {
  const annotations = (id: number, message: string): Route => ({
    match: `^api ${esc(`repos/owner/repo/check-runs/${id}/annotations`)}`,
    out: [{ message }],
  });
  const jobs = (run: number, list: { id: number; conclusion: string }[]): Route => ({
    match: `^api ${esc(`repos/owner/repo/actions/runs/${run}/attempts/1/jobs`)}`,
    out: {
      jobs: list.map((j) => ({
        conclusion: j.conclusion,
        check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${j.id}`,
      })),
    },
  });

  it('counts the jobs that never got a runner', () => {
    const gh = fakeGh([
      jobs(1, [
        { id: 31, conclusion: 'failure' },
        { id: 32, conclusion: 'cancelled' },
        { id: 33, conclusion: 'success' },
      ]),
      annotations(
        31,
        'The job was not acquired by Runner of type hosted even after multiple attempts',
      ),
      annotations(32, 'Process completed with exit code 1.'),
    ]);
    const res = runScript(gh, script, ['missed', '1']);
    expect(res.out.trim()).toBe('1');
  });

  it('re-runs, reports each workflow and branch once, and restarts a stuck run once', () => {
    const recent: Run[] = [
      { id: 1, name: 'ci', conclusion: 'failure', updated: 10, created: 20 },
      { id: 2, name: 'ci', head_branch: 'automation/pins', conclusion: 'failure', updated: 10 },
      { id: 3, name: 'pages', workflow_id: 13, conclusion: 'success', updated: 30 },
      { id: 4, name: 'pages', workflow_id: 13, conclusion: 'success', updated: 40 },
      { id: 5, name: 'ci', event: 'pull_request', head_branch: 'feature', conclusion: 'failure' },
      { id: 6, name: 'ci', conclusion: 'failure', updated: 200 },
      { id: 7, name: 'watchdog', workflow_id: 14, conclusion: 'failure' },
      { id: 8, name: 'image', workflow_id: 15, status: 'in_progress', conclusion: null },
    ];
    const gh = fakeGh([
      {
        match: `^api ${esc('repos/owner/repo/actions/runs?status=queued')}`,
        out: { workflow_runs: [] },
      },
      {
        match: `^api ${esc('repos/owner/repo/actions/runs?per_page')}`,
        out: { workflow_runs: recent.map(run) },
      },
      jobs(1, [{ id: 41, conclusion: 'failure' }]),
      annotations(41, 'The self-hosted runner lost communication with the server.'),
      workflowRuns(11, 'main', [{ id: 1, conclusion: 'failure' }]),
      workflowRuns(11, 'automation/pins', [
        { id: 2, head_branch: 'automation/pins', conclusion: 'failure' },
      ]),
      workflowRuns(13, 'main', [{ id: 4, name: 'pages', workflow_id: 13 }]),
      issues([]),
    ]);
    const res = runScript(gh, script, ['sweep', '90'], { NOW: String(NOW) });
    expect(res.code, res.out).toBe(0);
    const calls = gh.calls();
    // Only main's ci is re-run: ci on an automation branch starts itself again.
    expect(calls.filter((c) => c.startsWith('run rerun'))).toEqual(['run rerun 1 --failed']);
    const queried = calls.filter((c) => /actions\/workflows\/\d+\/runs/.test(c));
    expect(queried).toHaveLength(3);
    expect(
      calls.filter((c) => c.startsWith('issue create')).map((c) => c.split(' --body')[0]),
    ).toEqual([
      'issue create --title Automation failed: ci',
      'issue create --title Automation failed: ci on automation/pins',
    ]);
  });

  const stuckRoutes = (body: string): Route[] => [
    {
      match: `^api ${esc('repos/owner/repo/actions/runs?status=queued')}`,
      out: {
        workflow_runs: [
          run({ id: 20, name: 'pages', status: 'queued', conclusion: null, created: 30 }),
          run({ id: 21, name: 'ci', status: 'queued', conclusion: null, created: 5 }),
          run({ id: 22, name: 'release', status: 'queued', conclusion: null, created: 40 }),
        ],
      },
    },
    { match: `^api ${esc('repos/owner/repo/actions/runs?per_page')}`, out: { workflow_runs: [] } },
    { match: `^api ${esc('repos/owner/repo/actions/runs/')}(20|22)/jobs`, out: { total_count: 0 } },
    issues(body ? [{ number: 9, title: 'Automation failed: pages', body }] : []),
  ];

  it('cancels a run stuck in the queue without a job, starts it again and opens an issue', () => {
    const gh = fakeGh(stuckRoutes(''));
    const res = runScript(gh, script, ['sweep'], { NOW: String(NOW) });
    expect(res.code, res.out).toBe(0);
    const calls = gh.calls();
    expect(calls).toContain('run cancel 20');
    expect(calls).toContain('workflow run pages.yml --ref main');
    // Too young to be stuck.
    expect(calls).not.toContain('run cancel 21');
    // A release's inputs are unknown: cancelled, not started again.
    expect(calls).toContain('run cancel 22');
    expect(calls.some((c) => c.startsWith('workflow run release.yml'))).toBe(false);
    expect(
      calls.filter((c) => c.startsWith('issue create')).map((c) => c.split(' --body')[0]),
    ).toEqual([
      'issue create --title Automation failed: pages',
      'issue create --title Automation failed: release',
    ]);
  });

  it('starts a stuck workflow again only once per open issue', () => {
    const gh = fakeGh(stuckRoutes('A pages run was stuck in the queue for more than 20 minutes'));
    runScript(gh, script, ['sweep'], { NOW: String(NOW) });
    const calls = gh.calls();
    expect(calls).toContain('run cancel 20');
    expect(calls.some((c) => c.startsWith('workflow run'))).toBe(false);
    expect(calls.some((c) => c.startsWith('issue edit 9 '))).toBe(true);
  });
});
