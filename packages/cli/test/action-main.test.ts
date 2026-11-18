/** The GitHub Action's run(): report on stdout, step summary, outputs, SARIF and exit code. */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../../action/src/main.js';
import { tempCopy, tempDir } from './helpers.js';

type Env = Record<string, string | undefined>;

/** A workspace with the fixture project, and the files the runner provides. */
function setup(inputs: Env = {}) {
  const workspace = tempCopy('project');
  const runner = tempDir();
  const output = join(runner, 'output');
  const summary = join(runner, 'summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const env: Env = {
    PATH: process.env.PATH,
    NO_COLOR: '1',
    OVERFULL_NO_DOCKER: '1',
    OVERFULL_TEST_NO_SPACING: '1',
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    RUNNER_TEMP: runner,
    INPUT_OFFLINE: 'true',
    ...inputs,
  };
  let stdout = '';
  const go = () =>
    run(env, (t) => {
      stdout += t;
    });
  /** The records written to $GITHUB_OUTPUT, by name. */
  const outputs = () => {
    const out: Record<string, string> = {};
    for (const m of readFileSync(output, 'utf8').matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2\n/gm))
      out[m[1] as string] = m[3] as string;
    return out;
  };
  return { env, workspace, runner, go, stdout: () => stdout, outputs, summary };
}

describe('Action run()', () => {
  it('prints the report inside stop-commands and writes summary, report and outputs', async () => {
    const s = setup({ INPUT_CHECKS: 'build,references', 'INPUT_FAIL-ON': 'never' });
    expect(await s.go()).toBe(0);
    const out = s.stdout();
    const start = /^::stop-commands::(overfull-[0-9a-f]{32})$/m.exec(out);
    expect(start).not.toBeNull();
    expect(out).toContain(`::${start?.[1]}::`);
    expect(out).toContain('overfull ');
    const o = s.outputs();
    expect(['pass', 'warn', 'fail']).toContain(o.status);
    expect(o.report).toBe(join(s.runner, 'overfull-report.json'));
    const report = JSON.parse(readFileSync(o.report as string, 'utf8')) as {
      status: string;
      checks: { check: string }[];
    };
    expect(report.status).toBe(o.status);
    expect(report.checks.map((c) => c.check).sort()).toEqual(['build', 'references']);
    expect(o.sarif).toBeUndefined();
    expect(readFileSync(s.summary, 'utf8')).toMatch(/Overfull/);
  });

  it('writes SARIF inside the workspace when asked', async () => {
    const s = setup({ INPUT_SARIF: 'overfull.sarif', 'INPUT_FAIL-ON': 'never' });
    await s.go();
    const sarif = s.outputs().sarif as string;
    expect(sarif).toBe(join(s.workspace, 'overfull.sarif'));
    expect(JSON.parse(readFileSync(sarif, 'utf8'))).toMatchObject({ version: '2.1.0' });
  });

  it('prints outputs to stdout without GITHUB_OUTPUT, and skips annotations and summary when off', async () => {
    const s = setup({
      GITHUB_OUTPUT: undefined,
      INPUT_ANNOTATIONS: 'false',
      INPUT_SUMMARY: 'false',
      'INPUT_FAIL-ON': 'never',
    });
    await s.go();
    expect(s.stdout()).toMatch(/^status=(pass|warn|fail)$/m);
    expect(s.stdout()).toMatch(/^report=.*overfull-report\.json$/m);
    expect(s.stdout()).not.toMatch(/^::(error|warning|notice) /m);
    expect(readFileSync(s.summary, 'utf8')).toBe('');
  });

  it('writes the report to a new private folder when RUNNER_TEMP is not set', async () => {
    const reports: string[] = [];
    for (let i = 0; i < 2; i++) {
      const s = setup({ RUNNER_TEMP: undefined, 'INPUT_FAIL-ON': 'never' });
      await s.go();
      const report = s.outputs().report as string;
      expect(basename(report)).toBe('overfull-report.json');
      expect(dirname(dirname(report))).toBe(tmpdir());
      expect(basename(dirname(report))).toMatch(/^overfull-.+/);
      expect(JSON.parse(readFileSync(report, 'utf8'))).toHaveProperty('status');
      reports.push(report);
      rmSync(dirname(report), { recursive: true, force: true });
    }
    // Never a fixed path in the shared temp folder another user could create first.
    expect(reports[0]).not.toBe(reports[1]);
  });

  it('annotates problems after the report, and fails on errors', async () => {
    const s = setup({ INPUT_CHECKS: 'references', INPUT_BIB: 'broken.bib' });
    writeFileSync(join(s.workspace, 'broken.bib'), '@article{a, title = {Unclosed\n');
    expect(await s.go()).toBe(1);
    expect(s.outputs().status).toBe('fail');
    expect(s.stdout()).toMatch(/^::error file=broken\.bib/m);
  });

  it('rejects an unknown check', async () => {
    const s = setup({ INPUT_CHECKS: 'build,spelling' });
    await expect(s.go()).rejects.toThrow('Unknown check "spelling" in input "checks"');
  });
});
