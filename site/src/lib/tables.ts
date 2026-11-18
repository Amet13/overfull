/**
 * Wraps each table of a rendered guide page in a focusable, labelled region,
 * so a table wider than the column scrolls sideways with the keyboard as well
 * as with a pointer (axe: scrollable-region-focusable). The table keeps its
 * own semantics: only the wrapper scrolls (see `.table-scroll` in global.css).
 *
 * The rendered HTML is transformed, like `rewriteDocLinks`: Astro's default
 * Markdown processor takes no rehype plugins without an extra package. Tables
 * in Markdown output are never nested.
 *
 * The label names the section the table is in ("Table: Options"); a second
 * table in one section gets a number, so every region has its own name.
 */

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&');
const attr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function wrapTables(html: string): string {
  const seen = new Map<string, number>();
  let heading = '';
  return html.replace(
    /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<table\b[\s\S]*?<\/table>/g,
    (all: string, tag: string | undefined, inner: string | undefined) => {
      if (tag) {
        heading = decode((inner ?? '').replace(/<[^>]*>/g, ''))
          .replace(/\s+/g, ' ')
          .trim();
        return all;
      }
      const base = heading ? `Table: ${heading}` : 'Table';
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const label = n === 1 ? base : `${base} (${n})`;
      return `<div class="table-scroll" role="region" tabindex="0" aria-label="${attr(label)}">${all}</div>`;
    },
  );
}
