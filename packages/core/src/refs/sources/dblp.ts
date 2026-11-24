import { parseNames } from '../../bib/names.js';
import {
  getJson,
  type HttpClient,
  isObject,
  listIn,
  readAnswer,
  SourceUnavailableError,
  unexpectedData,
} from '../http.js';
import { titleSimilarity } from '../normalize.js';
import type { WorkRecord } from '../types.js';

interface DblpAuthor {
  text?: string;
}

interface DblpInfo {
  title?: string;
  authors?: { author?: DblpAuthor | DblpAuthor[] };
  venue?: string | string[];
  year?: string;
  type?: string;
  doi?: string;
  ee?: string | string[];
  url?: string;
}

const SEARCH_HOST = 'dblp.org';
const SPARQL_URL = 'https://sparql.dblp.org/sparql';
const SPARQL_HOST = new URL(SPARQL_URL).host;
/** Candidates kept per title, as the search API's `h=5`. */
const MAX_HITS = 5;

function dblpSearchUrl(title: string): string {
  const params = new URLSearchParams({ q: title, format: 'json', h: String(MAX_HITS) });
  return `https://${SEARCH_HOST}/search/publ/api?${params}`;
}

/** "Jane Doe 0002" → { given: Jane, family: Doe } (dblp's homonym suffix dropped). */
function dblpPerson(text: string): { given?: string; family: string } {
  const clean = text.replace(/\s+\d{4}$/, '');
  const [name] = parseNames(clean);
  if (!name) return { family: clean };
  return name.given ? { given: name.given, family: name.family } : { family: name.family };
}

function fromDblp(info: DblpInfo): WorkRecord | null {
  if (!info.title) return null;
  const authorField = info.authors?.author;
  const authors = (Array.isArray(authorField) ? authorField : authorField ? [authorField] : [])
    .map((a) => dblpPerson(a.text ?? ''))
    .filter((a) => a.family);
  const year = Number(info.year);
  const record: WorkRecord = {
    source: 'dblp',
    title: info.title.replace(/\.$/, ''),
    authors,
    years: Number.isInteger(year) ? [year] : [],
  };
  const venue = Array.isArray(info.venue) ? info.venue[0] : info.venue;
  if (venue) record.venue = venue;
  if (info.doi) record.doi = info.doi.toLowerCase();
  const ee = Array.isArray(info.ee) ? info.ee[0] : info.ee;
  if (ee ?? info.url) record.url = (ee ?? info.url) as string;
  if (info.type) record.type = info.type;
  return record;
}

async function searchApi(client: HttpClient, title: string): Promise<WorkRecord[]> {
  const { data } = await getJson<Record<string, unknown>>(client, dblpSearchUrl(title));
  if (!data) return [];
  return readAnswer(SEARCH_HOST, () => {
    const hits = isObject(data.result) ? data.result.hits : undefined;
    if (!isObject(hits)) throw unexpectedData(SEARCH_HOST);
    // dblp leaves `hit` out when nothing matches.
    return listIn(SEARCH_HOST, hits.hit, true)
      .map((h) => {
        const info = (h as { info?: DblpInfo }).info;
        return info ? fromDblp(info) : null;
      })
      .filter((r): r is WorkRecord => r !== null);
  });
}

// SPARQL fallback. dblp's search API sits behind a bot wall (Anubis) since November 2026;
// its SPARQL service (QLever) is not walled and holds the same records.

const SPARQL_ACCEPT = 'application/sparql-results+json';
const PREFIXES =
  'PREFIX dblp: <https://dblp.org/rdf/schema#> ' +
  'PREFIX ql: <http://qlever.cs.uni-freiburg.de/builtin-functions/> ';
/**
 * Rows of a word search. Without ORDER BY they come in no particular order, and a title
 * of common words ("Long Short-Term Memory") matches thousands; sorted by how close the
 * title's length is to the one asked for, the work itself comes first.
 */
const WORD_SEARCH_LIMIT = 100;
/** Words of the first word search, and of the retry when it finds nothing. */
const FIRST_WORDS = 6;
const RETRY_WORDS = 3;
/** A candidate below this title similarity is not worth a second request. */
const MIN_SIMILARITY = 0.5;

/**
 * Words that say little about a title. Words under 3 letters are dropped anyway. Every
 * word sent must be in the title, so leaving these out also leaves out a chance to miss.
 */
const STOP_WORDS = new Set(
  (
    'the and for with from into onto upon via its are was were has have had this that these ' +
    'those their our your his her not but nor than then there here which who whom whose ' +
    'what when where why how can may might will shall should would could does did been ' +
    'being about over under between through toward towards using based'
  ).split(' '),
);

/**
 * The words to search for, most distinctive (longest) first. QLever matches whole words,
 * split at anything that is not a letter or digit ("amazon's" is "amazon" and "s",
 * "key-value" is "key" and "value"), case-insensitively, but it does not fold accents:
 * "gödel" and "godel" are different words. A word with a letter outside ASCII is left
 * out, because the entry and dblp may spell it differently.
 */
export function sparqlWords(title: string): string[] {
  const words = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && /^[a-z0-9]+$/.test(w) && !STOP_WORDS.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

interface Binding {
  type: string;
  value: string;
}
type Row = Record<string, Binding | undefined>;

async function sparql(client: HttpClient, query: string): Promise<Row[]> {
  const url = `${SPARQL_URL}?${new URLSearchParams({ query: PREFIXES + query })}`;
  const { data } = await getJson<Record<string, unknown>>(client, url, SPARQL_ACCEPT, {
    'User-Agent': 'overfull (github.com/Amet13/overfull)',
  });
  if (!data) throw new SourceUnavailableError(SPARQL_HOST, `${SPARQL_HOST} answered HTTP 404`);
  return readAnswer(SPARQL_HOST, () => {
    const results = data.results;
    if (!isObject(results)) throw unexpectedData(SPARQL_HOST);
    return listIn(SPARQL_HOST, results.bindings).map((row) => {
      if (!isObject(row)) throw unexpectedData(SPARQL_HOST);
      return row as Row;
    });
  });
}

/** A string for inside a SPARQL "…" literal (the words are [a-z0-9]; this is a safeguard). */
function literal(s: string): string {
  return s.replace(/[\\"]/g, '');
}

/**
 * Publications whose title has all `words`, closest to `length` characters first:
 * [publication IRI, title].
 */
async function wordSearch(
  client: HttpClient,
  words: string[],
  length: number,
): Promise<[string, string][]> {
  const rows = await sparql(
    client,
    'SELECT ?p ?t WHERE { ?p dblp:title ?t . ?text ql:contains-entity ?t . ' +
      `?text ql:contains-word "${literal(words.join(' '))}" } ` +
      `ORDER BY ASC(ABS(STRLEN(?t) - ${length})) LIMIT ${WORD_SEARCH_LIMIT}`,
  );
  return rows.flatMap((r) => (r.p?.value && r.t?.value ? [[r.p.value, r.t.value]] : []));
}

/** dblp's record classes, as the search API names them in `type`. */
const TYPE_NAMES: [string, string][] = [
  ['Withdrawn', 'Withdrawn Items'],
  ['Informal', 'Informal and Other Publications'],
  ['Article', 'Journal Articles'],
  ['Inproceedings', 'Conference and Workshop Papers'],
  ['Incollection', 'Parts in Books or Collections'],
  ['Book', 'Books and Theses'],
  ['Editorship', 'Editorship'],
  ['Reference', 'Reference Works'],
  ['Data', 'Data and Artifacts'],
];
const SCHEMA = 'https://dblp.org/rdf/schema#';

interface Details {
  title?: string;
  years: Set<number>;
  venues: Set<string>;
  dois: Set<string>;
  ees: Set<string>;
  classes: Set<string>;
  authors: Map<number, string>;
}

/** Records for the given publication IRIs, in the order given. */
async function details(client: HttpClient, iris: string[]): Promise<WorkRecord[]> {
  const values = iris.map((iri) => `<${iri.replace(/[<>"\s]/g, '')}>`).join(' ');
  const rows = await sparql(
    client,
    `SELECT ?p ?title ?year ?venue ?doi ?ee ?class ?o ?n WHERE { VALUES ?p { ${values} } ` +
      '?p dblp:title ?title . ' +
      'OPTIONAL { ?p dblp:yearOfPublication ?year } OPTIONAL { ?p dblp:publishedIn ?venue } ' +
      'OPTIONAL { ?p dblp:doi ?doi } OPTIONAL { ?p dblp:primaryDocumentPage ?ee } ' +
      'OPTIONAL { ?p a ?class } ' +
      'OPTIONAL { ?p dblp:hasSignature ?s . ?s dblp:signatureOrdinal ?o ; dblp:signatureDblpName ?n } }',
  );
  // One row per combination of values (one per author at least): gather them per record.
  const byIri = new Map<string, Details>();
  for (const r of rows) {
    const iri = r.p?.value;
    if (!iri) continue;
    let d = byIri.get(iri);
    if (!d) {
      d = {
        years: new Set(),
        venues: new Set(),
        dois: new Set(),
        ees: new Set(),
        classes: new Set(),
        authors: new Map(),
      };
      byIri.set(iri, d);
    }
    d.title ??= r.title?.value;
    const year = Number(r.year?.value);
    if (Number.isInteger(year)) d.years.add(year);
    if (r.venue?.value) d.venues.add(r.venue.value);
    if (r.doi?.value) d.dois.add(r.doi.value);
    if (r.ee?.value) d.ees.add(r.ee.value);
    if (r.class?.value.startsWith(SCHEMA)) d.classes.add(r.class.value.slice(SCHEMA.length));
    const ordinal = Number(r.o?.value);
    if (Number.isInteger(ordinal) && r.n?.value) d.authors.set(ordinal, r.n.value);
  }
  return iris.flatMap((iri) => {
    const d = byIri.get(iri);
    const record = d ? fromSparql(iri, d) : null;
    return record ? [record] : [];
  });
}

/** The first of a set in sorted order, so a record does not depend on row order. */
function first(values: Set<string>): string | undefined {
  return [...values].sort()[0];
}

function fromSparql(iri: string, d: Details): WorkRecord | null {
  const doi = first(d.dois)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  // The search API's `ee` is the first electronic edition, usually the DOI link.
  const doiLink = [...d.ees].find((ee) => /^https?:\/\/(?:dx\.)?doi\.org\//i.test(ee));
  const year = [...d.years].sort()[0];
  const info: DblpInfo = {
    authors: {
      author: [...d.authors.entries()].sort(([a], [b]) => a - b).map(([, text]) => ({ text })),
    },
    url: iri,
  };
  if (d.title) info.title = d.title;
  if (year !== undefined) info.year = String(year);
  const venue = first(d.venues);
  if (venue) info.venue = venue;
  if (doi) info.doi = doi;
  const ee = doiLink ?? first(d.ees);
  if (ee) info.ee = ee;
  const type = TYPE_NAMES.find(([cls]) => d.classes.has(cls))?.[1];
  if (type) info.type = type;
  return fromDblp(info);
}

/**
 * Title search through SPARQL, in two steps: a word search for candidate titles (fast),
 * then the details of the best few. One query that does both took about 28 s.
 */
async function sparqlSearch(client: HttpClient, title: string): Promise<WorkRecord[]> {
  const words = sparqlWords(title);
  if (!words.length) return [];
  // dblp's titles end with a full stop.
  const length = title.trim().length + 1;
  let hits = await wordSearch(client, words.slice(0, FIRST_WORDS), length);
  // One word spelled differently from dblp's ("modelling") finds nothing: try again with
  // the three most distinctive words alone.
  if (!hits.length && words.length > RETRY_WORDS) {
    hits = await wordSearch(client, words.slice(0, RETRY_WORDS), length);
  }
  const best = [...new Map(hits).entries()]
    .map(([iri, t]) => ({ iri, sim: titleSimilarity(title, t) }))
    .filter((c) => c.sim >= MIN_SIMILARITY)
    .sort((a, b) => b.sim - a.sim || a.iri.localeCompare(b.iri))
    .slice(0, MAX_HITS);
  if (!best.length) return [];
  return details(
    client,
    best.map((c) => c.iri),
  );
}

/**
 * dblp publication search; up to 5 candidates. The search API is asked first; when it
 * cannot answer (a bot wall, or down), dblp's SPARQL service is asked instead. A bot wall
 * takes the search API out for the rest of the run (`getJson`), so later titles go
 * straight to SPARQL.
 */
export async function dblpSearch(client: HttpClient, title: string): Promise<WorkRecord[]> {
  const down = client.downReason(SEARCH_HOST);
  if (down) return fallback(client, title, down);
  try {
    return await searchApi(client, title);
  } catch (err) {
    if (!(err instanceof SourceUnavailableError) || err.host !== SEARCH_HOST) throw err;
    return fallback(client, title, err.message);
  }
}

async function fallback(client: HttpClient, title: string, why: string): Promise<WorkRecord[]> {
  try {
    return await sparqlSearch(client, title);
  } catch (err) {
    if (!(err instanceof SourceUnavailableError)) throw err;
    throw new SourceUnavailableError(SPARQL_HOST, `${why}; ${err.message}`);
  }
}
