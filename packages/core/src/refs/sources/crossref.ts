import { getJson, type HttpClient, isObject, listIn, readAnswer, unexpectedData } from '../http.js';
import type { WorkRecord } from '../types.js';
import { type CslLike, fromCsl } from './csl.js';

const SELECT = [
  'DOI',
  'URL',
  'type',
  'title',
  'subtitle',
  'author',
  'issued',
  'published-print',
  'published-online',
  'container-title',
  'is-referenced-by-count',
].join(',');

const HOST = 'api.crossref.org';

export interface TitleQuery {
  title: string;
  firstAuthor?: string;
  year?: number;
}

function crossrefSearchUrl(q: TitleQuery, mailto?: string): string {
  const text = [q.title, q.firstAuthor, q.year].filter(Boolean).join(' ');
  const params = new URLSearchParams({ 'query.bibliographic': text, rows: '5', select: SELECT });
  if (mailto) params.set('mailto', mailto);
  return `https://api.crossref.org/works?${params}`;
}

/** CrossRef bibliographic search; up to 5 candidates. */
export async function crossrefSearch(
  client: HttpClient,
  q: TitleQuery,
  mailto?: string,
): Promise<WorkRecord[]> {
  const { data } = await getJson<Record<string, unknown>>(client, crossrefSearchUrl(q, mailto));
  if (!data) return [];
  return readAnswer(HOST, () => {
    if (!isObject(data.message)) throw unexpectedData(HOST);
    return listIn(HOST, data.message.items)
      .map((item) => fromCsl(item as CslLike, 'crossref'))
      .filter((r): r is WorkRecord => r !== null);
  });
}
