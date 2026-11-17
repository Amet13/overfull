/** Every format lists problems in one order and renders `code` the same way. */
import { describe, expect, it } from 'vitest';
import {
  formatHtml,
  formatHuman,
  formatMarkdown,
  formatSarif,
  githubAnnotations,
  sortedProblems,
} from '../src/report/index.js';
import type { Problem, Report } from '../src/types.js';

const p = (rule: string, over: Partial<Problem>): Problem => ({
  rule,
  check: 'output',
  severity: 'warning',
  message: `message of ${rule}`,
  ...over,
});

const report: Report = {
  tool: 'overfull',
  version: '9.9.9',
  status: 'fail',
  checks: [
    {
      check: 'output',
      status: 'fail',
      problems: [
        p('rule-page-only', { location: { page: 2 } }),
        p('rule-no-location', {}),
        p('rule-b-file', { location: { file: 'b.tex', line: 1 } }),
        p('rule-a-file-line9', { location: { file: 'a.tex', line: 9 } }),
        p('rule-a-file-line3', { location: { file: 'a.tex', line: 3 } }),
        p('rule-output-error', { severity: 'error', location: { page: 1 } }),
        p('rule-output-note', { severity: 'info', location: { file: 'a.tex', line: 1 } }),
      ],
    },
    {
      check: 'build',
      status: 'fail',
      problems: [
        p('rule-build-error', {
          check: 'build',
          severity: 'error',
          location: { file: 'z.tex', line: 1 },
        }),
      ],
    },
  ],
};

const expected = [
  'rule-build-error',
  'rule-output-error',
  'rule-a-file-line3',
  'rule-a-file-line9',
  'rule-b-file',
  'rule-no-location',
  'rule-page-only',
  'rule-output-note',
];

/** Rule ids in the order they first appear in `text`. */
function orderIn(text: string): string[] {
  return expected
    .map((rule) => ({ rule, at: text.indexOf(rule) }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.rule);
}

/** The same order within one check (formats that group by check keep check order). */
const withinOutput = expected.filter((r) => r !== 'rule-build-error');

describe('one problem order for every format', () => {
  it('sortedProblems', () => {
    expect(sortedProblems(report).map((x) => x.rule)).toEqual(expected);
  });

  it.each([
    ['human', () => formatHuman(report, { verbose: true })],
    ['SARIF', () => formatSarif(report)],
    ['annotations', () => githubAnnotations(report).join('\n')],
  ])('%s', (_name, render) => {
    expect(orderIn(render())).toEqual(expected);
  });

  it.each([
    ['Markdown', () => formatMarkdown(report)],
    ['HTML', () => formatHtml(report)],
  ])('%s (grouped by check)', (_name, render) => {
    const out = render();
    const outputPart = out.slice(out.lastIndexOf('output'));
    expect(orderIn(outputPart).filter((r) => r !== 'rule-build-error')).toEqual(withinOutput);
  });
});

describe('backtick code spans', () => {
  const one = (message: string): Report => ({
    ...report,
    checks: [{ check: 'output', status: 'warn', problems: [p('r', { message, fix: message })] }],
  });

  it('renders matched pairs as code in Markdown and HTML', () => {
    const message = 'Use `\\url{}` and `a|b`';
    expect(formatMarkdown(one(message))).toContain(
      'Use <code>\\url{}</code> and <code>a&#124;b</code>',
    );
    expect(formatHtml(one(message))).toContain('Use <code>\\url{}</code> and <code>a|b</code>');
  });

  it('keeps an unmatched backtick as text in both', () => {
    const message = 'Quote `x` then a lone ` and *bold*';
    const md = formatMarkdown(one(message));
    expect(md).toContain('Quote <code>x</code> then a lone \\` and \\*bold\\*');
    expect(md).not.toContain('<code> and');
    const html = formatHtml(one(message));
    expect(html).toContain('Quote <code>x</code> then a lone ` and *bold*');
  });
});
