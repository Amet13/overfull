import { getEventListeners } from 'node:events';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { changes, watchedState } from '../src/commands/check.js';
import { main } from '../src/main.js';
import { memIo, tempDir } from './helpers.js';

/** Waits for an output condition; only the test timeout bounds the wait. */
const until = (ok: () => boolean) =>
  vi.waitFor(() => expect(ok()).toBe(true), { timeout: 15000, interval: 10 });

const bib = '@article{a, title={A Title Long Enough To Search}, author={Doe, J.}, year={2020}}\n';

describe('check --watch', () => {
  it('watches log, PDF, aux and bib files, and says when a .bib changed', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'main.log'), 'x');
    writeFileSync(join(dir, 'sub', 'refs.bib'), bib);
    writeFileSync(join(dir, 'main.tex'), 'ignored');
    const a = watchedState(dir);
    expect(
      [...a.keys()]
        .map((k) =>
          k
            .slice(dir.length + 1)
            .split('\\')
            .join('/'),
        )
        .sort(),
    ).toEqual(['main.log', 'sub/refs.bib']);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'main.log'), later, later);
    expect(changes(a, watchedState(dir))).toEqual({ any: true, bib: false });
    utimesSync(join(dir, 'sub', 'refs.bib'), later, later);
    expect(changes(a, watchedState(dir))).toEqual({ any: true, bib: true });
    expect(changes(a, a)).toEqual({ any: false, bib: false });
  });

  it('runs once, again after a change, and stops on the signal', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'refs.bib'), bib);
    const io = memIo(dir);
    io.env = { ...io.env, OVERFULL_WATCH_INTERVAL_MS: '20' };
    const stop = new AbortController();
    io.signal = stop.signal;
    const run = main(['check', 'refs.bib', '--offline', '--watch'], io);
    const runs = () => io.stdoutText().split('overfull ').length - 1;
    await until(() => io.stderrText().includes('Watching') && runs() >= 1);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'refs.bib'), later, later);
    await until(() => runs() >= 2);
    stop.abort();
    const code = await run;
    expect([0, 1]).toContain(code);
    expect(runs()).toBeGreaterThanOrEqual(2);
    expect(io.stderrText()).toContain('Watching');
  });

  it('keeps verified references verified when a non-.bib file changes (no new lookups)', async () => {
    const dir = tempDir();
    const cacheHome = tempDir();
    writeFileSync(
      join(dir, 'refs.bib'),
      '@article{lamport1978time, author = {Lamport, Leslie},\n' +
        '  title = {Time, Clocks, and the Ordering of Events in a Distributed System},\n' +
        '  journal = {CACM}, year = {1978}, doi = {10.1145/359545.359563}}\n',
    );
    writeFileSync(join(dir, 'main.aux'), '\\citation{lamport1978time}\n');
    const io = memIo(dir, {
      OVERFULL_WATCH_INTERVAL_MS: '20',
      XDG_CACHE_HOME: cacheHome,
      HOME: cacheHome,
    });
    let calls = 0;
    io.fetch = (async (input: RequestInfo | URL) => {
      calls++;
      const u = new URL(String(input));
      if (u.host === 'doi.org')
        return Response.json({
          DOI: '10.1145/359545.359563',
          type: 'journal-article',
          title: 'Time, clocks, and the ordering of events in a distributed system',
          author: [{ given: 'Leslie', family: 'Lamport' }],
          issued: { 'date-parts': [[1978, 7]] },
        });
      return Response.json({ message: { items: [] } });
    }) as typeof fetch;
    const stop = new AbortController();
    io.signal = stop.signal;
    const run = main(['check', '--checks', 'references', '--bib', 'refs.bib', '--watch'], io);
    await until(() => io.stderrText().includes('Watching'));
    const first = io.stdoutText();
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    // A rebuild touches the .aux, not the .bib.
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, 'main.aux'), later, later);
    await until(() => io.stdoutText().length > first.length * 1.5);
    stop.abort();
    expect(await run).toBe(0);
    const second = io.stdoutText().slice(first.length);
    expect(first).toContain('PASS');
    expect(second).toContain('PASS');
    expect(second).not.toMatch(/offline|not checked/i);
    expect(calls).toBe(callsAfterFirst);
  });

  it('refuses machine formats, and names --html too', async () => {
    const io = memIo(tempDir());
    expect(await main(['check', '--watch', '--json'], io)).toBe(2);
    expect(io.stdoutText()).toContain('--sarif and --html');
    expect(await main(['check', '--watch', '--html'], memIo(tempDir()))).toBe(2);
  });

  it('watches a build folder whose name starts with a dot (build.outDir)', () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.build'));
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.build', 'main.log'), 'x');
    writeFileSync(join(dir, '.git', 'x.log'), 'x');
    const names = (m: Map<string, string>) =>
      [...m.keys()].map((k) =>
        k
          .slice(dir.length + 1)
          .split('\\')
          .join('/'),
      );
    expect(names(watchedState(dir))).toEqual([]);
    expect(names(watchedState(dir, ['.build', '.build', '.']))).toEqual(['.build/main.log']);
  });

  it('check --watch picks up a rebuilt log in a dot outDir and adds no abort listener per tick', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'overfull.yml'), 'main: main.tex\nbuild:\n  outDir: .build\n');
    writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}\n');
    mkdirSync(join(dir, '.build'));
    writeFileSync(join(dir, '.build', 'main.log'), 'This is LuaHBTeX\n');
    const io = memIo(dir, { OVERFULL_WATCH_INTERVAL_MS: '5' });
    const stop = new AbortController();
    io.signal = stop.signal;
    const ticks = vi.spyOn(stop.signal, 'addEventListener');
    const run = main(['check', '--checks', 'build', '--watch'], io);
    const runs = () => io.stdoutText().split('overfull ').length - 1;
    await until(() => runs() >= 1);
    // Many ticks pass (each adds an abort listener while it sleeps); each removes it again.
    const seen = ticks.mock.calls.length;
    await until(() => ticks.mock.calls.length >= seen + 10);
    expect(getEventListeners(stop.signal, 'abort').length).toBeLessThanOrEqual(1);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(dir, '.build', 'main.log'), later, later);
    await until(() => runs() >= 2);
    stop.abort();
    await run;
    expect(runs()).toBeGreaterThanOrEqual(2);
  });
});
