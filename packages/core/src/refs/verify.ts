import type { BibEntry } from '../bib/parse.js';
import { arxivCacheKey, doiCacheKey, titleCacheKey } from './cache.js';
import { isAuthorProvided, PROVENANCE_FIELD, provenanceCanonical, provenanceOf } from './entry.js';
import { HttpClient } from './http.js';
import {
  type EntryKind,
  entryKind,
  type Identifiers,
  identifiersOf,
  notIndexedReason,
} from './kind.js';
import {
  type Assessment,
  assess,
  type BibFacts,
  bestAssessment,
  bibFacts,
  STRONG_TITLE,
} from './match.js';
import { asciiNormalizeTitle, normalizeTitle, stripTags } from './normalize.js';
import { attachRetractions } from './retraction.js';
import {
  aclByIdCached,
  arxivByIdCached,
  type Ctx,
  europepmcByIdCached,
  failureReason,
  openalexByDoiCached,
  prefetchArxiv,
  resolveDoiCached,
  type SourceFailure,
  sourceAllowed,
  titleSearch,
} from './search.js';
import { sha256Hex } from './sha256.js';
import type { MatchedRecord, RefResult, RefSource, RefsOptions, WorkRecord } from './types.js';

const SOURCE_NAMES: Record<RefSource, string> = {
  'doi.org': 'doi.org',
  crossref: 'CrossRef',
  dblp: 'dblp',
  arxiv: 'arXiv',
  openalex: 'OpenAlex',
  semanticscholar: 'Semantic Scholar',
  acl: 'ACL Anthology',
  europepmc: 'Europe PMC',
};

/** General indexes that can confirm CrossRef's "no match" (any one is enough). */
const SECOND_OPINION: RefSource[] = ['openalex', 'semanticscholar', 'dblp'];

/**
 * True when enough indexes answered for "no similar title anywhere" to mean
 * `not-found`: CrossRef, plus at least one other general index (OpenAlex, Semantic
 * Scholar or dblp). One index alone misses too much; any single source may be down
 * or behind a bot wall (dblp often is), so none of the others is required.
 * arXiv, Europe PMC and the ACL Anthology add coverage but are not general enough
 * to count. Failures of sources outside the quorum do not block the verdict.
 */
export function notFoundQuorum(searched: readonly RefSource[]): boolean {
  return searched.includes('crossref') && searched.some((s) => SECOND_OPINION.includes(s));
}

export function sourceName(s: RefSource): string {
  return SOURCE_NAMES[s];
}

function toMatched(r: WorkRecord): MatchedRecord {
  const m: MatchedRecord = {
    title: stripTags(r.title),
    authors: r.authors.map((a) => (a.given ? `${a.given} ${a.family}` : a.family)),
  };
  const year = r.years.length ? Math.min(...r.years) : undefined;
  if (year !== undefined) m.year = year;
  if (r.venue) m.venue = r.venue;
  if (r.doi) m.doi = r.doi;
  if (r.url) m.url = r.url;
  if (r.type) m.type = r.type;
  return m;
}

/** Evidence gathered for one entry across identifier lookups and title searches. */
interface Evidence {
  assessments: Assessment[];
  searched: Set<RefSource>;
  failures: SourceFailure[];
  doiMissing: boolean;
  arxivMissing: boolean;
  /** doi.org could not answer for the entry's DOI, and no other index confirmed it. */
  doiUnchecked: boolean;
  queries: string[];
}

function isSkipped(entry: BibEntry, ignore: Set<string>): boolean {
  if (ignore.has(entry.key)) return true;
  return /overfull\s*:\s*skip/i.test(`${entry.fields.note ?? ''} ${entry.fields.annote ?? ''}`);
}

function fromAssessment(base: RefResult, a: Assessment, ev: Evidence): RefResult {
  const result: RefResult = {
    ...base,
    status: a.verdict === 'verified' ? 'verified' : 'mismatch',
    source: a.record.source,
    matched: toMatched(a.record),
    searched: [...ev.searched],
  };
  if (a.differences.length) result.differences = a.differences;
  const doiDiff = a.differences[0];
  if (a.differentWork && doiDiff?.field === 'doi' && a.record.source === 'doi.org') {
    result.wrongWork = { field: 'doi', id: doiDiff.bib, title: toMatched(a.record).title };
  }
  if (a.differentWork && doiDiff?.field === 'eprint' && a.record.source === 'arxiv') {
    result.wrongWork = { field: 'eprint', id: doiDiff.bib, title: toMatched(a.record).title };
  }
  if (a.verdict === 'verified' && a.yearDiff === 1) {
    result.reason = 'year differs by one (common between preprint, online and print versions)';
  }
  return result;
}

async function checkDoi(
  ctx: Ctx,
  doi: string,
  facts: BibFacts,
  ev: Evidence,
): Promise<Assessment | null> {
  ev.queries.push(doiCacheKey(doi));
  try {
    const res = await resolveDoiCached(ctx, doi);
    ev.searched.add('doi.org');
    if (res.kind === 'missing') ev.doiMissing = true;
    if (res.kind !== 'found') return null;
    return assessIdentified(facts, res.record, ev, 'doi', doi, 'resolves to');
  } catch (err) {
    sourceFailed(ctx, ev, 'doi.org', err);
  }
  // doi.org could not answer: OpenAlex knows most DOIs, and a lookup by DOI is a single
  // record (no search budget). A DOI OpenAlex does not know proves nothing either way.
  const viaOpenalex = await checkOpenalexDoi(ctx, doi, facts, ev, 'doi', doi);
  if (!viaOpenalex) ev.doiUnchecked = true;
  return viaOpenalex;
}

/**
 * The OpenAlex record for a DOI (the entry's own, or arXiv's `10.48550/arXiv.<id>`), as
 * a fallback when doi.org or arXiv cannot answer or may not be asked. Null when OpenAlex
 * may not be asked, does not know the DOI, or fails.
 */
async function checkOpenalexDoi(
  ctx: Ctx,
  doi: string,
  facts: BibFacts,
  ev: Evidence,
  field: 'doi' | 'eprint',
  id: string,
): Promise<Assessment | null> {
  if (!sourceAllowed(ctx.opts, 'openalex')) return null;
  try {
    const record = await openalexByDoiCached(ctx, doi);
    if (!record) return null;
    ev.searched.add('openalex');
    return assessIdentified(facts, record, ev, field, id, field === 'doi' ? 'resolves to' : 'is');
  } catch (err) {
    return sourceFailed(ctx, ev, 'openalex', err);
  }
}

/**
 * Assesses the record an entry's own identifier points to. When it is another work,
 * the identifier itself is the first difference (the title difference is implied).
 */
function assessIdentified(
  facts: BibFacts,
  record: WorkRecord,
  ev: Evidence,
  field: 'doi' | 'eprint',
  id: string,
  verb: string,
): Assessment {
  const a = assess(facts, record, true);
  if (a.differentWork) {
    a.differences = [
      { field, bib: id, record: `${verb} “${record.title}”` },
      ...a.differences.filter((d) => d.field !== 'title'),
    ];
  }
  ev.assessments.push(a);
  return a;
}

/** Records a source failure (rethrowing when the run was aborted); the entry goes on. */
function sourceFailed(ctx: Ctx, ev: Evidence, source: RefSource, err: unknown): null {
  if (ctx.opts.signal?.aborted) throw err;
  ev.failures.push({ source, reason: failureReason(err) });
  return null;
}

async function checkArxiv(
  ctx: Ctx,
  id: string,
  facts: BibFacts,
  ev: Evidence,
): Promise<Assessment | null> {
  ev.queries.push(arxivCacheKey(id));
  try {
    const record = await arxivByIdCached(ctx, id);
    ev.searched.add('arxiv');
    if (!record) {
      ev.arxivMissing = true;
      return null;
    }
    return assessIdentified(facts, record, ev, 'eprint', id, 'is');
  } catch (err) {
    sourceFailed(ctx, ev, 'arxiv', err);
    return checkOpenalexDoi(ctx, arxivDoi(id), facts, ev, 'eprint', id);
  }
}

/**
 * arXiv may not be asked (the browser check: arXiv sends no CORS headers). arXiv registers
 * a DataCite DOI for every paper, so doi.org answers for it; OpenAlex is asked when doi.org
 * cannot answer or does not know the DOI. Neither answer proves the id wrong.
 */
async function checkArxivDoi(
  ctx: Ctx,
  id: string,
  facts: BibFacts,
  ev: Evidence,
): Promise<Assessment | null> {
  const doi = arxivDoi(id);
  if (sourceAllowed(ctx.opts, 'doi.org')) {
    try {
      const res = await resolveDoiCached(ctx, doi);
      ev.searched.add('doi.org');
      if (res.kind === 'found') return assessIdentified(facts, res.record, ev, 'eprint', id, 'is');
    } catch (err) {
      sourceFailed(ctx, ev, 'doi.org', err);
    }
  }
  return checkOpenalexDoi(ctx, doi, facts, ev, 'eprint', id);
}

/** The DOI arXiv registers for a paper: `10.48550/arXiv.<id>`. */
function arxivDoi(id: string): string {
  return `10.48550/arxiv.${id.toLowerCase()}`;
}

/**
 * The entry's ACL Anthology, PubMed or PubMed Central id. The record found is final
 * like for a DOI. An id the index does not know is no evidence either way: the search
 * goes on by title, and `not-found` needs the usual indexes to agree.
 */
async function checkOtherId(
  ctx: Ctx,
  source: 'acl' | 'europepmc',
  label: string,
  fetchRecord: () => Promise<WorkRecord | null>,
  facts: BibFacts,
  ev: Evidence,
): Promise<Assessment | null> {
  ev.queries.push(label);
  try {
    const record = await fetchRecord();
    ev.searched.add(source);
    if (!record) return null;
    const a = assess(facts, record, true);
    ev.assessments.push(a);
    return a;
  } catch (err) {
    return sourceFailed(ctx, ev, source, err);
  }
}

async function checkOtherIds(
  ctx: Ctx,
  ids: Identifiers,
  facts: BibFacts,
  ev: Evidence,
): Promise<Assessment | null> {
  if (ids.aclId && sourceAllowed(ctx.opts, 'acl')) {
    const id = ids.aclId;
    const a = await checkOtherId(ctx, 'acl', `acl:${id}`, () => aclByIdCached(ctx, id), facts, ev);
    if (a) return a;
  }
  if (sourceAllowed(ctx.opts, 'europepmc')) {
    if (ids.pmid) {
      const pmid = ids.pmid;
      const a = await checkOtherId(
        ctx,
        'europepmc',
        `pmid:${pmid}`,
        () => europepmcByIdCached(ctx, { pmid }),
        facts,
        ev,
      );
      if (a) return a;
    }
    if (ids.pmcid) {
      const pmcid = ids.pmcid;
      return checkOtherId(
        ctx,
        'europepmc',
        `pmcid:${pmcid}`,
        () => europepmcByIdCached(ctx, { pmcid }),
        facts,
        ev,
      );
    }
  }
  return null;
}

async function searchByTitle(
  ctx: Ctx,
  facts: BibFacts,
  kind: EntryKind,
  ev: Evidence,
): Promise<void> {
  if (!facts.title) return;
  ev.queries.push(titleCacheKey(facts.title, facts.year));
  const firstAuthor = facts.firstIsPersonal ? facts.surnames[0] : undefined;
  const outcome = await titleSearch(
    ctx,
    {
      title: facts.title,
      isTex: true,
      ...(firstAuthor ? { firstAuthor } : {}),
      ...(facts.year ? { year: facts.year } : {}),
    },
    (records) => {
      // For books, theses and misc entries a same-title record from another year is usually
      // another edition, a review or a re-deposit: only a full match counts.
      const found = records
        .map((r) => assess(facts, r, false))
        .filter((a) => kind === 'scholarly' || a.verdict !== 'mismatch');
      ev.assessments.push(...found);
      return found.some((a) => a.verdict === 'verified');
    },
  );
  for (const s of outcome.searched) ev.searched.add(s);
  ev.failures.push(...outcome.failures);
}

function sourcesText(sources: RefSource[]): string {
  const names = sources.map(sourceName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** One entry per source (its last error), in the order the sources first failed. */
function lastFailures(failures: SourceFailure[]): SourceFailure[] {
  const bySource = new Map<RefSource, SourceFailure>();
  for (const f of failures) bySource.set(f.source, f);
  return [...bySource.values()];
}

function failuresText(failures: SourceFailure[]): string {
  return failures.map((f) => f.reason).join('; ');
}

/**
 * The entry's own DOI or arXiv id did not resolve, but a title search found the work:
 * the identifier in the .bib is wrong, so the entry cannot be `verified`.
 */
function withBrokenIds(result: RefResult, ids: Identifiers, ev: Evidence): RefResult {
  const broken: NonNullable<RefResult['differences']> = [];
  if (ev.doiMissing && ids.doi) {
    broken.push({ field: 'doi', bib: ids.doi, record: 'does not resolve' });
  }
  if (ev.arxivMissing && ids.arxivId) {
    broken.push({ field: 'eprint', bib: ids.arxivId, record: 'does not resolve' });
  }
  if (!broken.length) return result;
  const what = broken.map((d) => (d.field === 'doi' ? `DOI ${d.bib}` : `arXiv id ${d.bib}`));
  const { reason: _reason, ...rest } = result;
  return {
    ...rest,
    status: 'mismatch',
    differences: [...broken, ...(result.differences ?? [])],
    reason: `the ${what.join(' and the ')} does not resolve, but a record with this title exists`,
  };
}

/** No candidate matched: decide between not-found, unverifiable and error. */
function noMatch(
  ctx: Ctx,
  base: RefResult,
  entry: BibEntry,
  kind: EntryKind,
  ids: Identifiers,
  ev: Evidence,
): RefResult {
  const searched = [...ev.searched];
  const withSearched = { ...base, searched };
  const opts = ctx.opts;
  // Indexes left out by the `sources` allow-list were not asked; say so in the reason.
  const skipped = (['crossref', 'openalex', 'dblp'] as RefSource[]).filter(
    (s) => !sourceAllowed(opts, s),
  );
  const skippedNote = skipped.length
    ? `(${sourcesText(skipped).replace(/ or /, ' and ')} ${skipped.length === 1 ? 'was' : 'were'} not searched)`
    : '';
  const titleNote = ev.queries.some((q) => q.startsWith('title:'))
    ? ' and no record has a similar title'
    : '';
  if (ev.arxivMissing) {
    return {
      ...withSearched,
      status: 'not-found',
      reason: `arXiv has no paper ${ids.arxivId}${titleNote}`,
    };
  }
  if (ev.doiMissing) {
    if (kind === 'scholarly') {
      return {
        ...withSearched,
        status: 'not-found',
        reason: `the DOI ${ids.doi} does not exist${titleNote}`,
      };
    }
    return {
      ...withSearched,
      status: 'mismatch',
      differences: [
        { field: 'doi', bib: ids.doi as string, record: 'does not resolve at doi.org' },
      ],
      reason: `the DOI ${ids.doi} does not exist`,
    };
  }
  if (kind !== 'scholarly') {
    const why =
      entry.type === 'book' || entry.type === 'inbook'
        ? 'books are often not indexed'
        : entry.type.endsWith('thesis')
          ? 'theses are often not indexed'
          : 'this kind of entry is often not indexed';
    const failed = ev.failures.length ? ` (lookup incomplete: ${failuresText(ev.failures)})` : '';
    return {
      ...withSearched,
      ...(ev.failures.length ? { failures: lastFailures(ev.failures) } : {}),
      status: 'unverifiable',
      reason: `no match found, but ${why}${failed}`,
    };
  }
  if (!notFoundQuorum(searched)) {
    // Indexes were left out on purpose (the `sources` allow-list) and nothing failed:
    // absence here proves nothing, so the entry is unverifiable, not missing.
    if (skipped.length && !ev.failures.length) {
      return {
        ...withSearched,
        status: 'unverifiable',
        reason: `could not be checked here ${skippedNote}`,
      };
    }
    const failed = [...new Set(ev.failures.map((f) => f.source))];
    return {
      ...withSearched,
      ...(failed.length ? { failed, failures: lastFailures(ev.failures) } : {}),
      status: 'error',
      reason: `lookup incomplete: ${failuresText(ev.failures) || 'too few indexes answered'}`,
    };
  }
  // An index knows a work with (nearly) this exact title, by other authors or from another
  // year. The search ranks by relevance, so the entry's own record may simply be further
  // down the list (a short title such as "Generative Adversarial Nets" is shared by many
  // works). That is no evidence of absence.
  const sameTitle = ev.assessments.find((a) => a.titleScore >= STRONG_TITLE);
  if (sameTitle) {
    return {
      ...withSearched,
      status: 'unverifiable',
      reason: `other works share this title (such as “${stripTags(sameTitle.record.title)}”, ${sameTitle.record.years[0] ?? 'year unknown'}), and the indexes did not single out this one; add its DOI or arXiv id to check it`,
    };
  }
  // A paper known only from its OpenReview page (often under review or just accepted) may
  // not be indexed yet, and OpenReview cannot be asked automatically: it is not "not found".
  if (ids.openreviewId) {
    return {
      ...withSearched,
      status: 'unverifiable',
      reason: `no index has it yet, and OpenReview (forum ${ids.openreviewId}) cannot be checked automatically; open the link to confirm`,
    };
  }
  return {
    ...withSearched,
    status: 'not-found',
    reason: `no record with a similar title in ${sourcesText(searched.filter((s) => s !== 'doi.org'))}`,
  };
}

/** Verifies one entry. Never throws for network problems (they become `error`). */
async function verifyEntry(entry: BibEntry, ctx: Ctx, ignore: Set<string>): Promise<RefResult> {
  const base: RefResult = { key: entry.key, status: 'unverifiable' };
  if (entry.line) base.location = { line: entry.line, ...(entry.file ? { file: entry.file } : {}) };
  if (isSkipped(entry, ignore)) return { ...base, reason: 'skipped by author' };
  const ids = identifiersOf(entry);
  const kind = entryKind(entry, ids);
  if (kind === 'not-indexed') return { ...base, reason: notIndexedReason(entry) };
  const facts = bibFacts(entry);
  if (!facts.title && !ids.doi && !ids.arxivId) {
    const reason = facts.hasTitleField
      ? 'the title has no letters or digits to look up, and there is no DOI or arXiv id'
      : 'no title, DOI or arXiv id to look up';
    return { ...base, reason };
  }

  const ev: Evidence = {
    assessments: [],
    searched: new Set(),
    failures: [],
    doiMissing: false,
    arxivMissing: false,
    doiUnchecked: false,
    queries: [],
  };
  // The entry's own identifiers are authoritative: their verdict is final.
  const viaId =
    (ids.doi && sourceAllowed(ctx.opts, 'doi.org')
      ? await checkDoi(ctx, ids.doi, facts, ev)
      : null) ??
    (ids.arxivId
      ? sourceAllowed(ctx.opts, 'arxiv')
        ? await checkArxiv(ctx, ids.arxivId, facts, ev)
        : await checkArxivDoi(ctx, ids.arxivId, facts, ev)
      : null) ??
    (await checkOtherIds(ctx, ids, facts, ev));
  const withQuery = (r: RefResult): RefResult => ({ ...r, query: ev.queries[0] ?? '' });
  const found = (a: Assessment) =>
    withQuery(withBrokenIds(withUncheckedDoi(fromAssessment(base, a, ev), a, ids, ev), ids, ev));
  if (viaId) return found(viaId);

  await searchByTitle(ctx, facts, kind, ev);
  const best = ev.doiUnchecked
    ? bestForDoi(ev.assessments, ids.doi)
    : bestAssessment(ev.assessments);
  if (best) return found(best);
  return withQuery(noMatch(ctx, base, entry, kind, ids, ev));
}

/** Best assessment, preferring a record that carries the entry's own DOI. */
function bestForDoi(list: Assessment[], doi: string | undefined): Assessment | undefined {
  const sameDoi = list.filter((a) => doi && a.record.doi?.toLowerCase() === doi);
  return bestAssessment(sameDoi) ?? bestAssessment(list);
}

/**
 * doi.org could not answer, so the entry's DOI was not checked, and the work was found
 * another way (arXiv id, title search). The record found settles the DOI only when it
 * carries one: the same DOI confirms it, another DOI is a mismatch. A record without a
 * DOI leaves it unchecked, so the entry cannot be `verified`: a made-up DOI on a real
 * title would pass otherwise.
 */
function withUncheckedDoi(
  result: RefResult,
  a: Assessment,
  ids: Identifiers,
  ev: Evidence,
): RefResult {
  if (!ev.doiUnchecked || !ids.doi) return result;
  const recordDoi = a.record.doi?.toLowerCase();
  if (recordDoi === ids.doi) return result;
  const failures = lastFailures(ev.failures);
  if (recordDoi) {
    const { reason: _reason, ...rest } = result;
    return {
      ...rest,
      status: 'mismatch',
      differences: [
        { field: 'doi', bib: ids.doi, record: recordDoi },
        ...(result.differences ?? []).filter((d) => d.field !== 'doi'),
      ],
      reason: `doi.org could not be reached, and the record found for this entry has DOI ${recordDoi}, not ${ids.doi}`,
    };
  }
  if (result.status !== 'verified') return result;
  const { reason: _reason, ...rest } = result;
  return {
    ...rest,
    status: 'error',
    failed: [...new Set(ev.failures.map((f) => f.source))],
    failures,
    reason: `a matching record exists, but the DOI ${ids.doi} could not be checked: ${failuresText(failures)}`,
  };
}

/**
 * `verifyEntry`, with any unexpected exception (a bug, odd data from an index) turned into
 * an `error` result for that entry alone: one entry must never stop the whole run.
 * Aborting the run still rejects.
 */
async function verifyEntrySafely(
  entry: BibEntry,
  ctx: Ctx,
  ignore: Set<string>,
): Promise<RefResult> {
  try {
    return await verifyEntry(entry, ctx, ignore);
  } catch (err) {
    if (ctx.opts.signal?.aborted) throw err;
    const result: RefResult = {
      key: entry.key,
      status: 'error',
      reason: `lookup incomplete: ${failureReason(err)}`,
    };
    if (entry.line)
      result.location = { line: entry.line, ...(entry.file ? { file: entry.file } : {}) };
    return result;
  }
}

async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Verifies every entry against doi.org, CrossRef, dblp, arXiv (and OpenAlex
 * with a key). Results are in input order. Network failures yield `error`,
 * never `not-found`.
 */
export async function verifyEntries(
  entries: BibEntry[],
  opts: RefsOptions = {},
): Promise<RefResult[]> {
  if (opts.offline) {
    const ignore = new Set(opts.ignore ?? []);
    return entries.map((e) => {
      const r: RefResult = {
        key: e.key,
        status: 'unverifiable' as const,
        reason: isSkipped(e, ignore) ? 'skipped by author' : 'offline',
        ...(e.line ? { location: { line: e.line, ...(e.file ? { file: e.file } : {}) } } : {}),
      };
      // Offline nothing is re-verified, so nothing but provenance vouches for an entry.
      return opts.requireProvenance && isUnproven(e, r) ? { ...r, unproven: true } : r;
    });
  }
  const ctx: Ctx = { client: new HttpClient(opts), opts };
  const ignore = new Set(opts.ignore ?? []);
  await prefetchArxiv(
    ctx,
    entries
      .filter((e) => !isSkipped(e, ignore))
      .map((e) => identifiersOf(e).arxivId)
      .filter((id): id is string => id !== undefined),
  );
  let done = 0;
  const results = await runPool(entries, opts.concurrency ?? 4, async (e) => {
    const result = await verifyEntrySafely(e, ctx, ignore);
    opts.onProgress?.(++done, entries.length);
    return opts.requireProvenance && isUnproven(e, result) ? { ...result, unproven: true } : result;
  });
  await attachRetractions(ctx, results);
  return results;
}

/**
 * With `requireProvenance`: true for an entry that is not verified and that
 * nothing vouches for. Vouching means a valid `x-overfull` marker from
 * `overfull cite` (its hash matches the entry) together with a DOI, eprint or
 * URL a reader can follow; or the author's own `note = {overfull:
 * author-provided}`; or the author's `overfull: skip` / `references.ignore`.
 * Books, websites and software are no exception: `overfull cite` adds them
 * when they have a DOI, and the author can vouch for the rest.
 */
export function isUnproven(entry: BibEntry, result: RefResult): boolean {
  if (result.status === 'verified') return false;
  if (result.reason === 'skipped by author' || isAuthorProvided(entry)) return false;
  return !hasValidProvenance(entry);
}

/** A valid `x-overfull` marker plus something to follow (DOI, eprint or URL). */
export function hasValidProvenance(entry: BibEntry): boolean {
  const f = entry.fields;
  const ids = identifiersOf(entry);
  const marked = provenanceOf(entry) !== undefined || hasLegacyProvenance(entry);
  return Boolean(marked && (ids.doi || ids.arxivId || f.doi || f.eprint || f.url));
}

const SEP = '\u001f';

/**
 * A marker written before titles kept letters outside ASCII: its hash covers the title
 * normalized to ASCII letters and digits only. Only titles where the two forms differ
 * need this; for the others the current hash is the same.
 */
function hasLegacyProvenance(entry: BibEntry): boolean {
  const title = entry.fields.title ?? '';
  const legacy = asciiNormalizeTitle(title);
  if (legacy === normalizeTitle(title, true)) return false;
  const value = entry.fields[PROVENANCE_FIELD]?.replace(/\s+/g, ' ').trim();
  const m = value ? /^cite\s+\S+\s+\d{4}-\d{2}-\d{2}\s+([0-9a-f]{12})$/i.exec(value) : null;
  if (!m) return false;
  const parts = provenanceCanonical(entry).split(SEP);
  if (parts.length !== 7) return false;
  parts[2] = legacy;
  return sha256Hex(parts.join(SEP)).slice(0, 12) === (m[1] as string).toLowerCase();
}
