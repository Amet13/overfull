import { describe, expect, it } from 'vitest';
import { formatBibEntry } from '../src/bib/index.js';
import {
  entryFromPublisherBibtex,
  escapeLooseTex,
  htmlUnescape,
  sanitizeTexValue,
  stripPictographs,
} from '../src/refs/entry.js';
import { lookup } from '../src/refs/index.js';
import { handlerFetch, readFixture } from './fixtures/refs/fake-fetch.js';
import { fast } from './helpers.js';

describe('R11: publisher BibTeX is sanitized', () => {
  it('neutralizes \\input and friends in a DataCite-like title, keeps accents', () => {
    const bib = `@misc{x, title = {Data for \\input{/etc/passwd} G\\"odel \\textit{et al.} \\immediate\\write18{rm -rf ~} ^^5cinput{x}},
  author = {M\\"uller, J.}, publisher = {Zenodo \\csname foo\\endcsname}, year = {2024}}`;
    const e = entryFromPublisherBibtex(bib, '10.5281/zenodo.1');
    const title = e?.fields.title ?? '';
    expect(title).not.toMatch(/\\input/);
    expect(title).not.toMatch(/\\immediate|\\write/);
    expect(title).not.toContain('^^');
    expect(title).toContain('\\textbackslash{}input{/etc/passwd}');
    expect(title).toContain('G\\"odel');
    expect(title).toContain('\\textit{et al.}');
    expect(e?.fields.author).toBe('M\\"uller, J.');
    expect(e?.fields.publisher).not.toMatch(/\\csname/);
    expect(sanitizeTexValue('\\DeclareRobustCommand\\x{}')).toContain('\\textbackslash{}');
    expect(sanitizeTexValue('$x^2$ \\emph{a}')).toBe('$x^2$ \\emph{a}');
  });
});

describe('A2: cite writes clean, escaped values (recorded doi.org responses)', () => {
  const recorded = JSON.parse(readFixture('doi-escaping.json')) as Record<
    string,
    { csl: string; bibtex: string }
  >;
  const doiFetch = handlerFetch((u, accept) => {
    const doi = decodeURIComponent(u.pathname.slice(1)).toLowerCase();
    const r = recorded[doi];
    if (u.host !== 'doi.org' || !r) return new Response('', { status: 404 });
    return accept.includes('bibtex')
      ? new Response(r.bibtex, { headers: { 'content-type': 'application/x-bibtex' } })
      : new Response(r.csl, {
          headers: { 'content-type': 'application/vnd.citationstyles.csl+json' },
        });
  });

  it('KDD: &amp; becomes \\& (not &amp; and not a bare &)', async () => {
    const r = await lookup('10.1145/3292500.3330701', { fetch: doiFetch.fetch, ...fast });
    const booktitle = r?.entry.fields.booktitle ?? '';
    expect(booktitle).toContain('Knowledge Discovery \\& Data Mining');
    expect(booktitle).not.toContain('&amp;');
    expect(formatBibEntry(r?.entry as NonNullable<typeof r>['entry'])).not.toMatch(/[^\\]&/);
    // ACM's BibTeX has `collection` (not a BibTeX field) next to `series`: only `series` stays.
    expect(r?.entry.fields.collection).toBeUndefined();
    expect(r?.entry.fields.series).toBeDefined();
  });

  it('FAccT: the parrot emoji is dropped without a trailing space', async () => {
    const r = await lookup('10.1145/3442188.3445922', { fetch: doiFetch.fetch, ...fast });
    expect(r?.entry.fields.title).toBe(
      'On the Dangers of Stochastic Parrots: Can Language Models Be Too Big?',
    );
  });

  it('helpers', () => {
    expect(htmlUnescape('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2014;')).toBe(
      'a & b <c> "d" \'e\' —',
    );
    expect(stripPictographs('Too Big? 🦜')).toBe('Too Big?');
    expect(stripPictographs('A 👩‍💻 coder ❤️ x')).toBe('A coder x');
    expect(escapeLooseTex('R&D 50% #1 a_b $x_1$ \\& ok')).toBe(
      'R\\&D 50\\% \\#1 a\\_b $x_1$ \\& ok',
    );
  });
});

describe('P0-7: publisher BibTeX keeps only an allowlist of TeX commands', () => {
  /** Control words left in `s`, other than the ones the sanitizer itself writes. */
  const keptWords = (s: string) =>
    [...s.matchAll(/\\([A-Za-z]+)/g)]
      .map((m) => m[1])
      .filter((w) => w !== 'textbackslash' && w !== 'textasciicircum');

  const payloads = [
    '\\pdfextension obj file{/etc/passwd}',
    '\\pdfextension annot{/Subtype/FileAttachment}',
    '\\pdffeedback{lastobj}',
    '\\pdfobj file{/home/user/.ssh/id_rsa}',
    '\\immediate\\pdfobj stream file {secret.txt}',
    '\\filedump{offset=0}{secret}',
    '\\luaescapestring{x}',
    '\\input{/etc/passwd}',
    '\\directlua{os.execute("id")}',
    '\\catcode`\\@=0 @input x',
    '\\csname input\\endcsname{x}',
    '\\write18{curl evil}',
    '\\immediate\\write18{rm}',
    '\\openin1=secret \\read1 to\\x',
    '\\read16 to \\x',
    '\\pdffiledump{/etc/passwd}',
    '\\pdfmdfivesum file{x}',
    '\\XeTeXpdffile "x.pdf"',
    '\\special{pdf: embed}',
    '\\@input{x}',
    '\\IfFileExists{x}{}{}',
    '\\ExplSyntaxOn \\file_input:n {x}',
    '$\\input{x}$',
    '$\\directlua{os.exit()}$',
    '^^5cinput{x}',
    '\\^^5cinput{x}',
    'trailing \\',
  ];

  it.each(payloads)('neutralizes %s', (payload) => {
    const out = sanitizeTexValue(payload);
    expect(keptWords(out)).toEqual([]);
    expect(out).not.toContain('^^');
    // Every backslash left is either our \textbackslash or a control symbol that prints.
    for (const m of out.matchAll(/\\(.)/g))
      expect(m[1], out).toMatch(/[A-Za-z"'`^~=.&%#_${},;:!\-/ |\\\n\t]/);
  });

  it('neutralizes the payloads in every field of a fetched entry', async () => {
    const bib = `@misc{x, title = {Data \\pdfextension obj file{/etc/passwd}}, author = {Doe, J. \\pdffeedback x},
  note = {\\filedump{secret}}, howpublished = {\\input{x}}, publisher = {Zenodo \\luaescapestring{x}},
  year = {2024}, version = {\\pdfobj file{x} \\directlua{x} \\csname x\\endcsname}}`;
    const f = handlerFetch((u, accept) => {
      if (u.host !== 'doi.org') return new Response('', { status: 404 });
      return accept.includes('bibtex')
        ? new Response(bib, { headers: { 'content-type': 'application/x-bibtex' } })
        : new Response(
            JSON.stringify({ type: 'dataset', title: 'Data', author: [{ family: 'Doe' }] }),
            { headers: { 'content-type': 'application/vnd.citationstyles.csl+json' } },
          );
    });
    const r = await lookup('10.5281/zenodo.99', { fetch: f.fetch, ...fast });
    const text = formatBibEntry(r?.entry as NonNullable<typeof r>['entry']);
    for (const name of [
      'pdfextension',
      'pdffeedback',
      'filedump',
      'input',
      'luaescapestring',
      'pdfobj',
      'directlua',
      'csname',
    ])
      expect(text).not.toMatch(new RegExp(`(?<!textbackslash\\{\\})\\\\${name}`));
    expect(text).toContain('\\textbackslash{}pdfextension obj file{/etc/passwd}');
  });

  it('keeps accents, special letters, formatting and escaped specials', () => {
    const kept = [
      'G\\"odel',
      "Erd\\H{o}s and Caf\\'e",
      '\\c{C}a\\u{g}lar \\v{S}koda \\k{a} \\r{A}ngstr\\"om',
      "{\\ss} {\\o} {\\AE} {\\L}\\'od\\'z {\\i}",
      '\\textit{et al.} \\textbf{bold} \\emph{e} \\textsc{Sc}',
      '{\\it old} {\\bf style}',
      'H\\textsubscript{2}O and x\\textsuperscript{2}',
      'R\\&D 50\\% \\#1 a\\_b \\$5 \\{x\\}',
      'A{\\textendash}B {\\textemdash} {\\textquoteright}',
      '{\\LaTeX} and {\\TeX}',
      'line\\\\break and a\\-hyphen',
    ];
    for (const v of kept) expect(sanitizeTexValue(v)).toBe(v);
  });

  it('keeps math made of allowed commands and escapes the rest', () => {
    expect(sanitizeTexValue('$x^2$ and $\\alpha \\leq \\mathcal{O}(n \\log n)$')).toBe(
      '$x^2$ and $\\alpha \\leq \\mathcal{O}(n \\log n)$',
    );
    expect(sanitizeTexValue('$\\mathsemicolon$ $\\less$ $\\frac{1}{2}$')).toBe(
      '$\\mathsemicolon$ $\\less$ $\\frac{1}{2}$',
    );
    // A math-only command outside math is printed, not run.
    expect(sanitizeTexValue('\\alpha')).toBe('\\textbackslash{}alpha');
  });

  it('a kept command at the end cannot merge with the text that follows', () => {
    expect(sanitizeTexValue('Stra\\ss')).toBe('Stra\\ss{}');
    expect(sanitizeTexValue('x \\i')).toBe('x \\i{}');
  });
});
