/** attributeBibliography: errors LaTeX reports inside the typeset bibliography point at the .bib entry. */
import { describe, expect, it } from 'vitest';
import { attributeBibliography } from '../src/log/index.js';
import type { Problem } from '../src/types.js';
import { LINEAR_BUDGET_MS } from './linear-time.js';

const BIBTEX_BBL = `\\begin{thebibliography}{2}

\\bibitem{lamport1978time}
L.~Lamport.
\\newblock Time, clocks, and the ordering of events.
\\newblock {\\em CACM}, 1978.

\\bibitem[Smith(2020)]{smith2020speed}
J.~Smith.
\\newblock Speedups in R&D pipelines.
\\newblock 2020.

\\end{thebibliography}
`;

const BIBLATEX_BBL = `\\refsection{0}
  \\datalist[entry]{nty/global//global/global}
    \\entry{knuth1984}{book}{}
      \\field{title}{The TeXbook}
    \\endentry
    \\entry{smith2020speed}{article}{}
      \\field{title}{Speedups in R&D pipelines}
    \\endentry
  \\enddatalist
\\endrefsection
`;

const BIBS = [
  {
    file: 'refs/a.bib',
    text: '@article{lamport1978time, title = {Time}, year = {1978}}\n',
  },
  {
    file: 'refs/b.bib',
    text: '\n\n@misc{smith2020speed, title = {Speedups in R\\&D pipelines}, year = {2020}}\n@book{knuth1984, title = {The TeXbook}}\n',
  },
];

const TEX = [
  {
    path: 'main.tex',
    content: `${'\n'.repeat(39)}\\printbibliography\n\\end{document}\n`,
  },
];

const problem = (over: Partial<Problem>): Problem => ({
  rule: 'misplaced-alignment-tab',
  check: 'build',
  severity: 'error',
  message: 'Misplaced alignment tab character &',
  ...over,
});

describe('attributeBibliography', () => {
  it('BibTeX: an error at a .bbl line moves to the .bib entry of the \\bibitem above it', () => {
    const [p] = attributeBibliography([problem({ location: { file: './main.bbl', line: 11 } })], {
      bbl: { path: 'main.bbl', text: BIBTEX_BBL },
      bibs: BIBS,
    });
    expect(p?.message).toBe(
      'Misplaced alignment tab character & in the bibliography entry `smith2020speed`',
    );
    expect(p?.location).toEqual({ file: 'refs/b.bib', line: 3 });
    expect(p?.data).toMatchObject({
      bibKey: 'smith2020speed',
      reportedAt: { file: './main.bbl', line: 11 },
    });
  });

  it('BibTeX: the first entry is found too', () => {
    const [p] = attributeBibliography([problem({ location: { file: 'main.bbl', line: 5 } })], {
      bbl: { path: 'main.bbl', text: BIBTEX_BBL },
      bibs: BIBS,
    });
    expect(p?.data?.bibKey).toBe('lamport1978time');
    expect(p?.location).toEqual({ file: 'refs/a.bib', line: 1 });
  });

  it('biblatex: an error at the .tex line is matched through the argument TeX showed', () => {
    const [p] = attributeBibliography(
      [
        problem({
          location: { file: 'main.tex', line: 40 },
          evidence: '! Misplaced alignment tab character &.\n<argument> Speedups in R&\n',
        }),
      ],
      { bbl: { path: 'main.bbl', text: BIBLATEX_BBL }, bibs: BIBS, texFiles: TEX },
    );
    expect(p?.data?.bibKey).toBe('smith2020speed');
    expect(p?.location).toEqual({ file: 'refs/b.bib', line: 3 });
  });

  it('biblatex: an error before \\printbibliography keeps its place even if its text is in the .bbl', () => {
    const body = problem({
      location: { file: 'main.tex', line: 12 },
      evidence: '! Misplaced alignment tab character &.\n<argument> Speedups in R&\n',
    });
    const src = { bbl: { path: 'main.bbl', text: BIBLATEX_BBL }, bibs: BIBS };
    expect(attributeBibliography([body], { ...src, texFiles: TEX })).toEqual([body]);
    // Without the sources the place of the bibliography is unknown: nothing is moved.
    const atPrint = { ...body, location: { file: 'main.tex', line: 40 } };
    expect(attributeBibliography([atPrint], src)).toEqual([atPrint]);
    // Another file than the one that prints the bibliography.
    const other = { ...body, location: { file: 'intro.tex', line: 90 } };
    expect(attributeBibliography([other], { ...src, texFiles: TEX })).toEqual([other]);
  });

  it('finds entries in a large .bbl in linear time', () => {
    const n = 20_000;
    const bbl = Array.from(
      { length: n },
      (_, i) => `\\bibitem{k${i}}\nA.~Author.\n\\newblock Title ${i}.\n`,
    ).join('\n');
    const problems = Array.from({ length: 2000 }, (_, i) =>
      problem({ location: { file: 'main.bbl', line: 4 * (i * 10) + 2 } }),
    );
    const start = performance.now();
    const out = attributeBibliography(problems, { bbl: { path: 'main.bbl', text: bbl }, bibs: [] });
    expect(performance.now() - start).toBeLessThan(LINEAR_BUDGET_MS);
    expect(out[1]?.data?.bibKey).toBe('k10');
    expect(out[1999]?.data?.bibKey).toBe('k19990');
  });

  it('leaves a problem alone when nothing ties it to an entry', () => {
    const input = [
      problem({ location: { file: 'main.tex', line: 3 }, evidence: '<argument> short' }),
      problem({ location: { file: 'main.tex', line: 9 } }),
    ];
    expect(
      attributeBibliography(input, { bbl: { path: 'main.bbl', text: BIBLATEX_BBL }, bibs: BIBS }),
    ).toEqual(input);
  });

  it('keeps the .bbl message when the key is in no .bib file, and the location when no .bbl', () => {
    const [p] = attributeBibliography([problem({ location: { file: 'main.bbl', line: 11 } })], {
      bbl: { path: 'main.bbl', text: BIBTEX_BBL },
      bibs: [],
    });
    expect(p?.data?.bibKey).toBe('smith2020speed');
    expect(p?.location).toEqual({ file: 'main.bbl', line: 11 });
    const untouched = [problem({ location: { file: 'main.bbl', line: 11 } })];
    expect(attributeBibliography(untouched, { bibs: BIBS })).toBe(untouched);
    expect(
      attributeBibliography(untouched, {
        bbl: { path: 'main.bbl', text: 'no entries' },
        bibs: BIBS,
      }),
    ).toBe(untouched);
  });

  it('does not attribute a problem twice', () => {
    const once = problem({ data: { bibKey: 'x' }, location: { file: 'main.bbl', line: 11 } });
    const [p] = attributeBibliography([once], {
      bbl: { path: 'main.bbl', text: BIBTEX_BBL },
      bibs: BIBS,
    });
    expect(p).toBe(once);
  });
});
