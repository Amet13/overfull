import { parseNames } from '../../bib/names.js';
import { getJson, type HttpClient, listIn, readAnswer } from '../http.js';
import type { WorkRecord } from '../types.js';

interface OpenAlexWork {
  display_name?: string;
  title?: string;
  publication_year?: number;
  doi?: string;
  type?: string;
  cited_by_count?: number;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: { source?: { display_name?: string } | null; landing_page_url?: string };
}

const HOST = 'api.openalex.org';

function openalexSearchUrl(title: string, apiKey?: string, mailto?: string): string {
  const params = new URLSearchParams({ search: title, 'per-page': '5' });
  if (apiKey) params.set('api_key', apiKey);
  if (mailto) params.set('mailto', mailto);
  return `https://${HOST}/works?${params}`;
}

/** Fields a record needs; `select` keeps a single-work answer small. */
const SELECT = [
  'display_name',
  'title',
  'publication_year',
  'doi',
  'type',
  'cited_by_count',
  'authorships',
  'primary_location',
].join(',');

/** One work by DOI: `/works/doi:<doi>` (OpenAlex's documented DOI namespace). */
function openalexDoiUrl(doi: string, apiKey?: string, mailto?: string): string {
  const params = new URLSearchParams({ select: SELECT });
  if (apiKey) params.set('api_key', apiKey);
  if (mailto) params.set('mailto', mailto);
  const path = encodeURIComponent(doi).replace(/%2F/gi, '/');
  return `https://${HOST}/works/doi:${path}?${params}`;
}

function fromOpenAlex(w: OpenAlexWork): WorkRecord | null {
  const title = w.display_name ?? w.title;
  if (!title) return null;
  const authors = (w.authorships ?? [])
    .map((a) => parseNames(a.author?.display_name ?? '')[0])
    .filter((n) => n !== undefined)
    .map((n) => (n.given ? { given: n.given, family: n.family } : { family: n.family }));
  const record: WorkRecord = {
    source: 'openalex',
    title,
    authors,
    years: w.publication_year ? [w.publication_year] : [],
  };
  const venue = w.primary_location?.source?.display_name;
  if (venue) record.venue = venue;
  if (w.doi) record.doi = w.doi.replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
  const url = w.primary_location?.landing_page_url;
  if (url) record.url = url;
  // Without a venue an OpenAlex "article" is often a repository deposit or a
  // preprint; it becomes @misc rather than an @article with no journal.
  if (w.type && (venue || w.type !== 'article')) record.type = w.type;
  if (typeof w.cited_by_count === 'number') record.citations = w.cited_by_count;
  return record;
}

/**
 * OpenAlex search; up to 5 candidates. Without an API key OpenAlex serves a small
 * per-IP daily budget; a 429 once it is used up is a lookup failure.
 */
export async function openalexSearch(
  client: HttpClient,
  title: string,
  apiKey: string | undefined,
  mailto?: string,
): Promise<WorkRecord[]> {
  const { data } = await getJson<{ results?: unknown }>(
    client,
    openalexSearchUrl(title, apiKey, mailto),
  );
  if (!data) return [];
  return readAnswer(HOST, () =>
    listIn(HOST, data.results)
      .map((w) => fromOpenAlex(w as OpenAlexWork))
      .filter((r): r is WorkRecord => r !== null),
  );
}

/**
 * The work with this DOI, or null when OpenAlex does not know it. A lookup of one work by
 * id: without a key it does not count against OpenAlex's daily search budget, so it is
 * the fallback when doi.org (or arXiv, for `10.48550/arXiv.<id>`) cannot answer.
 */
export async function openalexByDoi(
  client: HttpClient,
  doi: string,
  apiKey: string | undefined,
  mailto?: string,
): Promise<WorkRecord | null> {
  const { data } = await getJson<OpenAlexWork>(client, openalexDoiUrl(doi, apiKey, mailto));
  if (!data) return null;
  return readAnswer(HOST, () => fromOpenAlex(data));
}
