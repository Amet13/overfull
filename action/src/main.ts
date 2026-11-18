import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  CHECK_IDS,
  exitCodeFor,
  formatHuman,
  neutralizeWorkflowCommands,
  type RenderOptions,
  renderReport,
  reportTarget,
  runCheck,
  stopCommands,
  writeReport,
} from 'overfull';
import { readInputs } from './inputs.js';
import { escapeData, outputRecord } from './output.js';

type Env = Record<string, string | undefined>;

/** Runs the Action: checks, prints the report, writes the outputs; returns the exit code. */
export async function run(env: Env, write: (text: string) => void): Promise<number> {
  const setOutput = (name: string, value: string) => {
    const file = env.GITHUB_OUTPUT;
    if (file) appendFileSync(file, outputRecord(name, value));
    else write(`${name}=${escapeData(value)}\n`);
  };
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const inputs = readInputs(env, workspace);
  for (const c of inputs.check.checks ?? []) {
    if (!(CHECK_IDS as readonly string[]).includes(c)) {
      throw new Error(`Unknown check "${c}" in input "checks"; use ${CHECK_IDS.join(', ')}`);
    }
  }
  const report = await runCheck(inputs.check);
  // Messages carry text from the log, PDF and .bib: never let a line act as a workflow
  // command. Neutralized, and printed inside stop-commands with a random token, so
  // the runner executes nothing from it even if a bypass of the neutralizer existed.
  const guard = stopCommands();
  write(
    `${guard.start}${neutralizeWorkflowCommands(formatHuman(report, { color: true, verbose: true }))}${guard.end}`,
  );

  const cwd = resolve(inputs.check.cwd ?? workspace);
  const render: RenderOptions = { cwd, env, root: relative(workspace, cwd) || '.' };
  if (inputs.annotations)
    write(renderReport(report, 'annotations', { ...render, annotationLimit: 50 }));
  if (inputs.summary && env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${renderReport(report, 'markdown', render)}\n`);
  }
  // RUNNER_TEMP is private to the job; outside Actions use a fresh private folder,
  // never a predictable path in the shared temp directory.
  const reportDir = env.RUNNER_TEMP ?? mkdtempSync(join(tmpdir(), 'overfull-'));
  const reportPath = join(reportDir, 'overfull-report.json');
  writeFileSync(reportPath, renderReport(report, 'json', render));
  if (inputs.sarif) {
    // Inside the workspace the file must not be, or go through, a symlink: the
    // repository could point `overfull.sarif` at a file outside it.
    const target = reportTarget(workspace, inputs.sarif, 'Input "sarif"');
    writeReport(target, renderReport(report, 'sarif', render));
    setOutput('sarif', target.path);
  }
  setOutput('status', report.status);
  setOutput('report', reportPath);
  return exitCodeFor(report, inputs.failOn);
}
