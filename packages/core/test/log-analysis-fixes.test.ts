/** Bibliography tool choice, rerun folding, boxes spanning files and message plurals. */
import { describe, expect, it } from 'vitest';
import { analyzeLog } from '../src/log/index.js';

const banner =
  'This is pdfTeX, Version 3.141592653-2.6-1.40.29 (TeX Live 2026) (preloaded format=pdflatex)';
const sty = (name: string) => `(/usr/local/texlive/2026/texmf-dist/tex/latex/${name}/${name}.sty)`;

const rules = (text: string) => analyzeLog(text).output.problems.map((p) => p.rule);
const problem = (text: string, rule: string) =>
  analyzeLog(text).output.problems.find((p) => p.rule === rule);

describe('missing .bbl: the bibliography tool and job name', () => {
  const missing = (...lines: string[]) =>
    [
      banner,
      '(./paper.tex',
      'LaTeX2e <2025-11-01>',
      ...lines,
      'No file paper.bbl.',
      '',
      "LaTeX Warning: Citation `knuth84' on page 1 undefined on input line 5.",
      '',
      '[1]',
      'LaTeX Warning: There were undefined references.',
      '',
      ' )',
      'Output written on paper.pdf (1 page, 1234 bytes).',
    ].join('\n');

  it('says BibTeX for a natbib project and uses the job name from the .bbl', () => {
    const p = problem(missing(sty('natbib')), 'bibliography-missing');
    expect(p?.message).toContain('BibTeX was not run');
    expect(p?.fix).toContain('`bibtex paper`');
    expect(p?.data).toMatchObject({ tool: 'BibTeX' });
  });

  it('says BibTeX for a plain \\bibliography project', () => {
    const p = problem(missing(), 'bibliography-missing');
    expect(p?.message).toContain('BibTeX');
    expect(p?.fix).not.toContain('biber');
  });

  it('says Biber when biblatex is loaded', () => {
    const p = problem(missing(sty('biblatex')), 'bibliography-missing');
    expect(p?.message).toContain('Biber was not run');
    expect(p?.fix).toContain('`biber paper`');
  });

  it('says BibTeX when biblatex asks for BibTeX (backend=bibtex)', () => {
    const p = problem(
      missing(
        sty('biblatex'),
        'Package biblatex Warning: Please (re)run BibTeX on the file(s):',
        '(biblatex)                paper',
        '(biblatex)                and rerun LaTeX afterwards.',
        '',
      ),
      'bibliography-missing',
    );
    expect(p?.message).toContain('BibTeX was not run');
    expect(p?.fix).toContain('`bibtex paper`');
  });

  it('takes the job name from the biblatex warning when the .bbl exists but is stale', () => {
    const text = [
      banner,
      `(./thesis.tex ${sty('biblatex')}`,
      '(./thesis.bbl)',
      'Package biblatex Warning: Please (re)run Biber on the file:',
      '(biblatex)                thesis',
      '(biblatex)                and rerun LaTeX afterwards.',
      '',
      ')',
    ].join('\n');
    const p = problem(text, 'bibliography-stale');
    expect(p?.fix).toContain('`biber thesis`');
  });
});

describe('undefined references and reruns', () => {
  const withRerun = (...rerun: string[]) =>
    [
      banner,
      '(./main.tex',
      "LaTeX Warning: Reference `sec:gone' on page 1 undefined on input line 7.",
      '',
      '[1]',
      ...rerun,
      ')',
    ].join('\n');

  it('folds undefined references into the rerun when labels changed', () => {
    const text = withRerun(
      'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
      '',
    );
    expect(rules(text)).toEqual(['rerun-needed']);
    expect(problem(text, 'rerun-needed')).toMatchObject({ severity: 'error', related: 1 });
  });

  it('keeps undefined references when only the outlines changed (rerunfilecheck)', () => {
    const text = withRerun(
      "Package rerunfilecheck Warning: File `main.out' has changed.",
      '(rerunfilecheck)                Rerun to get outlines right',
      "(rerunfilecheck)                or use package `bookmark'.",
      '',
    );
    expect(rules(text).sort()).toEqual(['rerun-needed', 'undefined-reference']);
    const rerun = problem(text, 'rerun-needed');
    expect(rerun?.severity).toBe('warning');
    expect(rerun?.message).toBe('LaTeX needs another run');
    expect(rerun?.related).toBeUndefined();
  });

  it('keeps undefined references when longtable asks for a rerun', () => {
    const text = withRerun(
      'Package longtable Warning: Table widths have changed. Rerun LaTeX.',
      '',
    );
    expect(rules(text)).toContain('undefined-reference');
  });
});

describe('overfull boxes spanning files (lines 13--1)', () => {
  const log = (error: string[]) =>
    [
      'This is LuaHBTeX, Version 1.18.0',
      '(./main.tex',
      '(./related.tex',
      ...error,
      ')',
      'Overfull \\hbox (25.0pt too wide) in paragraph at lines 13--1',
      '[]\\TU/lmr/m/n/10 text',
      '',
      ')',
    ].join('\n');
  const undefinedAt = (line: number) => [
    '! Undefined control sequence.',
    `l.${line} \\foo`,
    '              bar',
    '',
  ];

  it('is dropped when an error sits in the part of the paragraph in the earlier file', () => {
    expect(analyzeLog(log(undefinedAt(14))).parsed.warnings[0]?.data).toMatchObject({
      spansFiles: true,
      fromFile: 'related.tex',
    });
    expect(rules(log(undefinedAt(14)))).not.toContain('overfull-box');
  });

  it('is kept when the error is before the paragraph began', () => {
    expect(rules(log(undefinedAt(5)))).toContain('overfull-box');
  });
});

describe('plurals in messages', () => {
  it('writes "overfull boxes"', () => {
    const box = (line: number) => [
      `Overfull \\hbox (${20 + line}.0pt too wide) in paragraph at lines ${line}--${line}`,
      '[]\\TU/lmr/m/n/10 text',
      '',
    ];
    const text = [
      'This is LuaHBTeX, Version 1.18.0',
      '(./main.tex',
      ...box(1),
      ...box(2),
      ...box(3),
      ')',
    ].join('\n');
    const message = problem(text, 'overfull-box')?.message ?? '';
    expect(message).toContain('2 more overfull boxes in this file');
    expect(message).not.toContain('boxs');
  });
});

describe('errors raised inside a distribution package while it loads', () => {
  it('point at the project file that loaded the package, not at the package line', () => {
    const text = [
      banner,
      '(./main.tex',
      '(/usr/local/texlive/2026/texmf-dist/tex/latex/amsmath/amsmath.sty',
      "! LaTeX Error: Unknown option `sumlimit' for package `amsmath'.",
      '',
      'See the LaTeX manual or LaTeX Companion for explanation.',
      'Type  H <return>  for immediate help.',
      ' ...                                              ',
      '                                                  ',
      'l.97 \\ProcessOptions\\par',
      '                         ',
      ')',
      ')',
    ].join('\n');
    const p = analyzeLog(text).build.problems[0];
    expect(p?.rule).toBe('unknown-package-option');
    expect(p?.location).toEqual({ file: 'main.tex' });
  });
});
