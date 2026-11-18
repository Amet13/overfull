#!/usr/bin/env node
// Monthly usage counts without telemetry (maintenance.yml, usage task). Records only
// public numbers GitHub already shows, into metrics/usage.json, one entry per month:
//   - stars and forks;
//   - downloads of every release file (cumulative, as GitHub counts them);
//   - ghcr.io pulls, read from the package's public page (null when it cannot be read:
//     the packages API has no download counts, and the page is not an API);
//   - code search: public workflows that use `amet13/overfull@` and public .bib files
//     with the `x-overfull` marker (null when search refuses, e.g. a rate limit that
//     outlasts one wait).
// Overfull itself sends nothing anywhere; this runs only in this repository's workflow.
//
//   GITHUB_TOKEN=... node scripts/usage-metrics.mjs [--file metrics/usage.json] [--summary file]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const REPO = 'Amet13/overfull';
const API = 'https://api.github.com';
const PACKAGE_PAGE = 'https://github.com/Amet13/overfull/pkgs/container/overfull';

/** Code-search queries; our own repository is left out. */
export const SEARCHES = {
  workflowsUsingAction: `"amet13/overfull@" path:.github/workflows -repo:${REPO}`,
  bibFilesWithMarker: `x-overfull extension:bib -repo:${REPO}`,
};

/** How long to wait for a rate limit to reset, in ms (longer waits give up: null). */
const MAX_WAIT_MS = 65_000;

/**
 * Milliseconds until a rate-limited request may be retried, from `retry-after` or
 * `x-ratelimit-reset`; undefined when the answer is not a rate limit.
 */
export function rateLimitWait(res, nowMs) {
  if (res.status !== 403 && res.status !== 429) return undefined;
  const after = Number(res.headers.get('retry-after'));
  if (after > 0) return after * 1000;
  if (res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (reset > 0) return Math.max(0, reset * 1000 - nowMs) + 1000;
  }
  return res.status === 429 ? 60_000 : undefined;
}

/**
 * GET a GitHub API path as JSON. A rate limit is waited out once (up to MAX_WAIT_MS);
 * anything else that is not 2xx throws.
 */
export async function api(path, deps) {
  for (let attempt = 0; ; attempt++) {
    const res = await deps.fetch(`${API}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'overfull-usage-metrics',
        ...(deps.token ? { authorization: `Bearer ${deps.token}` } : {}),
      },
    });
    if (res.ok) return res.json();
    const wait = rateLimitWait(res, deps.now());
    if (wait !== undefined && attempt === 0 && wait <= MAX_WAIT_MS) {
      await deps.sleep(wait);
      continue;
    }
    throw new Error(`${path}: HTTP ${res.status}${wait !== undefined ? ' (rate limited)' : ''}`);
  }
}

/** Downloads of every release file, per release tag and in total. */
export async function releaseDownloads(deps) {
  const byRelease = {};
  for (let page = 1; page <= 10; page++) {
    const releases = await api(`/repos/${REPO}/releases?per_page=100&page=${page}`, deps);
    for (const r of releases) {
      byRelease[r.tag_name] = (r.assets ?? []).reduce((n, a) => n + (a.download_count ?? 0), 0);
    }
    if (releases.length < 100) break;
  }
  const total = Object.values(byRelease).reduce((n, v) => n + v, 0);
  return { total, byRelease };
}

/** `total_count` of a code search, or null (with a note) when search refuses. */
export async function searchCount(query, deps, notes) {
  try {
    const r = await api(`/search/code?q=${encodeURIComponent(query)}&per_page=1`, deps);
    return typeof r.total_count === 'number' ? r.total_count : null;
  } catch (e) {
    notes.push(`code search "${query}": ${e.message}`);
    return null;
  }
}

/**
 * The "Total downloads" number on the package's public page, or null. The page shows it
 * as `<h3 title="1234">1.2K</h3>` after the words "Total downloads".
 */
export function parseGhcrPulls(html) {
  const at = html.search(/Total downloads/i);
  if (at < 0) return null;
  const m = /title="([\d,]+)"/.exec(html.slice(at, at + 400));
  return m ? Number((m[1] ?? '').replace(/,/g, '')) : null;
}

export async function ghcrPulls(deps, notes) {
  try {
    const res = await deps.fetch(PACKAGE_PAGE, {
      headers: { 'user-agent': 'overfull-usage-metrics' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const n = parseGhcrPulls(await res.text());
    if (n === null) notes.push('ghcr pulls: no "Total downloads" on the package page');
    return n;
  } catch (e) {
    notes.push(`ghcr pulls: ${e.message}`);
    return null;
  }
}

/** This month's entry. Repository and release counts must succeed; the rest may be null. */
export async function collect(deps) {
  const notes = [];
  const repo = await api(`/repos/${REPO}`, deps);
  const downloads = await releaseDownloads(deps);
  const pulls = await ghcrPulls(deps, notes);
  const search = {};
  for (const [key, query] of Object.entries(SEARCHES))
    search[key] = await searchCount(query, deps, notes);
  const today = new Date(deps.now()).toISOString().slice(0, 10);
  return {
    entry: {
      month: today.slice(0, 7),
      recordedOn: today,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      releaseDownloads: downloads.total,
      releaseDownloadsByTag: downloads.byRelease,
      ghcrPulls: pulls,
      ...search,
    },
    notes,
  };
}

/** The history with `entry` added: one entry per month, a rerun replaces that month's. */
export function merge(history, entry) {
  const entries = (history?.entries ?? []).filter((e) => e.month !== entry.month);
  entries.push(entry);
  entries.sort((a, b) => a.month.localeCompare(b.month));
  return {
    about:
      'Public usage counts recorded monthly by maintenance.yml (usage task, scripts/usage-metrics.mjs). Download counts are cumulative. null: not available that month.',
    entries,
  };
}

/** A short Markdown summary for the pull request, with the change since last month. */
export function summary(history, notes = []) {
  const [prev, cur] =
    history.entries.slice(-2).length === 2
      ? history.entries.slice(-2)
      : [undefined, history.entries.at(-1)];
  const row = (label, key) => {
    const v = cur?.[key];
    const p = prev?.[key];
    const delta =
      typeof v === 'number' && typeof p === 'number' ? ` (${v - p >= 0 ? '+' : ''}${v - p})` : '';
    return `| ${label} | ${v ?? 'not available'}${delta} |`;
  };
  const lines = [
    `Usage counts for ${cur?.month}${prev ? `, compared with ${prev.month}` : ''}.`,
    '',
    '| Count | Value |',
    '| --- | --- |',
    row('Stars', 'stars'),
    row('Forks', 'forks'),
    row('Release downloads (all files, all releases)', 'releaseDownloads'),
    row('ghcr.io pulls', 'ghcrPulls'),
    row('Public workflows using amet13/overfull@', 'workflowsUsingAction'),
    row('Public .bib files with x-overfull', 'bibFilesWithMarker'),
  ];
  if (notes.length) lines.push('', 'Not recorded:', '', ...notes.map((n) => `- ${n}`));
  return `${lines.join('\n')}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string', default: 'metrics/usage.json' },
      summary: { type: 'string' },
    },
  });
  let history;
  try {
    history = JSON.parse(readFileSync(values.file, 'utf8'));
  } catch {
    history = { entries: [] };
  }
  const deps = {
    fetch: globalThis.fetch,
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
  const { entry, notes } = await collect(deps);
  const next = merge(history, entry);
  mkdirSync(dirname(values.file), { recursive: true });
  writeFileSync(values.file, `${JSON.stringify(next, null, 2)}\n`);
  const text = summary(next, notes);
  if (values.summary) writeFileSync(values.summary, text);
  process.stdout.write(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
