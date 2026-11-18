/**
 * Titles in other scripts than Latin (Cyrillic, CJK, Arabic) are compared, searched and
 * cached by their own letters. Until this was fixed, only ASCII letters and digits were kept:
 * such a title normalized to nothing, so the exact record from CrossRef scored 0 and the
 * entry was reported as `not-found`.
 */
import { describe, expect, it } from 'vitest';
import { parseBib } from '../src/bib/index.js';
import {
  hasValidProvenance,
  markCited,
  normalizeTitle,
  provenanceHash,
  provenanceOf,
  titleCacheKey,
  titleSimilarity,
  verifyEntries,
} from '../src/refs/index.js';
import { asciiNormalizeTitle, foldName } from '../src/refs/normalize.js';
import { handlerFetch, json } from './fixtures/refs/fake-fetch.js';
import { fast } from './helpers.js';

const emptyDblp = { result: { hits: { '@total': '0' } } };
const emptyAtom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';

interface Work {
  title: string;
  family: string;
  given: string;
  year: number;
}

const CYRILLIC: Work = {
  title: 'Об одном методе решения нелинейных уравнений',
  family: 'Иванов',
  given: 'Иван',
  year: 2019,
};
const CJK: Work = {
  title: '深度学习在图像识别中的应用研究',
  family: '王',
  given: '伟',
  year: 2020,
};
const ARABIC: Work = {
  title: 'دراسة تحليلية لبنية الجملة في اللغة العربية الحديثة',
  family: 'أحمد',
  given: 'محمد',
  year: 2018,
};

const bibOf = (key: string, w: Work, title = w.title) =>
  `@article{${key}, author = {${w.family}, ${w.given}}, title = {${title}}, journal = {J}, year = {${w.year}}}`;

const csl = (w: Work, doi: string) => ({
  DOI: doi,
  type: 'journal-article',
  title: [w.title],
  author: [{ family: w.family, given: w.given }],
  issued: { 'date-parts': [[w.year]] },
});

/** CrossRef answers with `items`; dblp and arXiv find nothing. Records every URL asked. */
function sources(items: unknown[]) {
  return handlerFetch((u) => {
    if (u.host === 'api.crossref.org') return json({ message: { items } });
    if (u.host === 'dblp.org') return json(emptyDblp);
    if (u.host === 'export.arxiv.org')
      return new Response(emptyAtom, { headers: { 'content-type': 'application/atom+xml' } });
    throw new TypeError(`fetch failed: ${u.host}`);
  });
}

describe('normalizing titles in any script', () => {
  it('keeps Cyrillic, CJK and Arabic letters', () => {
    // Diacritics go in every script, as in Latin ones: й is compared as и.
    expect(normalizeTitle(CYRILLIC.title)).toBe('об одном методе решения нелинеиных уравнении');
    // No spaces between words in Chinese and Japanese: each character is a word.
    expect(normalizeTitle('深度学习')).toBe('深 度 学 习');
    expect(normalizeTitle('ニューラル翻訳')).toBe('ニ ュ ー ラ ル 翻 訳');
    expect(normalizeTitle(ARABIC.title)).toBe(ARABIC.title);
  });

  it('still folds Latin diacritics, Greek and TeX the same way', () => {
    expect(normalizeTitle('Über die {G}r\\"o\\ss{}e von $\\alpha$-Strahlen')).toBe(
      'uber die grosse von alpha strahlen',
    );
    expect(normalizeTitle('Ελληνικά')).toBe('epsilon lambda lambda eta nu iota kappa alpha');
    expect(asciiNormalizeTitle('Über die Größe: Teil 2')).toBe(
      normalizeTitle('Über die Größe: Teil 2'),
    );
  });

  it('keeps names in any script', () => {
    expect(foldName('Иванов')).toBe('иванов');
    expect(foldName('王')).toBe('王');
    expect(foldName('Erdős')).toBe('erdos');
  });

  it('scores the same title 1 and another title in the same script low', () => {
    expect(titleSimilarity(CYRILLIC.title, CYRILLIC.title)).toBe(1);
    expect(titleSimilarity(CJK.title, `${CJK.title}。`)).toBe(1);
    expect(titleSimilarity(CYRILLIC.title, 'Теория вероятностей и математическая статистика')).toBe(
      0,
    );
    // One character differs in a 15-character Chinese title: still the same work.
    expect(titleSimilarity(CJK.title, '深度学习在图像识别中的应用研讨')).toBeGreaterThanOrEqual(
      0.9,
    );
  });

  it('gives different titles different cache keys', () => {
    const keys = [CYRILLIC, CJK, ARABIC].map((w) => titleCacheKey(w.title, w.year));
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).not.toMatch(/^title:\|/);
  });
});

describe('verifying entries with non-Latin titles', () => {
  it('verifies Cyrillic, CJK and Arabic entries that CrossRef has', async () => {
    for (const [i, w] of [CYRILLIC, CJK, ARABIC].entries()) {
      const f = sources([csl(w, `10.1234/u${i}`)]);
      const [r] = await verifyEntries(parseBib(bibOf(`k${i}`, w)), { fetch: f.fetch, ...fast });
      expect(r, w.title).toMatchObject({ status: 'verified', source: 'crossref' });
      expect(r?.query).toBe(`title:${normalizeTitle(w.title)}|${w.year}`);
    }
  });

  it('still reports a title that no index has as not-found', async () => {
    const f = sources([csl({ ...CYRILLIC, title: 'Теория вероятностей и статистика' }, '10.1/x')]);
    const [r] = await verifyEntries(parseBib(bibOf('k', CYRILLIC)), { fetch: f.fetch, ...fast });
    expect(r?.status).toBe('not-found');
  });

  it('asks arXiv for the title itself, never for an empty phrase', async () => {
    const f = sources([]);
    await verifyEntries(parseBib(bibOf('k', CYRILLIC)), { fetch: f.fetch, ...fast });
    const arxiv = f.calls.find((c) => new URL(c).hostname === 'export.arxiv.org');
    expect(new URL(arxiv as string).searchParams.get('search_query')).toBe(
      `ti:"${normalizeTitle(CYRILLIC.title)}"`,
    );
  });

  it('never reports a title without letters or digits as not-found', async () => {
    const f = sources([]);
    const results = await verifyEntries(
      parseBib(`@article{q, author = {Doe, Jane}, title = {???}, journal = {J}, year = {2020}}
@article{d, author = {Doe, Jane}, title = {--- !}, journal = {J}, year = {2020}}`),
      { fetch: f.fetch, ...fast },
    );
    for (const r of results) {
      expect(r.status).toBe('unverifiable');
      expect(r.reason).toMatch(/no letters or digits/);
    }
    expect(f.calls).toEqual([]);
  });

  it('judges an entry with an empty-looking title by its DOI alone', async () => {
    const f = handlerFetch((u) =>
      u.host === 'doi.org'
        ? json(csl({ ...CYRILLIC, title: CYRILLIC.title }, '10.1234/u'))
        : json({ message: { items: [] } }),
    );
    const [r] = await verifyEntries(
      parseBib(
        `@article{k, author = {Иванов, Иван}, title = {???}, journal = {J}, year = {2019}, doi = {10.1234/u}}`,
      ),
      { fetch: f.fetch, ...fast },
    );
    // Not "the DOI points to another work": there is no title to compare.
    expect(r).toMatchObject({ status: 'verified', source: 'doi.org' });
    expect(r?.wrongWork).toBeUndefined();
  });
});

describe('provenance of non-Latin titles', () => {
  const [entry] = parseBib(
    `@article{ivanov2019, author = {Иванов, Иван}, title = {${CYRILLIC.title}}, journal = {J}, year = {2019}, doi = {10.1234/u}}`,
  );
  const e = entry as NonNullable<typeof entry>;

  it('covers the title: editing it breaks the hash', () => {
    const marked = markCited(e, 'doi.org', '2026-11-17');
    expect(provenanceOf(marked)).toBeDefined();
    const edited = { ...marked, fields: { ...marked.fields, title: 'Совсем другая статья' } };
    expect(provenanceOf(edited)).toBeUndefined();
    expect(hasValidProvenance(edited)).toBe(false);
  });

  it('still accepts a marker written when the hash covered ASCII letters only', () => {
    // Back then a Cyrillic title normalized to an empty string.
    const legacy = provenanceHash({ ...e, fields: { ...e.fields, title: '' } });
    const old = {
      ...e,
      fields: { ...e.fields, 'x-overfull': `cite doi.org 2026-11-01 ${legacy}` },
    };
    expect(provenanceOf(old)).toBeUndefined();
    expect(hasValidProvenance(old)).toBe(true);
    const tampered = { ...old, fields: { ...old.fields, year: '2020' } };
    expect(hasValidProvenance(tampered)).toBe(false);
  });
});
