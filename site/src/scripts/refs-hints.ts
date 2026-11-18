/**
 * The browser check asks fewer indexes than `overfull check`: arXiv and dblp
 * send no CORS headers, so a page cannot ask them. When an entry that already
 * has a DOI or arXiv id could not be confirmed here, "add the DOI" is the wrong
 * advice; this points to the CLI instead.
 */
import { type BibEntry, type CheckResult, identifiersOf } from '@overfull/core';

const ADD_ID = /add (?:a|the) DOI/i;

export function browserRefHints(check: CheckResult, entries: BibEntry[]): void {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const p of check.problems) {
    if (p.rule !== 'reference-lookup-failed' && p.rule !== 'reference-unverifiable') continue;
    if (!p.fix || !ADD_ID.test(p.fix)) continue;
    const key = typeof p.data?.key === 'string' ? p.data.key : undefined;
    const entry = key ? byKey.get(key) : undefined;
    if (!entry) continue;
    const ids = identifiersOf(entry);
    if (ids.arxivId && !ids.doi)
      p.fix =
        'The entry already has an arXiv id, but the browser cannot reach arXiv; run `overfull check`, which asks arXiv directly.';
    else if (ids.doi)
      p.fix =
        'The entry already has a DOI, but the browser could not confirm it; run `overfull check`, which asks more indexes.';
  }
}
