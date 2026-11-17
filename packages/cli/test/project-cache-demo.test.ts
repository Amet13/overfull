/**
 * Audit demo (P0-6): a project ships `references.cache: project` and a planted
 * `.overfull/cache/refs.json` that "resolves" a made-up DOI. The check must still fail.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/check.js';
import { main } from '../src/main.js';
import { memIo, tempDir } from './helpers.js';

const DOI = '10.5555/overfull.fabricated.2024';
const TITLE = 'Quantum gradient folding for self-verifying citation graphs';

function plantedProject(): string {
  const dir = tempDir();
  writeFileSync(join(dir, 'overfull.yml'), 'bib: [refs.bib]\nreferences:\n  cache: project\n');
  writeFileSync(
    join(dir, 'refs.bib'),
    `@article{fake, title = {${TITLE}}, author = {Doe, Jane}, journal = {Journal of Results},\n  year = {2024}, doi = {${DOI}}}\n`,
  );
  mkdirSync(join(dir, '.overfull', 'cache'), { recursive: true });
  writeFileSync(
    join(dir, '.overfull', 'cache', 'refs.json'),
    JSON.stringify({
      [`doi:${DOI}`]: {
        kind: 'found',
        record: {
          source: 'doi.org',
          title: TITLE,
          authors: [{ family: 'Doe', given: 'Jane' }],
          years: [2024],
          venue: 'Journal of Results',
          doi: DOI,
          type: 'journal-article',
        },
        cachedAt: Date.now(),
      },
    }),
  );
  return dir;
}

/** The real world: doi.org has never heard of the DOI, and no index has the title. */
const nothingFound = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('api.crossref.org'))
    return new Response(JSON.stringify({ status: 'ok', message: { items: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

describe('P0-6: a project cannot vouch for its own references', () => {
  it('fake DOI + planted cache + references.cache: project in overfull.yml: fails', async () => {
    const dir = plantedProject();
    const report = await runCheck({
      cwd: dir,
      checks: ['references'],
      fetch: nothingFound,
      env: { PATH: process.env.PATH },
    });
    const refs = report.checks.find((c) => c.check === 'references');
    expect(refs?.stats?.verified).toBe(0);
    expect(refs?.status).toBe('fail');
    expect(refs?.problems.map((p) => p.rule)).toContain('refs-cache-ignored');
  });

  it('the CLI exits 1 and prints the notice', async () => {
    const io = memIo(plantedProject());
    io.fetch = nothingFound;
    const code = await main(['check', '--checks', 'references', '--json'], io);
    expect(code).toBe(1);
    expect(io.stdoutText()).toContain('refs-cache-ignored');
  });

  it('the user can still opt in with --project-cache (outside CI)', async () => {
    const io = memIo(plantedProject());
    io.fetch = nothingFound;
    const code = await main(['check', '--checks', 'references', '--project-cache', '--json'], io);
    expect(code).toBe(0);
  });
});
