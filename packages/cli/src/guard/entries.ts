/**
 * Comparing two versions of a .bib file by their entries, for the guard: an
 * edit that only removes whole entries adds nothing that could be invented.
 */

import { type BibEntry, parseBibWithIssues } from '@overfull/core';

/** Entry text with whitespace and field order removed, so only real changes differ. */
export function canonicalEntry(e: BibEntry): string {
  const ws = (s: string) => s.replace(/\s+/g, ' ').trim();
  const fields = Object.entries(e.fields)
    .map(([k, v]) => `${k}=${ws(v)}`)
    .sort();
  return `${e.type.toLowerCase()}\u0000${e.key}\u0000${fields.join('\u0001')}`;
}

/**
 * True when every entry in `after` is an entry of `before`, unchanged (whitespace
 * and field order aside), and `after` has no more unparsable entries than `before`.
 * So the change can only have removed entries. `@string` macros are expanded into
 * the fields, so changing one changes the entries that use it.
 */
export function onlyRemovesEntries(before: string, after: string): boolean {
  const b = parseBibWithIssues(before);
  const a = parseBibWithIssues(after);
  if (a.issues.length > b.issues.length) return false;
  const left = new Map<string, number>();
  for (const e of b.entries) {
    const k = canonicalEntry(e);
    left.set(k, (left.get(k) ?? 0) + 1);
  }
  for (const e of a.entries) {
    const k = canonicalEntry(e);
    const n = left.get(k) ?? 0;
    if (n === 0) return false;
    left.set(k, n - 1);
  }
  return true;
}
