// What record-sources.mjs records and what the refs-source-*.test.ts and refs-rules-*.test.ts
// files replay: one entry per .bib file, with the verifyEntries options used for it.
// `sources` limits which indexes are asked, so a fallback source can be exercised alone.
// dblp's SPARQL service is recorded only for the cases that name dblp in `sources`; the
// others replay it as unavailable (see fake-fetch.ts).
export const CASES = [
  { file: 'sources-acl.bib', opts: {} },
  { file: 'sources-pubmed.bib', opts: {} },
  { file: 'sources-title.bib', opts: { sources: ['semanticscholar'] } },
  { file: 'sources-title.bib', opts: { sources: ['europepmc'] } },
  { file: 'sources-datacite.bib', opts: {} },
  { file: 'sources-retracted.bib', opts: { checkRetractions: true } },
  { file: 'sources-arxiv-doi.bib', opts: {} },
  // dblp alone: its search API answers with a bot wall (recorded in http.json), so these
  // go through its SPARQL service.
  { file: 'sources-dblp.bib', opts: { sources: ['dblp'] } },
];

export const LOOKUPS = [
  '2020.acl-main.1',
  'https://aclanthology.org/D19-1001/',
  'W12-3903',
  'PMID:19872477',
  'PMC5598109',
  'https://pubmed.ncbi.nlm.nih.gov/22745249/',
];
