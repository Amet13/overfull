/**
 * Errors in typeset bibliography entries: LaTeX reports them at the `.bbl` line
 * (BibTeX) or at a `.tex` line near `\printbibliography` (biblatex), where the
 * author cannot fix anything. `attributeBibliography` points them at the `.bib`
 * entry instead. Browser-safe.
 */

import { parseBib } from '../bib/parse.js';
import type { Problem } from '../types.js';
import { grepTex } from '../venue/tex.js';
import type { TexFile } from '../venue/types.js';

export interface BibliographySources {
  /** The `.bbl` LaTeX read: project-relative path and text. */
  bbl?: { path: string; text: string };
  /** The project's `.bib` files. */
  bibs: { file: string; text: string }[];
  /**
   * The project's `.tex` sources, to find where the bibliography is printed. An error
   * reported at a `.tex` line (biblatex) is matched to an entry only at or after that
   * place; without the sources only errors at a `.bbl` line are attributed.
   */
  texFiles?: TexFile[];
}

interface BblEntry {
  key: string;
  line: number;
  offset: number;
}

/** Entries in the order of the file; line numbers are counted in one pass. */
function bblEntries(text: string): BblEntry[] {
  const out: BblEntry[] = [];
  // Bounded repeats: an unclosed `[` or `{` must not make the scan quadratic. The
  // whitespace after the optional `[…]` belongs to it, so a run of spaces before a
  // missing `{` has only one way to match.
  const re =
    /\\(?:bibitem\s*(?:\[[^\]]{0,2000}\]\s*)?\{([^}]{1,1000})\}|entry\s*\{([^}]{1,1000})\})/g;
  let pos = 0;
  let line = 1;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const key = (m[1] ?? m[2] ?? '').trim();
    if (!key) continue;
    for (; pos < m.index; pos++) if (text.charCodeAt(pos) === 10) line++;
    out.push({ key, offset: m.index, line });
  }
  return out;
}

/** The last entry whose `field` is at most `value` (entries are sorted by it), by bisection. */
function lastAtOrBefore(
  entries: BblEntry[],
  field: 'line' | 'offset',
  value: number,
): BblEntry | undefined {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((entries[mid] as BblEntry)[field] <= value) lo = mid + 1;
    else hi = mid;
  }
  return entries[lo - 1];
}

/** Where the bibliography is printed in the sources. */
const PRINTED =
  /\\(?:printbibliography|bibliography\s*\{|begin\s*\{thebibliography\}|printbibheading)(?![A-Za-z@])/;

/** The text TeX showed as the offending argument (`<argument> Speedups in R&`). */
function argumentSnippet(evidence: string | undefined): string | undefined {
  const m = /^<argument> (.+)$/m.exec(evidence ?? '');
  const text = m?.[1]?.replace(/[&_^#$%\\]+\s*$/, '').trim();
  return text && text.length >= 8 ? text : undefined;
}

const sameFile = (a: string, b: string) =>
  a.replace(/^\.\//, '') === b.replace(/^\.\//, '') || a.split('/').pop() === b.split('/').pop();

/**
 * Returns problems whose cause is a bibliography entry rewritten to point at the
 * `.bib` entry: `location` = the entry in its .bib file, `data.bibKey`, and the
 * message says "in the bibliography entry `<key>`". Other problems are returned
 * unchanged.
 */
export function attributeBibliography(problems: Problem[], src: BibliographySources): Problem[] {
  if (!src.bbl) return problems;
  const entries = bblEntries(src.bbl.text);
  if (!entries.length) return problems;
  let bibIndex: Map<string, { file: string; line: number }> | undefined;
  const bibLocation = (key: string) => {
    if (!bibIndex) {
      bibIndex = new Map();
      for (const b of src.bibs) {
        for (const e of parseBib(b.text)) {
          if (!bibIndex.has(e.key)) bibIndex.set(e.key, { file: b.file, line: e.line });
        }
      }
    }
    return bibIndex.get(key);
  };
  let printed: { file: string; line: number }[] | undefined;
  /** True when `loc` is at or after a place that prints the bibliography, in that file. */
  const inBibliography = (loc: { file: string; line: number }) => {
    printed ??= src.texFiles ? grepTex(src.texFiles, PRINTED) : [];
    return printed.some((at) => sameFile(at.file, loc.file) && loc.line >= at.line);
  };
  return problems.map((p) => {
    if (p.data?.bibKey) return p;
    let key: string | undefined;
    const loc = p.location;
    if (loc?.file && loc.line && sameFile(loc.file, src.bbl?.path ?? '')) {
      key = lastAtOrBefore(entries, 'line', loc.line)?.key;
    } else if (loc?.file && loc.line && inBibliography({ file: loc.file, line: loc.line })) {
      // biblatex typesets the entries at \printbibliography, so TeX reports that line;
      // the argument TeX showed finds the entry. Errors elsewhere are left alone, even when
      // their text also appears in the .bbl.
      const snippet = argumentSnippet(p.evidence);
      const at = snippet ? (src.bbl?.text.indexOf(snippet) ?? -1) : -1;
      if (at >= 0) key = lastAtOrBefore(entries, 'offset', at)?.key;
    }
    if (!key) return p;
    const where = bibLocation(key);
    return {
      ...p,
      message: `${p.message} in the bibliography entry \`${key}\``,
      ...(where ? { location: { file: where.file, line: where.line } } : {}),
      data: { ...(p.data ?? {}), bibKey: key, ...(loc ? { reportedAt: loc } : {}) },
    };
  });
}
