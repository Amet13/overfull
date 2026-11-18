/** Reference summary counts and the wording of lookup-incomplete messages. */
import { describe, expect, it } from 'vitest';
import {
  formatHuman,
  formatMarkdown,
  type RefResult,
  type Report,
  refsCheck,
} from '../src/index.js';

const results: RefResult[] = [
  { key: 'ok', status: 'verified', source: 'crossref' },
  {
    key: 'wrongdoi',
    status: 'mismatch',
    source: 'doi.org',
    wrongWork: { field: 'doi', id: '10.1/x', title: 'Another Paper' },
    differences: [{ field: 'doi', bib: '10.1/x', record: 'resolves to “Another Paper”' }],
    matched: { title: 'Another Paper', authors: [], doi: '10.1/x' },
  },
  {
    key: 'year',
    status: 'mismatch',
    source: 'crossref',
    differences: [{ field: 'year', bib: '1981', record: '1978' }],
  },
  {
    key: 'book1',
    status: 'unverifiable',
    reason: 'no match found, but books are often not indexed (lookup incomplete: x)',
    failures: [
      {
        source: 'dblp',
        reason: 'dblp.org answered HTTP 503 (repeatedly; skipped for the rest of this run)',
      },
      { source: 'crossref', reason: 'api.crossref.org: timed out after 4000 ms' },
    ],
  },
  {
    key: 'lost',
    status: 'error',
    failed: ['crossref', 'dblp'],
    failures: [
      { source: 'crossref', reason: 'api.crossref.org: timed out after 4000 ms' },
      { source: 'dblp', reason: 'dblp.org answered HTTP 503' },
    ],
    reason:
      'lookup incomplete: api.crossref.org: timed out after 4000 ms; dblp.org answered HTTP 503',
  },
];

function report(): Report {
  const check = refsCheck(results);
  return {
    tool: 'overfull',
    version: 'test',
    status: 'warn',
    checks: [check],
    problems: check.problems,
    summary: {},
  } as unknown as Report;
}

describe('reference summary', () => {
  it('counts wrong-work results as their own group', () => {
    const check = refsCheck(results);
    expect(check.summary).toBe(
      '1 of 5 references verified (1 with differing metadata, 1 with an identifier that points to another work, 1 could not be checked, 1 not checkable automatically)',
    );
    const listed = check.problems
      .map((p) => p.rule)
      .filter((r) => r === 'reference-doi-wrong-work');
    expect(listed).toHaveLength(1);
  });

  it('keeps JSON data fields unchanged', () => {
    const check = refsCheck(results);
    const lost = check.problems.find((p) => p.data?.key === 'lost');
    expect(lost?.data).toEqual({ key: 'lost', status: 'error' });
    const book = check.problems.find((p) => p.data?.key === 'book1');
    expect(book?.data).toEqual({ key: 'book1', status: 'unverifiable' });
  });
});

describe('lookup-incomplete messages', () => {
  it('uses one sentence and a per-source detail, without nested brackets', () => {
    const check = refsCheck(results);
    const book = check.problems.find((p) => p.data?.key === 'book1');
    expect(book?.message).toBe(
      '`book1` could not be checked automatically: no match found, but books are often not indexed',
    );
    expect(book?.detail).toBe(
      'The lookup was incomplete. dblp: answered HTTP 503 (repeatedly; skipped for the rest of this run).\n' +
        'CrossRef: timed out after 4000 ms.',
    );
    const lost = check.problems.find((p) => p.data?.key === 'lost');
    expect(lost?.message).toBe(
      '`lost` could not be checked because CrossRef and dblp did not answer',
    );
    expect(lost?.detail).toBe(
      'CrossRef: timed out after 4000 ms.\ndblp: answered HTTP 503. A network problem is not evidence against the reference.',
    );
    for (const p of [book, lost]) expect(p?.message).not.toMatch(/\([^)]*\(/);
  });

  it('renders in the human format', () => {
    const short = formatHuman(report(), { color: false });
    expect(short).toContain(
      '  ! `lost` could not be checked because CrossRef and dblp did not answer  reference-lookup-failed',
    );
    expect(short).toContain('1 to fix · 2 to review · 1 note · 0 passed');
    expect(short).not.toContain('why:');
    expect(short).toMatchSnapshot();
    const verbose = formatHuman(report(), { color: false, verbose: true });
    // Detail lines join into one line in the terminal.
    expect(verbose).toContain(
      '    why: The lookup was incomplete. dblp: answered HTTP 503 (repeatedly; skipped for the rest of this run). CrossRef: timed out after 4000 ms.',
    );
    expect(verbose).toContain('    fix: Check this entry by hand; add a DOI where one exists.');
    expect(verbose).toMatchSnapshot();
  });

  it('renders in Markdown', () => {
    const md = formatMarkdown(report());
    expect(md).toMatch(/^## Overfull preflight: WARN\n/);
    expect(md).toContain('| references | fail | 1 of 5 references verified');
    // Angle brackets and pipes in fixes are escaped for GitHub Markdown.
    expect(md).toContain('<code>overfull cite &lt;doi &#124; arXiv:id&gt;</code>');
    expect(md).toContain('<sub>reference-unverifiable</sub>');
    expect(md).toMatchSnapshot();
  });
});
