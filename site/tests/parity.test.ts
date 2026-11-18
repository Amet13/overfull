/** The browser check and `overfull check` agree on the CLI's fixture project (offline). */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckResult, Report } from '@overfull/core';
import { describe, expect, it, onTestFinished } from 'vitest';
import { runCheck } from '../../packages/cli/src/check.js';
import { loadPdfjs } from '../../packages/cli/src/pdf.js';
import { type Loaded, runBrowserCheck } from '../src/scripts/pipeline';

const fixture = fileURLToPath(new URL('../../packages/cli/test/fixtures/project', import.meta.url));

function browserFiles(): Loaded[] {
  const text = (name: string, kind: Loaded['kind']): Loaded => ({
    name,
    kind,
    text: readFileSync(join(fixture, name), 'utf8'),
  });
  return [
    text('main.tex', 'tex'),
    text('references.bib', 'bib'),
    text('thesis.aux', 'aux'),
    text('thesis.log', 'log'),
    {
      name: 'thesis.pdf',
      kind: 'pdf',
      data: new Uint8Array(readFileSync(join(fixture, 'thesis.pdf'))),
    },
  ];
}

/** Each check's status and its sorted rule ids. */
const shape = (r: Report) =>
  Object.fromEntries(
    r.checks.map((c: CheckResult) => [
      c.check,
      { status: c.status, rules: [...new Set(c.problems.map((p) => p.rule))].sort() },
    ]),
  );

/** `overfull check --offline` on a copy of the fixture, with no tools on PATH (as in a browser). */
async function cliReport(edit?: (config: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), 'overfull-parity-'));
  const empty = mkdtempSync(join(tmpdir(), 'overfull-parity-path-'));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  });
  cpSync(fixture, dir, { recursive: true });
  const config = join(dir, 'overfull.yml');
  if (edit) writeFileSync(config, edit(readFileSync(config, 'utf8')));
  return runCheck({
    cwd: dir,
    env: { PATH: empty, OVERFULL_NO_DOCKER: '1' },
    offline: true,
    engine: 'local',
  });
}

async function browserReport(): Promise<Report> {
  const result = await runBrowserCheck(browserFiles(), {
    profile: 'thesis',
    online: false,
    target: 'fixture',
    loadPdfjs,
  });
  if (!result) throw new Error('the browser check returned nothing');
  return result.report;
}

describe('browser check parity with overfull check', () => {
  it('finds the same rules with the same statuses', async () => {
    // The browser reads only the profile from overfull.yml, not venue overrides.
    const cli = await cliReport((c) => c.replace(/^venue:\n(?: {2}.*\n)*/m, ''));
    expect(shape(await browserReport())).toEqual(shape(cli));
  });

  it('differs only by the venue overrides in overfull.yml, which the browser does not read', async () => {
    const browser = shape(await browserReport());
    const cli = shape(await cliReport());
    expect(cli.venue).toEqual({ status: 'fail', rules: ['page-limit-exceeded'] });
    expect({ ...cli, venue: browser.venue }).toEqual(browser);
  });
});
