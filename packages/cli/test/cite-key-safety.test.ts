/** Cite keys are BibTeX-safe. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { citeCommand, sanitizeKey } from '../src/commands/cite.js';
import { memIo, tempDir } from './helpers.js';

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

// --- R9: citation keys --------------------------------------------------------

describe('R9: cite keys are BibTeX-safe', () => {
  const lookup = (key: string) => async () => ({
    entry: { key, type: 'misc', line: 0, raw: '', fields: { title: 'T', doi: '10.1/x' } },
    source: 'doi.org',
    confidence: 1,
  });

  it('rejects an unsafe --key and writes nothing', async () => {
    const dir = tempDir();
    for (const key of ['a,b', 'x}, title={evil', 'a b', 'k"q', '\\input']) {
      const io = memIo(dir);
      await expect(citeCommand(['10.1/x', '--key', key], io, lookup('k'))).rejects.toThrow(
        /Invalid --key/,
      );
    }
    expect(existsSync(join(dir, 'references.bib'))).toBe(false);
    const ok = memIo(dir);
    expect(await citeCommand(['10.1/x', '--key', 'Knuth:1984/lp.v2+x'], ok, lookup('k'))).toBe(0);
  });

  it('sanitizes keys generated from index metadata', async () => {
    expect(sanitizeKey('evil},\n@misc{x')).toBe('evilmiscx');
    expect(sanitizeKey('{}')).toBe('anon');
    const dir = tempDir();
    const io = memIo(dir);
    await citeCommand(['10.1/x'], io, lookup('evil}, note={x'));
    const text = readFileSync(join(dir, 'references.bib'), 'utf8');
    expect(text).toMatch(/^@misc\{evilnotex,/);
  });
});
