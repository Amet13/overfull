/** scripts/sources-health.mjs: probe outcomes and the issue body, without the network. */
import { describe, expect, it } from 'vitest';
import { HttpClient } from '../../packages/core/src/refs/http.js';
import { titleSimilarity } from '../../packages/core/src/refs/normalize.js';
import { dblpSearch } from '../../packages/core/src/refs/sources/dblp.js';
// @ts-expect-error: a plain .mjs script without type declarations
import { PROBES, probe, probeAll, report } from '../sources-health.mjs';

type Result = { source: string; status: string; detail: string };
const exact = (a: string, b: string) => (a.toLowerCase() === b.toLowerCase() ? 1 : 0);

/** Fake source modules: every function answers with the probe's own known title. */
function healthySources(): Record<string, (...a: unknown[]) => Promise<unknown>> {
  const byTitle = Object.fromEntries(
    (PROBES as { source: string; title: string }[]).map((p) => [p.source, p.title]),
  );
  const rec = (s: string) => ({ title: byTitle[s] });
  return {
    resolveDoi: async () => ({ kind: 'found', record: rec('doi.org') }),
    crossrefSearch: async (_c, q) =>
      (q as { title: string }).title.startsWith('Quantum') ? [] : [rec('crossref')],
    dblpSearch: async (_c, t) => (String(t).startsWith('Quantum') ? [] : [rec('dblp')]),
    arxivById: async () => rec('arxiv'),
    arxivSearch: async () => [],
    openalexSearch: async (_c, t) => (String(t).startsWith('Quantum') ? [] : [rec('openalex')]),
    semanticScholarSearch: async (_c, t) =>
      String(t).startsWith('Quantum') ? [] : [rec('semanticscholar')],
    aclById: async () => rec('acl'),
    europepmcByPmid: async () => rec('europepmc'),
    europepmcSearch: async () => [],
  };
}

const deps = (sources: ReturnType<typeof healthySources>, opts = {}) => ({
  sources,
  client: {},
  opts,
  similarity: exact,
});

describe('sources-health', () => {
  it('reports nothing when every source answers as expected', async () => {
    const results = (await probeAll(deps(healthySources()), 0)) as Result[];
    expect(results.map((r) => r.status)).toEqual(PROBES.map(() => 'ok'));
    expect(report(results)).toBe('');
  });

  it('a bot wall with no fallback left is broken; the report names the source and says why', async () => {
    const s = healthySources();
    s.dblpSearch = async () => {
      throw new Error('dblp.org returned a non-JSON page (HTTP 202)');
    };
    const results = (await probeAll(deps(s), 0)) as Result[];
    expect(results.find((r) => r.source === 'dblp')).toMatchObject({ status: 'broken' });
    expect(report(results)).toContain('| dblp | dblp.org returned a non-JSON page (HTTP 202) |');
  });

  it('dblp behind a bot wall is healthy while its SPARQL service answers', async () => {
    const raft = 'https://dblp.org/rec/conf/usenix/OngaroO14';
    const sparql = (bindings: unknown[]) =>
      new Response(JSON.stringify({ head: {}, results: { bindings } }), {
        headers: { 'content-type': 'application/sparql-results+json' },
      });
    const lit = (value: string) => ({ type: 'literal', value });
    const fetch = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.host === 'dblp.org')
        return new Response('<title>Making sure you&#39;re not a bot!</title>', { status: 202 });
      const q = u.searchParams.get('query') ?? '';
      // The invented control: no title has all its words.
      if (q.includes('hypergraph')) return sparql([]);
      const title = lit('In Search of an Understandable Consensus Algorithm.');
      if (q.includes('contains-word'))
        return sparql([{ p: { type: 'uri', value: raft }, t: title }]);
      return sparql([
        { p: { type: 'uri', value: raft }, title, o: lit('1'), n: lit('Diego Ongaro') },
      ]);
    }) as typeof globalThis.fetch;
    const p = PROBES.find((x: { source: string }) => x.source === 'dblp');
    const r = (await probe(p, {
      sources: { dblpSearch },
      client: new HttpClient({ fetch, retryDelayMs: 0, dblpSparqlIntervalMs: 0 }),
      opts: {},
      similarity: titleSimilarity,
    })) as Result;
    expect(r).toEqual({ source: 'dblp', status: 'ok', detail: '' });
  });

  it('a 429 without a key is a note, with a key it is broken', async () => {
    const s = healthySources();
    s.semanticScholarSearch = async () => {
      throw new Error('api.semanticscholar.org answered HTTP 429');
    };
    const p = PROBES.find((x: { source: string }) => x.source === 'semanticscholar');
    expect(((await probe(p, deps(s))) as Result).status).toBe('limited');
    expect(((await probe(p, deps(s, { semanticScholarKey: 'k' }))) as Result).status).toBe(
      'broken',
    );
    expect(report([{ source: 'semanticscholar', status: 'limited', detail: '' }])).toBe('');
  });

  it('a 429 without a key on the second query (the invented title) is a note too', async () => {
    // The known work answers, then the keyless budget runs out: issue 114 listed this
    // as broken.
    const s = healthySources();
    const known = s.semanticScholarSearch;
    s.semanticScholarSearch = async (c, t, k) => {
      if (String(t).startsWith('Deep Residual')) return known(c, t, k);
      throw new Error('api.semanticscholar.org answered HTTP 429');
    };
    const p = PROBES.find((x: { source: string }) => x.source === 'semanticscholar');
    expect(((await probe(p, deps(s))) as Result).status).toBe('limited');
    expect(((await probe(p, deps(s, { semanticScholarKey: 'k' }))) as Result).status).toBe(
      'broken',
    );
  });

  it('a known work no longer found, or the invented control "found", is broken', async () => {
    const s = healthySources();
    s.crossrefSearch = async () => [{ title: 'Something else entirely' }];
    s.openalexSearch = async (_c, t) => [{ title: String(t) }];
    const results = (await probeAll(deps(s), 0)) as Result[];
    expect(results.find((r) => r.source === 'crossref')?.detail).toMatch(/no longer finds/);
    expect(results.find((r) => r.source === 'openalex')?.detail).toMatch(/invented title/);
  });
});
