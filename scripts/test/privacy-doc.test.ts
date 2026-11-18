/**
 * docs/guide/references.md "What leaves your machine" is the one list of outside services
 * and what each receives. This test fails when a request host is added to the reference
 * sources (or the browser check asks another source) and the list does not name it, and
 * when the list names a host the code no longer asks.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(repo, p), 'utf8');
const refs = 'packages/core/src/refs';

/** Hosts that appear in the sources only as links written into records, never asked. */
const LINK_ONLY: Record<string, string> = {
  'arxiv.org': 'the abs/ link of an arXiv record',
  'europepmc.org': 'the article link of a Europe PMC record',
  'www.semanticscholar.org': 'the paper link of a Semantic Scholar record',
};

/** The host each source id (`RefSource` in types.ts) sends its requests to. */
const SOURCE_HOST: Record<string, string> = {
  'doi.org': 'doi.org',
  crossref: 'api.crossref.org',
  dblp: 'dblp.org',
  arxiv: 'export.arxiv.org',
  openalex: 'api.openalex.org',
  semanticscholar: 'api.semanticscholar.org',
  acl: 'aclanthology.org',
  europepmc: 'www.ebi.ac.uk',
};

/** `https://<host>` in code (comments skipped); `${HOST}` resolves to the file's HOST. */
function hostsInCode(file: string): string[] {
  const text = read(file);
  const constHost = /const HOST = '([^']+)'/.exec(text)?.[1];
  const hosts: string[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
    for (const m of t.matchAll(/https:\/\/(\$\{HOST\}|[a-z0-9.-]+)/g)) {
      const host = m[1]?.startsWith('$') ? constHost : m[1];
      if (!host) throw new Error(`${file}: \${HOST} without a HOST constant`);
      hosts.push(host);
    }
  }
  return hosts;
}

function codeHosts(): Set<string> {
  const files = [
    ...readdirSync(join(repo, refs))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `${refs}/${f}`),
    ...readdirSync(join(repo, refs, 'sources'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `${refs}/sources/${f}`),
  ];
  return new Set(files.flatMap(hostsInCode).filter((h) => !(h in LINK_ONLY)));
}

/** The backticked hosts in the second column of the table after `intro` in the section. */
function docTable(intro: RegExp): Set<string> {
  const doc = read('docs/guide/references.md');
  const section = doc.split(/^## What leaves your machine$/m)[1]?.split(/^## /m)[0];
  if (!section) throw new Error('references.md has no "What leaves your machine" section');
  const at = section.search(intro);
  if (at < 0) throw new Error(`no table after ${intro}`);
  // Only the first table after the intro: it ends at the first line that is not a row.
  const lines = section.slice(at).split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  const end = lines.findIndex((l, i) => i > first && !l.startsWith('|'));
  return new Set(
    lines
      .slice(first + 2, end)
      .map((l) => /^\|[^|]*\|\s*`([^`]+)`/.exec(l)?.[1])
      .filter((h): h is string => Boolean(h)),
  );
}

describe('What leaves your machine (references.md)', () => {
  it('maps every reference source to a host', () => {
    const union = /export type RefSource =([^;]+);/.exec(read(`${refs}/types.ts`))?.[1] ?? '';
    const ids = [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    expect(ids.filter((id) => !((id as string) in SOURCE_HOST))).toEqual([]);
  });

  it('lists every host the command line asks, and no other', () => {
    const inCode = codeHosts();
    for (const h of Object.values(SOURCE_HOST)) expect(inCode).toContain(h);
    const listed = docTable(/^Command line, Action and MCP server:/m);
    expect([...inCode].filter((h) => !listed.has(h)).sort()).toEqual([]);
    expect([...listed].filter((h) => !inCode.has(h)).sort()).toEqual([]);
  });

  it('lists exactly the hosts the browser check asks', () => {
    const check = read('site/src/scripts/pipeline.ts');
    const list = /sources:\s*\[([^\]]*)\]/.exec(check)?.[1];
    expect(list, 'site/src/scripts/pipeline.ts passes no sources list').toBeTruthy();
    const asked = new Set(
      [...(list as string).matchAll(/'([^']+)'/g)].map((m) => SOURCE_HOST[m[1] as string]),
    );
    expect(asked.has(undefined as unknown as string)).toBe(false);
    const listed = docTable(/^The browser check on the website/m);
    expect([...listed].sort()).toEqual([...asked].sort());
  });

  it('is linked from the pages that talk about data sent online', () => {
    const pages = [
      'SECURITY.md',
      'docs/guide/faq.md',
      'docs/guide/checks.md',
      'docs/guide/config.md',
      'docs/guide/cli.md',
    ];
    const missing = pages.filter(
      (p) => !read(p).includes('references.md#what-leaves-your-machine'),
    );
    expect(missing).toEqual([]);
  });
});
