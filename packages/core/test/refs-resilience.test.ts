/**
 * One bad answer or one unexpected exception affects one entry, never the run: numeric
 * entities that are not code points, answers of another shape than an API documents,
 * a cache that throws, and a retraction check that fails half way.
 */
import { describe, expect, it } from 'vitest';
import { parseBib } from '../src/bib/index.js';
import {
  parseArxivFeed,
  type RefCache,
  refsCheck,
  refsRules,
  titleCacheKey,
  verifyEntries,
} from '../src/refs/index.js';
import { stripMarkup } from '../src/refs/normalize.js';
import { handlerFetch, json } from './fixtures/refs/fake-fetch.js';

const fast = { arxivIntervalMs: 0, crossrefIntervalMs: 0, retryDelayMs: 0 };
const emptyDblp = { result: { hits: { '@total': '0' } } };
const emptyAtom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const atom = (body: string) =>
  new Response(body, { headers: { 'content-type': 'application/atom+xml' } });

const PAPER = (key: string, title: string, extra = '') =>
  `@article{${key}, author = {Writer, Ann}, title = {${title}}, journal = {J}, year = {2020}${extra}}`;

const record = (title: string, doi?: string) => ({
  ...(doi ? { DOI: doi } : {}),
  type: 'journal-article',
  title: [title],
  author: [{ given: 'Ann', family: 'Writer' }],
  issued: { 'date-parts': [[2020]] },
});

describe('numeric entities that are not code points', () => {
  it('decode to U+FFFD instead of throwing', () => {
    expect(stripMarkup('A &#x110000; B &#99999999999; C &#xD800; &#65;')).toBe('A � B � C � A');
  });

  it('do not stop an arXiv feed from parsing', () => {
    const feed = `<feed><entry><id>http://arxiv.org/abs/2001.01234v1</id>
      <title>Bad &#x110000; entity &#38; more</title><published>2020-01-01</published>
      <author><name>Ann Writer</name></author></entry></feed>`;
    expect(parseArxivFeed(feed)[0]?.title).toBe('Bad � entity & more');
  });

  it('do not stop the run when CrossRef returns one', async () => {
    const title = 'Careful Measurement of Garden Growth Rates';
    const f = handlerFetch((u) => {
      if (u.host === 'api.crossref.org')
        return json({ message: { items: [record(`${title} &#x110000;`)] } });
      if (u.host === 'dblp.org') return json(emptyDblp);
      return atom(emptyAtom);
    });
    const [r] = await verifyEntries(parseBib(PAPER('k', title)), { fetch: f.fetch, ...fast });
    expect(r?.status).toBe('verified');
  });
});

describe('an unexpected exception in one entry', () => {
  it('becomes an error for that entry; the others are verified', async () => {
    const good = 'Careful Measurement of Garden Growth Rates';
    const bad = 'A Title Whose Cached Answer Is Corrupt';
    // Cache files are plain JSON on disk: a damaged one must not stop the run.
    const corrupt = { crossref: [{ source: 'crossref', title: bad, authors: 5, years: [] }] };
    const cache: RefCache = {
      get: (k) => (k === `${titleCacheKey(bad, 2020)}|author:writer` ? corrupt : undefined),
      set: () => {},
    };
    const f = handlerFetch((u) => {
      if (u.host === 'api.crossref.org') return json({ message: { items: [record(good)] } });
      if (u.host === 'dblp.org') return json(emptyDblp);
      return atom(emptyAtom);
    });
    const results = await verifyEntries(parseBib(`${PAPER('good', good)}\n${PAPER('bad', bad)}`), {
      fetch: f.fetch,
      cache,
      ...fast,
    });
    expect(results.map((r) => [r.key, r.status])).toEqual([
      ['good', 'verified'],
      ['bad', 'error'],
    ]);
    expect(results[1]?.reason).toMatch(/^lookup incomplete: unexpected error: TypeError/);
    expect(results[1]?.location?.line).toBe(2);
  });

  it('still rejects when the run is aborted', async () => {
    const controller = new AbortController();
    const f = handlerFetch(() => {
      controller.abort(new Error('stopped'));
      return json({});
    });
    await expect(
      verifyEntries(parseBib(PAPER('k', 'Anything At All Here')), {
        fetch: f.fetch,
        signal: controller.signal,
        ...fast,
      }),
    ).rejects.toThrow();
  });
});

describe('answers of another shape than the API documents', () => {
  const cases: [string, (u: URL) => Response | undefined][] = [
    [
      'items is not a list',
      (u) => (u.host === 'api.crossref.org' ? json({ message: { items: 'x' } }) : undefined),
    ],
    [
      'message is missing',
      (u) => (u.host === 'api.crossref.org' ? json({ status: 'ok' }) : undefined),
    ],
    [
      'a title is a number',
      (u) =>
        u.host === 'api.crossref.org' ? json({ message: { items: [{ title: 5 }] } }) : undefined,
    ],
    [
      'an item is null',
      (u) => (u.host === 'api.crossref.org' ? json({ message: { items: [null] } }) : undefined),
    ],
    ['the answer is a list', (u) => (u.host === 'api.crossref.org' ? json([]) : undefined)],
  ];
  for (const [what, crossref] of cases) {
    it(`CrossRef: ${what} is "unexpected data", not a TypeError`, async () => {
      const f = handlerFetch((u) => {
        const r = crossref(u);
        if (r) return r;
        if (u.host === 'dblp.org') return json(emptyDblp);
        if (u.host === 'export.arxiv.org') return atom(emptyAtom);
        return json({ results: [] });
      });
      const [r] = await verifyEntries(parseBib(PAPER('k', 'Careful Measurement of Things')), {
        fetch: f.fetch,
        ...fast,
      });
      expect(r?.status).toBe('error');
      const reasons = (r?.failures ?? []).map((x) => x.reason).join(' ');
      expect(reasons).toContain('api.crossref.org returned unexpected data');
      expect(JSON.stringify(r)).not.toMatch(/TypeError|is not a function/);
    });
  }

  it('dblp, OpenAlex, Semantic Scholar and Europe PMC answers are checked too', async () => {
    const f = handlerFetch((u) => {
      if (u.host === 'api.crossref.org') return json({ message: { items: [] } });
      if (u.host === 'dblp.org') return json({ result: { hits: { hit: 7 } } });
      if (u.host === 'export.arxiv.org') return atom(emptyAtom);
      if (u.host === 'api.openalex.org') return json({ results: { a: 1 } });
      if (u.host === 'api.semanticscholar.org') return json({ data: 'none' });
      return json({ resultList: { result: [{ title: ['x'] }] } });
    });
    const [r] = await verifyEntries(parseBib(PAPER('k', 'Careful Measurement of Things')), {
      fetch: f.fetch,
      ...fast,
    });
    const reasons = (r?.failures ?? []).map((x) => x.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        'dblp.org returned unexpected data',
        'api.openalex.org returned unexpected data',
      ]),
    );
    expect(JSON.stringify(r)).not.toMatch(/TypeError|is not a function/);
  });

  it('a doi.org answer that is not an object is "no metadata", not a crash', async () => {
    const f = handlerFetch((u) => {
      if (u.host === 'doi.org') return json('a string');
      if (u.host === 'api.crossref.org') return json({ message: { items: [] } });
      if (u.host === 'dblp.org') return json(emptyDblp);
      return atom(emptyAtom);
    });
    const [r] = await verifyEntries(
      parseBib(PAPER('k', 'Careful Measurement of Things', ', doi = {10.1234/x}')),
      { fetch: f.fetch, ...fast },
    );
    expect(r?.status).not.toBe('verified');
    expect(JSON.stringify(r)).not.toMatch(/TypeError/);
  });
});

describe('a retraction check that fails half way', () => {
  const entries = Array.from({ length: 45 }, (_, i) =>
    PAPER(`k${i}`, `Careful Measurement Number ${i} of Garden Growth`, `, doi = {10.1234/n${i}}`),
  ).join('\n');

  function fetchWith(updates: (dois: string[]) => Response) {
    return handlerFetch((u) => {
      if (u.searchParams.get('select') === 'DOI,updated-by') {
        const dois = (u.searchParams.get('filter') ?? '').split(',').map((d) => d.slice(4));
        return updates(dois);
      }
      const doi = decodeURIComponent(u.pathname.slice(1));
      const i = doi.split('/n')[1];
      return json({ ...record(`Careful Measurement Number ${i} of Garden Growth`), DOI: doi });
    });
  }

  it('keeps what the first request found and reports the rest as unchecked', async () => {
    const f = fetchWith((dois) =>
      dois.includes('10.1234/n0')
        ? json({
            message: {
              items: [
                {
                  DOI: '10.1234/n0',
                  'updated-by': [
                    { type: 'retraction', DOI: '10.1234/notice', source: 'publisher' },
                  ],
                },
              ],
            },
          })
        : new Response('busy', { status: 503 }),
    );
    const bib = parseBib(entries);
    const results = await verifyEntries(bib, { fetch: f.fetch, ...fast, checkRetractions: true });
    expect(results[0]?.retraction).toMatchObject({ kind: 'retraction', doi: '10.1234/n0' });
    // The second request (the last 5 DOIs) failed.
    const unchecked = results.filter((r) => r.retractionUnchecked).map((r) => r.key);
    expect(unchecked).toEqual(['k40', 'k41', 'k42', 'k43', 'k44']);
    const check = refsCheck(results, { entries: bib });
    const notes = check.problems.filter((p) => p.rule === 'reference-retraction-unchecked');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.severity).toBe('info');
    expect(notes[0]?.message).toMatch(
      /^retraction check incomplete: api\.crossref\.org answered HTTP 503/,
    );
    expect(notes[0]?.data?.keys).toEqual(unchecked);
    expect(check.problems.filter((p) => p.rule === 'reference-retracted')).toHaveLength(1);
  });

  it('reports an unreadable answer the same way', async () => {
    const f = fetchWith(() => json({ message: { items: [{ DOI: 5, 'updated-by': 'x' }] } }));
    const bib = parseBib(entries).slice(0, 2);
    const results = await verifyEntries(bib, { fetch: f.fetch, ...fast, checkRetractions: true });
    expect(results.every((r) => r.retractionUnchecked)).toBe(true);
    expect(results[0]?.retractionUnchecked).toBe('api.crossref.org returned unexpected data');
  });

  it('is a registered rule', () => {
    expect(refsRules.find((r) => r.id === 'reference-retraction-unchecked')).toMatchObject({
      severity: 'info',
      check: 'references',
    });
  });
});
