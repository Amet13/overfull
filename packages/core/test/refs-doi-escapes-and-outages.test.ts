/**
 * DOIs written with TeX escapes (`\_`), and what an entry's DOI is worth when doi.org
 * cannot answer: OpenAlex is asked for the DOI's record, and a work found by title only
 * is `verified` when that record carries the same DOI.
 */
import { describe, expect, it } from 'vitest';
import { parseBib } from '../src/bib/index.js';
import { identifiersOf, unescapeTexId, verifyEntries } from '../src/refs/index.js';
import { handlerFetch, json } from './fixtures/refs/fake-fetch.js';
import { atom, fast } from './helpers.js';

const emptyDblp = { result: { hits: { '@total': '0' } } };
const emptyAtom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';

const TITLE = 'Learning to Segment Moving Objects in Crowded Street Scenes';
const DOI = '10.1007/978-3-030-58452-8_13';

const csl = (doi: string, title = TITLE) => ({
  DOI: doi,
  type: 'book-chapter',
  title: [title],
  author: [{ given: 'Ada', family: 'Lovelace' }],
  issued: { 'date-parts': [[2020]] },
});

const entry = (doi: string, extra = '') =>
  parseBib(
    `@inproceedings{k, author = {Lovelace, Ada}, title = {${TITLE}}, booktitle = {ECCV}, year = {2020}, doi = {${doi}}${extra}}`,
  );

describe('TeX escapes in identifier fields', () => {
  it('unescapes \\_ \\% \\# \\& and drops braces', () => {
    expect(unescapeTexId('10.1007/978-3-030-58452-8\\_13')).toBe(DOI);
    expect(unescapeTexId('{10.1000/A\\%B\\#C\\&D}')).toBe('10.1000/A%B#C&D');
  });

  it('reads the DOI, eprint and doi.org links without the escapes', () => {
    const [a, b, c] = parseBib(`
@inproceedings{a, title = {T}, doi = {10.1007/978-3-030-58452-8\\_13}}
@misc{b, title = {T}, eprint = {{2401.12345}}, archiveprefix = {arXiv}}
@misc{c, title = {T}, url = {https://doi.org/10.1007/978-3-030-58452-8\\_13}}`);
    expect(identifiersOf(a as NonNullable<typeof a>).doi).toBe(DOI);
    expect(identifiersOf(b as NonNullable<typeof b>).arxivId).toBe('2401.12345');
    expect(identifiersOf(c as NonNullable<typeof c>).doi).toBe(DOI);
  });

  it('resolves a TeX-escaped DOI as the DOI itself', async () => {
    const f = handlerFetch((u) => {
      if (u.host === 'doi.org') {
        return u.pathname === `/${DOI}` ? json(csl(DOI)) : new Response('', { status: 404 });
      }
      throw new TypeError(`fetch failed: ${u.host}`);
    });
    const [r] = await verifyEntries(entry('10.1007/978-3-030-58452-8\\_13'), {
      fetch: f.fetch,
      ...fast,
    });
    expect(r).toMatchObject({ status: 'verified', source: 'doi.org' });
    expect(f.calls.join(' ')).not.toContain('%5C');
  });
});

/** doi.org times out; CrossRef finds `found` by title; OpenAlex answers `openalex`. */
function doiOrgDown(found: unknown[], openalex: (u: URL) => Response) {
  return handlerFetch((u) => {
    if (u.host === 'doi.org') throw new TypeError('fetch failed: doi.org');
    if (u.host === 'api.crossref.org') return json({ message: { items: found } });
    if (u.host === 'dblp.org') return json(emptyDblp);
    if (u.host === 'export.arxiv.org') return atom(emptyAtom);
    if (u.host === 'api.openalex.org') return openalex(u);
    throw new TypeError(`fetch failed: ${u.host}`);
  });
}

const openalexWork = (doi: string, title = TITLE) => ({
  display_name: title,
  publication_year: 2020,
  doi: `https://doi.org/${doi}`,
  type: 'book-chapter',
  authorships: [{ author: { display_name: 'Ada Lovelace' } }],
  primary_location: { source: { display_name: 'ECCV 2020' } },
});

const notFound = () => json({ error: 'not found' }, 404);

describe('when doi.org cannot answer', () => {
  it('asks OpenAlex for the record of that DOI (one work, no search)', async () => {
    const f = doiOrgDown([], (u) =>
      u.pathname === `/works/doi:${DOI}` ? json(openalexWork(DOI)) : notFound(),
    );
    const [r] = await verifyEntries(entry(DOI), { fetch: f.fetch, ...fast });
    expect(r).toMatchObject({ status: 'verified', source: 'openalex' });
    const asked = f.calls.find((c) => new URL(c).hostname === 'api.openalex.org') as string;
    expect(new URL(asked).pathname).toBe(`/works/doi:${DOI}`);
    // The title search was not needed.
    expect(f.calls.some((c) => new URL(c).hostname === 'api.crossref.org')).toBe(false);
  });

  it('reports a DOI whose OpenAlex record is another work', async () => {
    const f = doiOrgDown([], () => json(openalexWork(DOI, 'A Survey of Garden Irrigation')));
    const [r] = await verifyEntries(entry(DOI), { fetch: f.fetch, ...fast });
    expect(r?.status).toBe('mismatch');
    expect(r?.differences?.[0]).toMatchObject({ field: 'doi', bib: DOI });
  });

  it('verifies by title when the record found carries the same DOI', async () => {
    const f = doiOrgDown([csl(DOI)], notFound);
    const [r] = await verifyEntries(entry(DOI), { fetch: f.fetch, ...fast });
    expect(r).toMatchObject({ status: 'verified', source: 'crossref' });
  });

  it('never verifies a made-up DOI on a real title: another DOI is a mismatch', async () => {
    const f = doiOrgDown([csl(DOI)], notFound);
    const [r] = await verifyEntries(entry('10.1007/978-3-030-99999-9_99'), {
      fetch: f.fetch,
      ...fast,
    });
    expect(r?.status).toBe('mismatch');
    expect(r?.differences?.[0]).toEqual({
      field: 'doi',
      bib: '10.1007/978-3-030-99999-9_99',
      record: DOI,
    });
    expect(r?.reason).toMatch(/doi\.org could not be reached/);
  });

  it('leaves the DOI unchecked (error, not verified) when the record found has no DOI', async () => {
    const noDoi = { ...csl(DOI) } as Record<string, unknown>;
    delete noDoi.DOI;
    const f = doiOrgDown([noDoi], (u) =>
      u.pathname.startsWith('/works/doi:') ? notFound() : json({ results: [] }),
    );
    const [r] = await verifyEntries(entry('10.1007/978-3-030-99999-9_99'), {
      fetch: f.fetch,
      ...fast,
    });
    expect(r?.status).toBe('error');
    expect(r?.reason).toMatch(/the DOI 10\.1007\/978-3-030-99999-9_99 could not be checked/);
    expect(r?.failed).toContain('doi.org');
    expect(r?.matched?.title).toBe(TITLE);
  });

  it('prefers the record with the entry DOI among several title matches', async () => {
    const other = { ...csl('10.5555/preprint'), type: 'posted-content' };
    const f = doiOrgDown([other, csl(DOI)], notFound);
    const [r] = await verifyEntries(entry(DOI), { fetch: f.fetch, ...fast });
    expect(r).toMatchObject({ status: 'verified' });
    expect(r?.matched?.doi).toBe(DOI);
  });
});

describe('arXiv ids through OpenAlex', () => {
  const arxivEntry = parseBib(
    `@misc{a, author = {Lovelace, Ada}, title = {${TITLE}}, year = {2020}, eprint = {2001.01234}, archiveprefix = {arXiv}}`,
  );
  const arxivDoi = '10.48550/arxiv.2001.01234';

  it('asks OpenAlex for the arXiv DOI when arXiv may not be asked', async () => {
    const f = doiOrgDown([], (u) =>
      u.pathname === `/works/doi:${arxivDoi}` ? json(openalexWork(arxivDoi)) : notFound(),
    );
    const [r] = await verifyEntries(arxivEntry, {
      fetch: f.fetch,
      ...fast,
      sources: ['crossref', 'doi.org', 'openalex'],
    });
    expect(r).toMatchObject({ status: 'verified', source: 'openalex' });
    expect(f.calls.some((c) => new URL(c).hostname === 'export.arxiv.org')).toBe(false);
  });

  it('resolves the arXiv DOI through doi.org (DataCite) when arXiv may not be asked', async () => {
    const f = handlerFetch((u) => {
      if (u.host === 'doi.org' && u.pathname.toLowerCase() === `/${arxivDoi}`)
        return json({ ...csl('10.48550/arXiv.2001.01234'), type: 'article' });
      throw new TypeError(`fetch failed: ${u.host}`);
    });
    const [r] = await verifyEntries(arxivEntry, {
      fetch: f.fetch,
      ...fast,
      sources: ['crossref', 'doi.org', 'openalex'],
    });
    expect(r).toMatchObject({ status: 'verified', source: 'doi.org' });
    expect(f.calls.map((c) => new URL(c).hostname)).toEqual(['doi.org']);
  });

  it('asks OpenAlex when doi.org does not know the arXiv DOI', async () => {
    const f = handlerFetch((u) => {
      if (u.host === 'doi.org') return notFound();
      if (u.host === 'api.openalex.org') return json(openalexWork(arxivDoi));
      throw new TypeError(`fetch failed: ${u.host}`);
    });
    const [r] = await verifyEntries(arxivEntry, {
      fetch: f.fetch,
      ...fast,
      sources: ['crossref', 'doi.org', 'openalex'],
    });
    expect(r).toMatchObject({ status: 'verified', source: 'openalex' });
  });

  it('asks OpenAlex when arXiv is down', async () => {
    const f = handlerFetch((u) => {
      if (u.host === 'export.arxiv.org') return new Response('busy', { status: 503 });
      if (u.host === 'api.openalex.org') return json(openalexWork(arxivDoi));
      throw new TypeError(`fetch failed: ${u.host}`);
    });
    const [r] = await verifyEntries(arxivEntry, { fetch: f.fetch, ...fast });
    expect(r).toMatchObject({ status: 'verified', source: 'openalex' });
  });
});
