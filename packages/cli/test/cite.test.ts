import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AmbiguousLookupError, type BibEntry, type LookupResult } from '@overfull/core';
import { describe, expect, it } from 'vitest';
import { citeCommand, type LookupFn } from '../src/commands/cite.js';
import { memIo, tempCopy } from './helpers.js';

function entry(key: string, fields: Record<string, string>, type = 'inproceedings'): BibEntry {
  return { key, type, fields, line: 1, raw: '' };
}

const vaswani: LookupResult = {
  entry: entry('vaswani2017attention', {
    author: 'Vaswani, Ashish and Shazeer, Noam',
    title: 'Attention is All you Need',
    booktitle: 'Advances in Neural Information Processing Systems',
    year: '2017',
    doi: '10.48550/arXiv.1706.03762',
  }),
  source: 'crossref',
  confidence: 0.98,
};

const knuth: LookupResult = {
  entry: entry(
    'knuth1984literate',
    {
      author: 'Knuth, Donald E.',
      title: 'Literate Programming',
      journal: 'The Computer Journal',
      year: '1984',
      doi: '10.1093/COMJNL/27.2.97',
    },
    'article',
  ),
  source: 'doi.org',
  confidence: 1,
};

const fixed =
  (result: LookupResult | null): LookupFn =>
  async () =>
    result;

describe('overfull cite', () => {
  it('appends a formatted entry and prints the key last', async () => {
    const dir = tempCopy('project');
    const io = memIo(dir);
    const before = readFileSync(join(dir, 'references.bib'), 'utf8');
    expect(await citeCommand(['Attention is all you need'], io, fixed(vaswani))).toBe(0);
    const lines = io.stdoutText().trimEnd().split('\n');
    expect(lines.at(-1)).toBe('vaswani2017attention');
    const after = readFileSync(join(dir, 'references.bib'), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('@inproceedings{vaswani2017attention,');
    expect(after.endsWith('}\n')).toBe(true);
  });

  it('refuses a duplicate DOI and prints the existing key', async () => {
    const dir = tempCopy('project');
    const io = memIo(dir);
    const before = readFileSync(join(dir, 'references.bib'), 'utf8');
    expect(await citeCommand(['10.1093/comjnl/27.2.97'], io, fixed(knuth))).toBe(0);
    expect(io.stdoutText().trimEnd().split('\n').at(-1)).toBe('knuth1984');
    expect(readFileSync(join(dir, 'references.bib'), 'utf8')).toBe(before);
  });

  it('exits 1 and writes nothing without a confident match', async () => {
    const dir = tempCopy('project');
    const io = memIo(dir);
    const before = readFileSync(join(dir, 'references.bib'), 'utf8');
    expect(await citeCommand(['A paper that does not exist'], io, fixed(null))).toBe(1);
    expect(io.stdoutText()).toBe('');
    expect(io.stderrText()).toContain('Ask the author');
    expect(readFileSync(join(dir, 'references.bib'), 'utf8')).toBe(before);
  });

  it('supports --key, --dry-run and --json', async () => {
    const dir = tempCopy('project');
    const io = memIo(dir);
    const before = readFileSync(join(dir, 'references.bib'), 'utf8');
    expect(
      await citeCommand(['x', '--key', 'attn', '--dry-run', '--json'], io, fixed(vaswani)),
    ).toBe(0);
    const out = JSON.parse(io.stdoutText()) as Record<string, unknown>;
    expect(out).toMatchObject({ key: 'attn', source: 'crossref', confidence: 0.98, added: false });
    expect(out.entry).toMatch(/^@inproceedings\{attn,/);
    expect(readFileSync(join(dir, 'references.bib'), 'utf8')).toBe(before);
  });

  it('suffixes a generated key that is taken by a different work', async () => {
    const dir = tempCopy('project');
    writeFileSync(
      join(dir, 'references.bib'),
      '@misc{vaswani2017attention, title = {Something else}}\n',
    );
    const io = memIo(dir);
    await citeCommand(['x'], io, fixed(vaswani));
    expect(io.stdoutText().trimEnd().split('\n').at(-1)).toBe('vaswani2017attentionb');
  });

  it('rejects an explicit key used by a different entry', async () => {
    const io = memIo(tempCopy('project'));
    await expect(citeCommand(['x', '--key', 'rfc9110'], io, fixed(vaswani))).rejects.toThrow(
      /already used/,
    );
  });

  it('writes to --bib', async () => {
    const dir = tempCopy('project');
    const io = memIo(dir);
    await citeCommand(['x', '--bib', 'extra.bib'], io, fixed(vaswani));
    expect(readFileSync(join(dir, 'extra.bib'), 'utf8')).toMatch(
      /^@inproceedings\{vaswani2017attention,/,
    );
  });
});

describe('overfull cite: other outcomes', () => {
  const lastLine = (io: ReturnType<typeof memIo>) => io.stdoutText().trimEnd().split('\n').at(-1);

  it('finds an existing entry by arXiv id, or by the same key and title', async () => {
    const dir = tempCopy('project');
    writeFileSync(
      join(dir, 'references.bib'),
      '@misc{attn, title = {Attention}, eprint = {1706.03762}}\n' +
        '@misc{knuth1984literate, title = {Literate programming}}\n',
    );
    const arxiv: LookupResult = {
      ...vaswani,
      entry: entry('vaswani2017attention', { title: 'Attention', eprint: '1706.03762' }),
    };
    const io = memIo(dir);
    expect(await citeCommand(['x'], io, fixed(arxiv))).toBe(0);
    expect(io.stdoutText()).toContain('Already in references.bib as `attn`');
    const sameKey: LookupResult = {
      ...knuth,
      entry: entry('knuth1984literate', { title: 'Literate Programming' }, 'article'),
    };
    const io2 = memIo(dir);
    expect(await citeCommand(['x'], io2, fixed(sameKey))).toBe(0);
    expect(lastLine(io2)).toBe('knuth1984literate');
  });

  it('numbers a key once every letter suffix is taken', async () => {
    const dir = tempCopy('project');
    const keys = ['', ...'bcdefghijklmnopqrstuvwxyz'].map((c) => `vaswani2017attention${c}`);
    writeFileSync(
      join(dir, 'references.bib'),
      keys.map((k, i) => `@misc{${k}, title = {Other work ${i}}}\n`).join(''),
    );
    const io = memIo(dir);
    expect(await citeCommand(['x'], io, fixed(vaswani))).toBe(0);
    expect(lastLine(io)).toBe(`vaswani2017attention-${keys.length}`);
  });

  it('rejects a bad --key or --year, and a .bib path that is a directory', async () => {
    const dir = tempCopy('project');
    await expect(citeCommand(['x', '--key', 'a b'], memIo(dir), fixed(vaswani))).rejects.toThrow(
      /Invalid --key "a b"/,
    );
    await expect(citeCommand(['x', '--year', '17'], memIo(dir), fixed(vaswani))).rejects.toThrow(
      /--year must be a four-digit year/,
    );
    mkdirSync(join(dir, 'folder.bib'));
    await expect(
      citeCommand(['x', '--bib', 'folder.bib'], memIo(dir), fixed(vaswani)),
    ).rejects.toThrow(/EISDIR/);
  });

  it('lists the candidates of an ambiguous title', async () => {
    const io = memIo(tempCopy('project'));
    const ambiguous: LookupFn = async (query) => {
      throw new AmbiguousLookupError(query, [
        {
          title: 'One',
          authors: ['Doe, J.', 'Roe, R.'],
          year: 2020,
          venue: 'NeurIPS',
          doi: '10.1/a',
          source: 'crossref',
        },
        { title: 'Two', authors: ['Poe, E.'], arxivId: '2001.00001', source: 'arxiv' },
        { title: 'Three', authors: [], source: 'dblp' },
      ]);
    };
    expect(await citeCommand(['Deep learning'], io, ambiguous)).toBe(1);
    const err = io.stderrText();
    expect(err).toContain('"Deep learning" matches 3 different works');
    expect(err).toContain('  - One (Doe, J. et al., 2020, NeurIPS) — doi 10.1/a');
    expect(err).toContain('  - Two (Poe, E.) — arXiv:2001.00001');
    expect(err).toContain('  - Three (unknown author) — dblp, no DOI');
    expect(io.stdoutText()).toBe('');
  });

  it('says which index could not be reached, from the requests it saw', async () => {
    const io = memIo(tempCopy('project'));
    // The lookup tries CrossRef through the wrapped fetch (memIo has no network) and finds nothing.
    const offline: LookupFn = async (_q, opts) => {
      await opts.fetch?.('https://api.crossref.org/works?query=x').catch(() => undefined);
      return null;
    };
    expect(await citeCommand(['x', '--json'], io, offline)).toBe(1);
    const out = JSON.parse(io.stdoutText()) as {
      found: boolean;
      failures: unknown[];
      message: string;
    };
    expect(out.found).toBe(false);
    expect(out.failures).toEqual([{ source: 'CrossRef', reason: 'network disabled in tests' }]);
    expect(out.message).toMatch(/^Could not reach CrossRef: CrossRef: network disabled in tests\./);
  });

  it('reports a lookup that throws before any request as a lookup failure', async () => {
    const io = memIo(tempCopy('project'));
    const broken: LookupFn = async () => {
      throw new Error('boom');
    };
    expect(await citeCommand(['x'], io, broken)).toBe(1);
    expect(io.stderrText()).toContain('Could not reach lookup: lookup: boom.');
  });
});
