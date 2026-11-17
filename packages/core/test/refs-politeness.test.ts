/**
 * Request etiquette and cache keys: CrossRef spacing and concurrency (public pool without a
 * `mailto`, polite pool with one), the first author in the title-search cache key, and the
 * arXiv batch for ids whose cached answer is missing, unreadable or too old.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBib } from '../src/bib/index.js';
import { HttpClient } from '../src/refs/http.js';
import { arxivCacheKey, type RefCache, verifyEntries } from '../src/refs/index.js';
import { handlerFetch, json } from './fixtures/refs/fake-fetch.js';

afterEach(() => vi.useRealTimers());

/** A fetch that answers after `latency` ms and records when each request started. */
function timedFetch(latency = 50) {
  const starts: number[] = [];
  let inFlight = 0;
  let max = 0;
  const fetch = (async () => {
    starts.push(Date.now());
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, latency));
    inFlight--;
    return json({ message: { items: [] } });
  }) as typeof globalThis.fetch;
  return { fetch, starts, maxInFlight: () => max };
}

async function sixRequests(opts: ConstructorParameters<typeof HttpClient>[0], latency = 50) {
  vi.useFakeTimers();
  const t = timedFetch(latency);
  const client = new HttpClient({ ...opts, fetch: t.fetch });
  const url = (i: number) => `https://api.crossref.org/works?query=${i}`;
  // The first answer makes the host "proven"; after that requests may overlap.
  const first = client.get(url(0), 'application/json');
  await vi.advanceTimersByTimeAsync(latency + 50);
  await first;
  const all = Promise.all([1, 2, 3, 4, 5, 6].map((i) => client.get(url(i), 'application/json')));
  await vi.advanceTimersByTimeAsync(20_000);
  await all;
  const gaps = t.starts.slice(1).map((s, i) => s - (t.starts[i] as number));
  return { gaps, maxInFlight: t.maxInFlight() };
}

describe('CrossRef request spacing', () => {
  it('without a mailto: one request at a time, about 1.1 s apart', async () => {
    const { gaps, maxInFlight } = await sixRequests({});
    expect(maxInFlight).toBe(1);
    for (const g of gaps.slice(1)) expect(g).toBeGreaterThanOrEqual(1100);
  });

  it('with a mailto (polite pool): up to three at a time, about 350 ms apart', async () => {
    // Answers take 2 s here, so requests overlap: never more than three.
    const { gaps, maxInFlight } = await sixRequests({ mailto: 'me@example.org' }, 2000);
    expect(maxInFlight).toBe(3);
    for (const g of gaps.slice(1)) expect(g).toBeGreaterThanOrEqual(350);
  });

  it('can be turned off for tests (crossrefIntervalMs: 0)', async () => {
    const { gaps } = await sixRequests({ mailto: 'me@example.org', crossrefIntervalMs: 0 });
    expect(Math.max(...gaps.slice(1))).toBeLessThan(100);
  });

  it('leaves other hosts alone', async () => {
    vi.useFakeTimers();
    const t = timedFetch();
    const client = new HttpClient({ fetch: t.fetch });
    const first = client.get('https://dblp.org/a', 'application/json');
    await vi.advanceTimersByTimeAsync(100);
    await first;
    const all = Promise.all([1, 2, 3].map((i) => client.get(`https://dblp.org/${i}`, '*/*')));
    await vi.advanceTimersByTimeAsync(200);
    await all;
    expect(t.maxInFlight()).toBe(3);
  });
});

const fast = { arxivIntervalMs: 0, crossrefIntervalMs: 0, retryDelayMs: 0 };
const emptyDblp = { result: { hits: { '@total': '0' } } };
const emptyAtom = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const atom = (body: string) =>
  new Response(body, { headers: { 'content-type': 'application/atom+xml' } });

function memoryCache(): RefCache & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: (k) => map.get(k), set: (k, v) => void map.set(k, v) };
}

describe('the title-search cache key', () => {
  it('includes the folded first author CrossRef is asked with', async () => {
    const cache = memoryCache();
    const crossref: string[] = [];
    const f = handlerFetch((u) => {
      if (u.host === 'api.crossref.org') {
        crossref.push(u.searchParams.get('query.bibliographic') ?? '');
        return json({ message: { items: [] } });
      }
      if (u.host === 'dblp.org') return json(emptyDblp);
      return atom(emptyAtom);
    });
    const bib = (author: string) =>
      parseBib(
        `@article{k, author = {${author}}, title = {Same Title Here}, journal = {J}, year = {2020}}`,
      );
    await verifyEntries(bib('Gödel, Kurt'), { fetch: f.fetch, cache, ...fast });
    await verifyEntries(bib('Turing, Alan'), { fetch: f.fetch, cache, ...fast });
    // Another first author is another CrossRef query, so it is asked again.
    expect(crossref).toEqual(['Same Title Here godel 2020', 'Same Title Here turing 2020']);
    expect([...cache.map.keys()].filter((k) => k.startsWith('title:')).sort()).toEqual([
      'title:same title here|2020|author:godel',
      'title:same title here|2020|author:turing',
    ]);
    await verifyEntries(bib('Turing, Alan'), { fetch: f.fetch, cache, ...fast });
    expect(crossref).toHaveLength(2);
  });
});

describe('arXiv prefetch', () => {
  it('batches ids whose cached answer is missing, null or too old', async () => {
    const cache = memoryCache();
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const rec = (id: string) => ({
      record: { source: 'arxiv', title: `Paper ${id}`, authors: [], years: [2020], arxivId: id },
    });
    cache.map.set(arxivCacheKey('2001.00002'), null);
    cache.map.set(arxivCacheKey('2001.00003'), { ...rec('2001.00003'), cachedAt: old });
    cache.map.set(arxivCacheKey('2001.00004'), { ...rec('2001.00004'), cachedAt: Date.now() });
    const lists: string[] = [];
    const f = handlerFetch((u) => {
      lists.push(u.searchParams.get('id_list') ?? '');
      return atom(emptyAtom);
    });
    const bib = ['2001.00001', '2001.00002', '2001.00003', '2001.00004']
      .map(
        (id, i) => `@misc{k${i}, title = {Paper ${id}}, eprint = {${id}}, archiveprefix = {arXiv}}`,
      )
      .join('\n');
    await verifyEntries(parseBib(bib), {
      fetch: f.fetch,
      cache,
      ...fast,
      sources: ['arxiv'],
    });
    expect(lists[0]).toBe('2001.00001,2001.00002,2001.00003');
  });
});
