/** `overfull check --gcc` and the VS Code task `overfull init --here --vscode` writes. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Report } from '@overfull/core';
import { describe, expect, it } from 'vitest';
import { formatGcc, VSCODE_TASKS } from '../src/gcc.js';
import { main } from '../src/main.js';
import { memIo, tempCopy } from './helpers.js';

const report = (problems: Report['checks'][number]['problems']): Report =>
  ({
    tool: 'overfull',
    version: '0.0.0',
    status: 'fail',
    checks: [{ check: 'build', status: 'fail', problems }],
  }) as unknown as Report;

const tasks = JSON.parse(VSCODE_TASKS);
const matcher = new RegExp(tasks.tasks[0].problemMatcher.pattern.regexp);

describe('formatGcc', () => {
  it('prints file:line:col: severity: message [rule], errors first', () => {
    const out = formatGcc(
      report([
        {
          rule: 'overfull-hbox',
          check: 'build',
          severity: 'warning',
          message: 'Line too wide by 12pt',
          location: { file: 'chapters/intro.tex', line: 42 },
        },
        {
          rule: 'undefined-control-sequence',
          check: 'build',
          severity: 'error',
          message: 'Undefined control sequence \\foo',
          location: { file: 'main.tex', line: 7 },
        },
        {
          rule: 'bib-style',
          check: 'build',
          severity: 'info',
          message: 'Style file differs\nfrom the kit',
          location: { file: 'neurips.sty' },
        },
      ]),
    );
    expect(out.split('\n')).toEqual([
      'main.tex:7:1: error: Undefined control sequence \\foo [undefined-control-sequence]',
      'chapters/intro.tex:42:1: warning: Line too wide by 12pt [overfull-hbox]',
      'neurips.sty:1:1: note: Style file differs from the kit [bib-style]',
      '',
    ]);
  });

  it('prints a problem without a file with the program name, which editors do not attach', () => {
    const out = formatGcc(
      report([
        {
          rule: 'missing-alt-text',
          check: 'build',
          severity: 'warning',
          message: 'Figure has no alternative text',
          location: { page: 3 },
        },
      ]),
    );
    expect(out).toBe(
      'overfull: warning: page 3: Figure has no alternative text [missing-alt-text]\n',
    );
    expect(matcher.test(out.trimEnd())).toBe(false);
  });

  it('prints nothing for a clean report', () => {
    expect(formatGcc(report([]))).toBe('');
  });

  it('the VS Code problem matcher reads every line that has a file', () => {
    const m = matcher.exec('chapters/a b.tex:42:1: warning: Line too wide: 12pt [overfull-hbox]');
    expect(m?.slice(1)).toEqual([
      'chapters/a b.tex',
      '42',
      '1',
      'warning',
      'Line too wide: 12pt',
      'overfull-hbox',
    ]);
  });
});

describe('check --gcc', () => {
  it('prints a line per problem, with the same exit code as --json', async () => {
    const dir = tempCopy('project');
    const io = memIo(dir);
    const code = await main(['check', '--offline', '--gcc'], io);
    const lines = io.stdoutText().trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines)
      expect(l).toMatch(/^(\S.*:\d+:1|overfull): (error|warning|note): .* \[[a-z0-9-]+\]$/);
    const json = memIo(dir);
    expect(await main(['check', '--offline', '--json'], json)).toBe(code);
    const count = (JSON.parse(json.stdoutText()) as Report).checks.flatMap(
      (c) => c.problems,
    ).length;
    expect(lines).toHaveLength(count);
  });

  it('--write gcc=file writes the same lines; --gcc cannot be combined with --json', async () => {
    const dir = tempCopy('project');
    const io = memIo(dir);
    await main(['check', '--offline', '--gcc', '--write', 'gcc=problems.txt'], io);
    expect(readFileSync(join(dir, 'problems.txt'), 'utf8')).toBe(io.stdoutText());
    const both = memIo(dir);
    expect(await main(['check', '--offline', '--gcc', '--json'], both)).toBe(2);
    expect(both.stderrText() + both.stdoutText()).toContain('one output format');
  });
});

describe('init --here --vscode', () => {
  it('writes .vscode/tasks.json only when asked, and not with --all', async () => {
    const dir = tempCopy('adopt/neurips-style');
    expect(await main(['init', '--here', '--all'], memIo(dir))).toBe(0);
    expect(existsSync(join(dir, '.vscode/tasks.json'))).toBe(false);
    const io = memIo(dir);
    expect(await main(['init', '--here', '--vscode'], io)).toBe(0);
    expect(io.stdoutText()).toContain('.vscode/tasks.json');
    const written = JSON.parse(readFileSync(join(dir, '.vscode/tasks.json'), 'utf8'));
    expect(written.tasks[0].args).toEqual(['check', '--gcc']);
    expect(written.tasks[0].problemMatcher.fileLocation).toEqual([
      'relative',
      `\${workspaceFolder}`,
    ]);
  });

  it('never overwrites an existing tasks.json, even with --force', async () => {
    const dir = tempCopy('adopt/neurips-style');
    mkdirSync(join(dir, '.vscode'));
    writeFileSync(join(dir, '.vscode/tasks.json'), '{"version":"2.0.0","tasks":[]}\n');
    const io = memIo(dir);
    expect(await main(['init', '--here', '--vscode', '--force'], io)).toBe(0);
    expect(readFileSync(join(dir, '.vscode/tasks.json'), 'utf8')).toBe(
      '{"version":"2.0.0","tasks":[]}\n',
    );
    expect(io.stdoutText()).toContain('add the task from the CLI guide by hand');
  });

  it('is only for --here', async () => {
    const io = memIo(tempCopy('adopt/neurips-style'));
    expect(await main(['init', 'paper', 'x', '--vscode'], io)).toBe(2);
  });
});
