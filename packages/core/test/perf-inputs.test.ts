/**
 * Crafted ~1 MB inputs that made regexes or scans quadratic. Each must finish within
 * the linear-time budget (see linear-time.ts); before the fixes they took seconds to
 * minutes.
 */
import { describe, expect, it } from 'vitest';
import { hasOthers, parseBib, parseNames } from '../src/bib/index.js';
import { analyzeLog, attributeBibliography, parseLog } from '../src/log/index.js';
import { stripCdata } from '../src/refs/normalize.js';
import { findCommands, grepTex } from '../src/venue/tex.js';
import { LINEAR_BUDGET_MS as LIMIT_MS, timed } from './linear-time.js';

const MB = 1_000_000;

function fill(unit: string, size = MB): string {
  return unit.repeat(Math.ceil(size / unit.length));
}

describe('1 MB crafted logs stay linear', () => {
  const logs: Record<string, string> = {
    'font shape continuation': `LaTeX Font Warning: Font shape \`x\n${fill("(Font)              ' undefined using `y\n")}`,
    'hyperref token continuation': `Package hyperref Warning: Token not allowed in a PDF string (Unicode):\n${fill('(hyperref)                removing `x\n')}`,
    'citation continuation': `LaTeX Warning: Citation \`a\n${fill("        ' on page `x\n")}`,
    'missing character': `Missing character: There is no x ${fill('in font ')}\n`,
    'runaway argument': `Runaway argument?\n{${' '.repeat(MB)}x\n! Paragraph ended before \\foo was complete.\n`,
    'paragraph ended spaces': `! Paragraph ended before \\foo${' '.repeat(MB)}x\n`,
    'fontspec error': `! Package fontspec Error: ${fill('font "a" ')}\n`,
    'file-line-error with spaces': `./${fill('a ')}\n`,
    'spaced file token': `(./a${fill(' b')}\n`,
    'many spaced file tokens': `${fill('(./a b ')}\n`,
    'LaTeX error file': `! LaTeX Error: File \`${fill("x' ")}\n`,
    'unmatched parentheses then warnings': `(./main.tex ${fill('(', MB / 2)}\n${fill('LaTeX Warning: Something on input line 1.\n\n', MB / 2)}`,
  };
  it.each(Object.keys(logs))('%s', (name) => {
    const text = logs[name] as string;
    expect(timed(() => analyzeLog(text))).toBeLessThan(LIMIT_MS);
  });

  it('caps the joined message length', () => {
    const parsed = parseLog(logs['font shape continuation'] as string);
    expect(parsed.warnings[0]?.message.length).toBeLessThanOrEqual(4096);
  });
});

describe('1 MB crafted bib and tex sources stay linear', () => {
  it('author field with a long run of spaces', () => {
    const author = `A${' '.repeat(MB)}x`;
    expect(timed(() => parseNames(author))).toBeLessThan(LIMIT_MS);
    expect(timed(() => hasOthers(author))).toBeLessThan(LIMIT_MS);
    expect(
      timed(() => parseBib(`@article{k, author={${author}}, title={T}, year={2020}}\n`)),
    ).toBeLessThan(LIMIT_MS);
  });

  it('still splits names and detects "and others"', () => {
    expect(parseNames('Doe, Jane   and  John Smith and others').map((n) => n.family)).toEqual([
      'Doe',
      'Smith',
    ]);
    expect(hasOthers('Doe, Jane and others ')).toBe(true);
    expect(hasOthers('Doe, Jane and Others')).toBe(true);
    expect(hasOthers('Doe, Jane andothers')).toBe(false);
  });

  it('unclosed command arguments and many matches', () => {
    const files = [
      { path: 'a.tex', content: fill('\\includegraphics{') },
      { path: 'b.tex', content: fill('\\includegraphics[') },
      { path: 'c.tex', content: fill('\\includegraphics{x}\n') },
    ];
    expect(timed(() => findCommands(files, ['includegraphics']))).toBeLessThan(LIMIT_MS);
    expect(timed(() => grepTex(files, /\\includegraphics/))).toBeLessThan(LIMIT_MS);
  });

  it('findCommands keeps arguments, optional arguments and lines', () => {
    const uses = findCommands(
      [
        {
          path: 'm.tex',
          content:
            'x\n\\includegraphics[width=1cm]{a{b}c}\n\\includegraphics{d} % \\includegraphics{e}\n',
        },
      ],
      ['includegraphics'],
    );
    expect(uses).toEqual([
      { file: 'm.tex', line: 2, name: 'includegraphics', optional: 'width=1cm', arg: 'a{b}c' },
      { file: 'm.tex', line: 3, name: 'includegraphics', arg: 'd' },
    ]);
  });
});

describe('1 MB .bbl files stay linear', () => {
  const at = (line: number) =>
    ({
      rule: 'tex-error',
      check: 'build',
      severity: 'error',
      message: 'x',
      location: { file: 'main.bbl', line },
    }) as const;
  it.each([
    ['many entries', fill('\\bibitem{k}\nA.~Author.\n\n')],
    ['unclosed optional labels', fill('\\bibitem[')],
    ['unclosed keys', fill('\\entry{')],
  ])('%s', (_name, text) => {
    const problems = Array.from({ length: 1000 }, (_, i) => at(i * 50 + 1));
    const bbl = { path: 'main.bbl', text };
    expect(timed(() => attributeBibliography(problems, { bbl, bibs: [] }))).toBeLessThan(LIMIT_MS);
  });
});

describe('bibliography attribution stays linear', () => {
  it('\\bibitem followed by a long run of whitespace and no brace', () => {
    const text = `\\bibitem${' \t'.repeat(MB / 4)}x`;
    expect(
      timed(() => attributeBibliography([], { bbl: { path: 'main.bbl', text } })),
    ).toBeLessThan(LIMIT_MS);
  });
});

describe('XML text from outside services stays linear', () => {
  it('many unclosed CDATA sections', () => {
    const text = fill('<![CDATA[a');
    expect(timed(() => stripCdata(text))).toBeLessThan(LIMIT_MS);
    expect(stripCdata(text)).toBe(text);
  });

  it('stripCdata keeps the content of closed sections and leaves the rest', () => {
    expect(stripCdata('a <![CDATA[<b>x</b>]]> c <![CDATA[y]]>')).toBe('a <b>x</b> c y');
    expect(stripCdata('a <![CDATA[open')).toBe('a <![CDATA[open');
    expect(stripCdata('<![CDATA[]]><![CDATA[z]]>')).toBe('z');
  });
});
