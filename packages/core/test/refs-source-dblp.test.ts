/** dblp: the search API, and the SPARQL fallback when the search API is walled. */
import { describe, expect, it } from 'vitest';
import { parseBib } from '../src/bib/index.js';
import { HttpClient, SourceUnavailableError } from '../src/refs/http.js';
import { verifyEntries } from '../src/refs/index.js';
import { dblpSearch, sparqlWords } from '../src/refs/sources/dblp.js';
import { handlerFetch, json, readFixture, recordedFetch } from './fixtures/refs/fake-fetch.js';
import { fast } from './helpers.js';

const WALL = () =>
  new Response("<!doctype html><title>Making sure you're not a bot!</title>", {
    status: 202,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

const sparqlJson = (bindings: Record<string, string>[]) =>
  new Response(
    JSON.stringify({
      head: { vars: [] },
      results: {
        bindings: bindings.map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([k, v]) => [
              k,
              { type: v.startsWith('http') ? 'uri' : 'literal', value: v },
            ]),
          ),
        ),
      },
    }),
    { headers: { 'content-type': 'application/sparql-results+json' } },
  );

const REC = 'https://dblp.org/rec/';
const SCHEMA = 'https://dblp.org/rdf/schema#';
const CVPR = `${REC}conf/cvpr/HeZRS16`;
const CORR = `${REC}journals/corr/HeZRS15`;
const OTHER = `${REC}conf/x/Other20`;

/** Word-search candidates in the server's arbitrary order, then the details of those asked. */
const candidates = [
  { p: OTHER, t: 'Deep Residual Learning Based Image Recognition for Plants.' },
  { p: CORR, t: 'Deep Residual Learning for Image Recognition.' },
  { p: CVPR, t: 'Deep Residual Learning for Image Recognition.' },
];

function detailRows(iri: string): Record<string, string>[] {
  if (iri === CVPR) {
    // One row per author, and per extra value of a multi-valued field; out of order.
    const base = {
      p: CVPR,
      title: 'Deep Residual Learning for Image Recognition.',
      year: '2016',
      venue: 'CVPR',
      doi: 'https://doi.org/10.1109/CVPR.2016.90',
      class: `${SCHEMA}Inproceedings`,
    };
    return [
      { ...base, ee: 'https://doi.org/10.1109/CVPR.2016.90', o: '3', n: 'Shaoqing Ren 0001' },
      { ...base, ee: 'https://doi.org/10.1109/CVPR.2016.90', o: '1', n: 'Kaiming He' },
      { ...base, ee: 'https://ieeexplore.example/7780459', o: '1', n: 'Kaiming He' },
      { ...base, class: `${SCHEMA}Publication`, o: '2', n: 'Xiangyu Zhang' },
      { ...base, ee: 'https://doi.org/10.1109/CVPR.2016.90', o: '4', n: 'Jian Sun 0001' },
    ];
  }
  if (iri === CORR) {
    return [
      {
        p: CORR,
        title: 'Deep Residual Learning for Image Recognition.',
        year: '2015',
        venue: 'CoRR',
        class: `${SCHEMA}Informal`,
        o: '1',
        n: 'Kaiming He',
      },
    ];
  }
  if (iri === OTHER) {
    return [{ p: OTHER, title: candidates[0]?.t ?? '', class: `${SCHEMA}Article` }];
  }
  return [];
}

interface Sparql {
  queries: string[];
  searchCalls: number;
}

/** A dblp whose search API is walled and whose SPARQL service answers from the rows above. */
function walledDblp(opts: { sparqlDown?: boolean; words?: (q: string) => boolean } = {}) {
  const seen: Sparql = { queries: [], searchCalls: 0 };
  const f = handlerFetch((u) => {
    if (u.host === 'dblp.org') {
      seen.searchCalls++;
      return WALL();
    }
    if (u.host !== 'sparql.dblp.org') throw new TypeError(`unexpected host ${u.host}`);
    if (opts.sparqlDown) return new Response('', { status: 503 });
    const q = u.searchParams.get('query') ?? '';
    seen.queries.push(q);
    if (q.includes('ql:contains-word')) {
      if (opts.words && !opts.words(q)) return sparqlJson([]);
      return sparqlJson(candidates);
    }
    const asked = [...q.matchAll(/<(https:\/\/dblp\.org\/rec\/[^>]+)>/g)].map((m) => m[1] ?? '');
    return sparqlJson(asked.flatMap(detailRows));
  });
  return { f, seen, client: new HttpClient({ fetch: f.fetch, ...fast }) };
}

describe('dblp SPARQL fallback', () => {
  it('asks SPARQL when the search API answers with a bot wall, and maps the records', async () => {
    const { client, seen } = walledDblp();
    const records = await dblpSearch(client, 'Deep Residual Learning for Image Recognition');
    expect(seen.searchCalls).toBe(1);
    expect(seen.queries).toHaveLength(2);
    // Ranked by title similarity here (the server's order is arbitrary); ties by record IRI.
    expect(records.map((r) => r.url)).toEqual([
      'https://doi.org/10.1109/CVPR.2016.90',
      CORR,
      OTHER,
    ]);
    expect(records[0]).toEqual({
      source: 'dblp',
      title: 'Deep Residual Learning for Image Recognition',
      authors: [
        { given: 'Kaiming', family: 'He' },
        { given: 'Xiangyu', family: 'Zhang' },
        { given: 'Shaoqing', family: 'Ren' },
        { given: 'Jian', family: 'Sun' },
      ],
      years: [2016],
      venue: 'CVPR',
      doi: '10.1109/cvpr.2016.90',
      url: 'https://doi.org/10.1109/CVPR.2016.90',
      type: 'Conference and Workshop Papers',
    });
    expect(records[1]).toMatchObject({
      type: 'Informal and Other Publications',
      years: [2015],
      venue: 'CoRR',
    });
    expect(records[1]?.doi).toBeUndefined();
    expect(records[2]?.type).toBe('Journal Articles');
  });

  it('remembers the wall for the run: later titles go straight to SPARQL', async () => {
    const { client, seen } = walledDblp();
    await dblpSearch(client, 'Deep Residual Learning for Image Recognition');
    await dblpSearch(client, 'Deep Residual Learning for Image Recognition Again');
    expect(seen.searchCalls).toBe(1);
    expect(seen.queries).toHaveLength(4);
    // A new client (a new run) tries the search API again.
    const second = walledDblp();
    await dblpSearch(second.client, 'Deep Residual Learning for Image Recognition');
    expect(second.seen.searchCalls).toBe(1);
  });

  it('asks for details of the best five candidates only, sorted by title length', async () => {
    const { client, seen } = walledDblp();
    await dblpSearch(client, 'Deep Residual Learning for Image Recognition');
    const [search, details] = seen.queries;
    expect(search).toContain('ql:contains-word "recognition residual learning image deep"');
    // The title's length plus dblp's closing full stop.
    expect(search).toContain('ORDER BY ASC(ABS(STRLEN(?t) - 45)) LIMIT 100');
    expect(details).toContain(`VALUES ?p { <${CVPR}> <${CORR}> <${OTHER}> }`);
  });

  it('retries with fewer words when the first word search finds nothing', async () => {
    const { client, seen } = walledDblp({
      words: (q) => !q.includes('modelling'),
    });
    const records = await dblpSearch(
      client,
      'Modelling Deep Residual Learning for Image Recognition',
    );
    expect(seen.queries[0]).toContain('"recognition modelling residual learning image deep"');
    expect(seen.queries[1]).toContain('"recognition modelling residual"');
    expect(seen.queries).toHaveLength(2);
    // The retry asked with "modelling" too, which this fake never matches.
    expect(records).toEqual([]);
  });

  it('answers no candidates when nothing similar is found, without a details query', async () => {
    const { client, seen } = walledDblp({ words: () => false });
    expect(await dblpSearch(client, 'Quantum Lensing of Medieval Tax Records')).toEqual([]);
    expect(seen.queries).toHaveLength(2);
    const unlike = walledDblp();
    // Candidates come back, but none is close enough to be worth their details.
    expect(await dblpSearch(unlike.client, 'Image Plants Deep Survey of Everything')).toEqual([]);
    expect(unlike.seen.queries).toHaveLength(1);
  });

  it('a title with no searchable word asks nothing', async () => {
    const { client, seen } = walledDblp();
    expect(await dblpSearch(client, 'Ö: a, b')).toEqual([]);
    expect(seen.queries).toHaveLength(0);
  });

  it('throws SourceUnavailableError naming both when SPARQL fails too', async () => {
    const { client } = walledDblp({ sparqlDown: true });
    const err = await dblpSearch(client, 'Deep Residual Learning for Image Recognition').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect((err as Error).message).toMatch(
      /^dblp\.org returned a non-JSON page \(HTTP 202\).*; sparql\.dblp\.org answered HTTP 503/,
    );
  });

  it('sends one SPARQL query at a time, with a User-Agent', async () => {
    const agents: (string | null)[] = [];
    let inFlight = 0;
    let most = 0;
    const inner = walledDblp();
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).includes('sparql.dblp.org')) return inner.f.fetch(input, init);
      agents.push(new Headers(init?.headers).get('user-agent'));
      most = Math.max(most, ++inFlight);
      try {
        return await inner.f.fetch(input, init);
      } finally {
        inFlight--;
      }
    }) as typeof globalThis.fetch;
    const client = new HttpClient({ fetch, ...fast });
    await Promise.all(
      ['A', 'B', 'C'].map((s) => dblpSearch(client, `Deep Residual Learning ${s}`)),
    );
    expect(most).toBe(1);
    expect(agents.length).toBe(6);
    expect(agents.every((a) => a?.startsWith('overfull'))).toBe(true);
  });

  it('keeps the search API when it answers', async () => {
    const f = handlerFetch(() =>
      json({ result: { hits: { hit: [{ info: { title: 'A Paper.', year: '2020' } }] } } }),
    );
    const records = await dblpSearch(new HttpClient({ fetch: f.fetch, ...fast }), 'A Paper');
    expect(records).toMatchObject([{ source: 'dblp', title: 'A Paper', years: [2020] }]);
    expect(f.calls.every((c) => c.startsWith('https://dblp.org/'))).toBe(true);
  });
});

describe('sparqlWords', () => {
  it('splits like QLever, keeps ASCII words of 3 letters or more, longest first', () => {
    expect(sparqlWords("Dynamo: Amazon's Highly Available Key-value Store")).toEqual([
      'available',
      'dynamo',
      'amazon',
      'highly',
      'value',
      'store',
      'key',
    ]);
  });

  it('leaves out stop words, repeats and words with accents (QLever does not fold them)', () => {
    expect(sparqlWords('The Proof of the Proof: Gödel and Naïve Sets for Résumés')).toEqual([
      'proof',
      'sets',
    ]);
  });
});

describe('dblp SPARQL: real answers from recordings', () => {
  it('verifies real papers through SPARQL and finds nothing for an invented one', async () => {
    const f = recordedFetch();
    const entries = parseBib(readFixture('sources-dblp.bib'));
    const results = await verifyEntries(entries, { fetch: f.fetch, ...fast, sources: ['dblp'] });
    expect(f.misses).toEqual([]);
    const by = Object.fromEntries(results.map((r) => [r.key, r]));
    for (const k of [
      'decandia2007dynamo',
      'hochreiter1997long',
      'corbett2012spanner',
      'he2016deep',
    ]) {
      expect(by[k], k).toMatchObject({ status: 'verified', source: 'dblp' });
    }
    expect(by.zhang2023certificates?.status).not.toBe('verified');
    expect(f.calls.some((c) => c.startsWith('https://sparql.dblp.org/'))).toBe(true);
  });
});
