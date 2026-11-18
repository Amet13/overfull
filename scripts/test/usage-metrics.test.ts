/** scripts/usage-metrics.mjs: counts, rate limits and the monthly history, without the network. */
import { describe, expect, it } from 'vitest';
import {
  collect,
  merge,
  parseGhcrPulls,
  rateLimitWait,
  SEARCHES,
  summary,
  // @ts-expect-error: a plain .mjs script without type declarations
} from '../usage-metrics.mjs';

type Answer = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };

/** A fetch that answers from a table of URL substrings; every call is recorded. */
function fakeFetch(routes: [string, Answer | Answer[]][]) {
  const calls: string[] = [];
  const queues = new Map(routes.map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fetch = async (url: string) => {
    calls.push(url);
    for (const [key, queue] of queues) {
      if (!url.includes(key)) continue;
      const a = (queue.length > 1 ? queue.shift() : queue[0]) as Answer;
      const status = a.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(a.headers ?? {}),
        json: async () => a.body,
        text: async () => a.text ?? '',
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { fetch, calls };
}

const NOW = Date.parse('2026-12-01T05:00:00Z');
const releases = [
  { tag_name: 'v3.1.2', assets: [{ download_count: 5 }, { download_count: 7 }] },
  { tag_name: 'v3.1.1', assets: [{ download_count: 3 }] },
];
const healthy: [string, Answer | Answer[]][] = [
  ['/repos/Amet13/overfull/releases', { body: releases }],
  ['/repos/Amet13/overfull', { body: { stargazers_count: 101, forks_count: 9 } }],
  ['pkgs/container', { text: '<span>Total downloads</span>\n<h3 title="1,234">1.2K</h3>' }],
  [encodeURIComponent(SEARCHES.workflowsUsingAction), { body: { total_count: 4 } }],
  [encodeURIComponent(SEARCHES.bibFilesWithMarker), { body: { total_count: 2 } }],
];

function deps(routes = healthy) {
  const f = fakeFetch(routes);
  const slept: number[] = [];
  return {
    f,
    slept,
    d: {
      fetch: f.fetch,
      token: 'gh-token',
      now: () => NOW,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
  };
}

describe('usage-metrics', () => {
  it('records stars, forks, release downloads, ghcr pulls and search counts', async () => {
    const { d } = deps();
    const { entry, notes } = await collect(d);
    expect(entry).toEqual({
      month: '2026-12',
      recordedOn: '2026-12-01',
      stars: 101,
      forks: 9,
      releaseDownloads: 15,
      releaseDownloadsByTag: { 'v3.1.2': 12, 'v3.1.1': 3 },
      ghcrPulls: 1234,
      workflowsUsingAction: 4,
      bibFilesWithMarker: 2,
    });
    expect(notes).toEqual([]);
  });

  it('waits out a search rate limit once, then gives up with null and a note', async () => {
    const limited = {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 30) },
    };
    const routes: [string, Answer | Answer[]][] = [
      ...healthy.slice(0, 3),
      [encodeURIComponent(SEARCHES.workflowsUsingAction), [limited, { body: { total_count: 6 } }]],
      [encodeURIComponent(SEARCHES.bibFilesWithMarker), [limited, limited]],
    ];
    const { d, slept } = deps(routes);
    const { entry, notes } = await collect(d);
    expect(entry.workflowsUsingAction).toBe(6);
    expect(entry.bibFilesWithMarker).toBeNull();
    expect(slept).toEqual([31_000, 31_000]);
    expect(notes.join('\n')).toMatch(/x-overfull.*HTTP 403 \(rate limited\)/);
  });

  it('a ghcr page that cannot be read is null, not a failure', async () => {
    const routes: [string, Answer | Answer[]][] = [
      healthy[0] as [string, Answer],
      healthy[1] as [string, Answer],
      ['pkgs/container', { status: 404 }],
      ...healthy.slice(3),
    ];
    const { d } = deps(routes);
    const { entry, notes } = await collect(d);
    expect(entry.ghcrPulls).toBeNull();
    expect(notes).toEqual(['ghcr pulls: HTTP 404']);
    expect(parseGhcrPulls('<html>no counts</html>')).toBeNull();
  });

  it('a failing repository or releases request fails the run', async () => {
    const { d } = deps([['/repos/Amet13/overfull', { status: 500 }]]);
    await expect(collect(d)).rejects.toThrow(/HTTP 500/);
  });

  it('pages through more than 100 releases', async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        tag_name: `v0.0.${from + i}`,
        assets: [{ download_count: 1 }],
      }));
    const routes: [string, Answer | Answer[]][] = [
      ['releases?per_page=100&page=1', { body: page(100, 0) }],
      ['releases?per_page=100&page=2', { body: page(3, 100) }],
      ...healthy.slice(1),
    ];
    const { d, f } = deps(routes);
    const { entry } = await collect(d);
    expect(entry.releaseDownloads).toBe(103);
    expect(f.calls.filter((c) => c.includes('/releases?'))).toHaveLength(2);
  });

  it('sends the token and reads rate-limit headers', async () => {
    const { d, f } = deps();
    await collect(d);
    expect(f.calls.some((c) => c.startsWith('https://api.github.com/search/code?q='))).toBe(true);
    const h = (o: Record<string, string>) => new Headers(o);
    expect(rateLimitWait({ status: 429, headers: h({ 'retry-after': '7' }) }, NOW)).toBe(7000);
    expect(rateLimitWait({ status: 403, headers: h({}) }, NOW)).toBeUndefined();
    expect(rateLimitWait({ status: 500, headers: h({ 'retry-after': '7' }) }, NOW)).toBeUndefined();
  });

  it('keeps one entry per month: a rerun replaces it, a new month appends', () => {
    const e = (month: string, stars: number) => ({ month, stars });
    let h = merge(undefined, e('2026-11', 90));
    h = merge(h, e('2026-12', 100));
    h = merge(h, e('2026-12', 101));
    expect(h.entries).toEqual([e('2026-11', 90), e('2026-12', 101)]);
    const text = summary(h, ['ghcr pulls: HTTP 404']);
    expect(text).toContain('| Stars | 101 (+11) |');
    expect(text).toContain('| ghcr.io pulls | not available |');
    expect(text).toContain('- ghcr pulls: HTTP 404');
  });
});
