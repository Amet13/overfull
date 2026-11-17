/**
 * Retractions and withdrawals, from CrossRef.
 *
 * Source of the fields: CrossRef's REST API, `updated-by` on a work (read from live
 * answers on 2026-11-10; CrossRef's field guide is https://github.com/CrossRef/rest-api-doc
 * and the filter `update-type` is listed there). A work that has been retracted carries
 * `updated-by: [{ DOI: <notice DOI>, type: "retraction", label: "Retraction", source:
 * "retraction-watch" | "publisher", updated: { date-parts: [[y, m, d]] } }]`; the notice
 * itself carries the same record under `update-to`. A withdrawn work has `type:
 * "withdrawal"`. Other types (`correction`, `expression_of_concern`, …) are not reported.
 * One request covers up to 40 DOIs: `/works?filter=doi:a,doi:b&select=DOI,updated-by`.
 * CORS: `access-control-allow-origin: *`. Rate limit: CrossRef advertises it in
 * `X-Rate-Limit-*` headers (1 request per second for the public pool when read); the same
 * `mailto` as for title search puts the request in the polite pool.
 *
 * arXiv has no such field: a withdrawn paper says so in its abstract text, which also
 * appears when the author withdrew a paper because it was published. That is not evidence of
 * a retraction, so arXiv is not used.
 */

import { cacheMaxAge, isFresh } from './cache.js';
import { getJson, type HttpClient, isObject, listIn, readAnswer, unexpectedData } from './http.js';
import { type Ctx, failureReason } from './search.js';
import type { RefResult, RetractionNotice } from './types.js';

interface UpdateEntry {
  DOI?: string;
  type?: string;
  source?: string;
  updated?: { 'date-parts'?: (number | null)[][] };
}

interface WorkUpdates {
  DOI?: string;
  'updated-by'?: UpdateEntry[];
}

const BATCH = 40;

function dateOf(u: UpdateEntry): string | undefined {
  const [y, m, d] = u.updated?.['date-parts']?.[0] ?? [];
  if (!y) return undefined;
  return [y, m, d]
    .filter((n): n is number => typeof n === 'number')
    .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0'))
    .join('-');
}

/** The retraction (preferred) or withdrawal in a work's `updated-by`, if any. */
export function retractionOf(work: WorkUpdates): RetractionNotice | undefined {
  const updates = work['updated-by'] ?? [];
  const pick =
    updates.find((u) => u.type === 'retraction') ?? updates.find((u) => u.type === 'withdrawal');
  if (!pick || !work.DOI) return undefined;
  const notice: RetractionNotice = {
    kind: pick.type === 'withdrawal' ? 'withdrawal' : 'retraction',
    doi: work.DOI.toLowerCase(),
  };
  if (pick.DOI) notice.noticeDoi = pick.DOI.toLowerCase();
  const date = dateOf(pick);
  if (date) notice.date = date;
  if (pick.source) notice.assertedBy = pick.source;
  return notice;
}

function crossrefUpdatesUrl(dois: string[], mailto?: string): string {
  const params = new URLSearchParams({
    filter: dois.map((d) => `doi:${d}`).join(','),
    select: 'DOI,updated-by',
    rows: String(dois.length),
  });
  if (mailto) params.set('mailto', mailto);
  return `https://api.crossref.org/works?${params}`;
}

interface Stored {
  notice?: RetractionNotice;
  cachedAt?: number;
}

export interface RetractionCheck {
  /** Retracted or withdrawn works among the DOIs asked about, by lowercase DOI. */
  found: Map<string, RetractionNotice>;
  /** DOIs CrossRef could not be asked about (a request failed). */
  unchecked: string[];
  /** Why some DOIs were not checked: the last request error. */
  incomplete?: string;
}

/** The notices in one CrossRef answer, by DOI. Throws "unexpected data" for another shape. */
function noticesIn(data: unknown): Map<string, RetractionNotice> {
  const host = 'api.crossref.org';
  return readAnswer(host, () => {
    // Without a work list nothing is known: no "clean" answer may be stored.
    const message = isObject(data) ? data.message : undefined;
    if (!isObject(message)) throw unexpectedData(host);
    const byDoi = new Map<string, RetractionNotice>();
    for (const item of listIn(host, message.items)) {
      const notice = retractionOf(item as WorkUpdates);
      if (notice) byDoi.set(notice.doi, notice);
    }
    return byDoi;
  });
}

/**
 * Asks CrossRef which of these DOIs are retracted or withdrawn. Answers are cached for one
 * day (a retraction can appear any time, so a clean answer is not kept for 30 days). Each
 * request of 40 DOIs stands alone: when one fails, the others still count, and the DOIs it
 * covered are listed as unchecked.
 */
export async function findRetractions(
  client: HttpClient,
  ctx: Pick<Ctx, 'opts'>,
  dois: string[],
): Promise<RetractionCheck> {
  const { cache } = ctx.opts;
  const found = new Map<string, RetractionNotice>();
  const unchecked: string[] = [];
  let incomplete: string | undefined;
  const maxAge = { ...cacheMaxAge(ctx.opts.cacheMaxAgeDays) };
  maxAge.negative = Math.min(maxAge.negative, 1);
  maxAge.positive = Math.min(maxAge.positive, 1);
  const todo: string[] = [];
  for (const doi of [...new Set(dois)]) {
    // DOIs with a comma would split the filter; they are left unchecked.
    if (doi.includes(',')) continue;
    const hit =
      cache && !ctx.opts.refresh ? ((await cache.get(`retraction:${doi}`)) as Stored) : null;
    if (hit && typeof hit === 'object' && isFresh(hit.cachedAt, false, maxAge)) {
      if (hit.notice) found.set(doi, hit.notice);
    } else todo.push(doi);
  }
  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    let byDoi: Map<string, RetractionNotice>;
    try {
      const { data } = await getJson<unknown>(client, crossrefUpdatesUrl(chunk, ctx.opts.mailto));
      byDoi = noticesIn(data);
    } catch (err) {
      if (ctx.opts.signal?.aborted) throw err;
      unchecked.push(...chunk);
      incomplete = failureReason(err);
      continue;
    }
    for (const doi of chunk) {
      const notice = byDoi.get(doi);
      if (notice) found.set(doi, notice);
      if (cache)
        await cache.set(`retraction:${doi}`, {
          ...(notice ? { notice } : {}),
          cachedAt: Date.now(),
        });
    }
  }
  return { found, unchecked, ...(incomplete ? { incomplete } : {}) };
}

/**
 * Adds `retraction` to results whose matched work CrossRef records as retracted or
 * withdrawn. Best effort: when CrossRef cannot answer for some works, what it did answer is
 * kept, and the others get `retractionUnchecked` (reported once, as a note).
 */
export async function attachRetractions(ctx: Ctx, results: RefResult[]): Promise<void> {
  if (!ctx.opts.checkRetractions) return;
  if (ctx.opts.sources && !ctx.opts.sources.includes('crossref')) return;
  const candidates: { r: RefResult; doi: string }[] = [];
  for (const r of results) {
    const doi = r.matched?.doi?.toLowerCase();
    if ((r.status === 'verified' || r.status === 'mismatch') && !r.wrongWork && doi)
      if (!doi.startsWith('10.48550/')) candidates.push({ r, doi });
  }
  if (!candidates.length) return;
  let check: RetractionCheck;
  try {
    check = await findRetractions(
      ctx.client,
      ctx,
      candidates.map((c) => c.doi),
    );
  } catch (err) {
    if (ctx.opts.signal?.aborted) throw err;
    // Not a request failure (those are caught per request): say so, change nothing else.
    check = {
      found: new Map(),
      unchecked: candidates.map((c) => c.doi),
      incomplete: failureReason(err),
    };
  }
  const unchecked = new Set(check.unchecked);
  for (const { r, doi } of candidates) {
    const notice = check.found.get(doi);
    if (notice) r.retraction = notice;
    else if (unchecked.has(doi)) r.retractionUnchecked = check.incomplete ?? 'request failed';
  }
}
