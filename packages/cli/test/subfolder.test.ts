/** Commands run from a subfolder find overfull.yml in the nearest folder above (up to the git root). */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Report } from '@overfull/core';
import { describe, expect, it } from 'vitest';
import { findConfigFile, locateProject } from '../src/config.js';
import { main } from '../src/main.js';
import { memIo, tempCopy, tempDir } from './helpers.js';

const hasPdftoppm = spawnSync('pdftoppm', ['-v']).error === undefined;

function projectWithSections(): { dir: string; sub: string } {
  const dir = tempCopy('project');
  const sub = join(dir, 'sections', 'part');
  mkdirSync(sub, { recursive: true });
  return { dir, sub };
}

describe('upward search for overfull.yml', () => {
  it('finds the nearest overfull.yml or overfull.yaml and stops at the git root', () => {
    const top = tempDir();
    writeFileSync(join(top, 'overfull.yml'), 'main: a.tex\n');
    const repo = join(top, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'a', 'b'), { recursive: true });
    // The git root has no overfull.yml: the one above the repository is not used.
    expect(findConfigFile(join(repo, 'a', 'b'))).toBeUndefined();
    writeFileSync(join(repo, 'overfull.yaml'), 'main: b.tex\n');
    expect(findConfigFile(join(repo, 'a', 'b'))).toBe(join(repo, 'overfull.yaml'));
    const loc = locateProject(join(repo, 'a', 'b'));
    expect(loc.root).toBe(repo);
    expect(loc.above).toBe('../../overfull.yaml');
    expect(loc.rebase('x.tex')).toBe('a/b/x.tex');
    expect(loc.rebase('../../refs.bib')).toBe('refs.bib');
    // An explicit --config keeps the current folder.
    expect(locateProject(join(repo, 'a'), 'other.yml')).toMatchObject({ root: join(repo, 'a') });
    expect(locateProject(repo).above).toBeUndefined();
  });

  it('check from a subfolder checks the project and says which config it uses', async () => {
    const { sub } = projectWithSections();
    const io = memIo(sub);
    const code = await main(['check', '--offline', '--json'], io);
    expect(io.stderrText()).toContain('Using ../../overfull.yml.');
    const report = JSON.parse(io.stdoutText()) as Report;
    expect(report.status).not.toBe('skipped');
    expect(report.target).toBe('thesis.pdf');
    expect(report.checks.find((c) => c.check === 'build')?.status).not.toBe('skipped');
    expect(code).toBe(1);
  });

  it('check from a subfolder reads file arguments relative to that subfolder', async () => {
    const { sub } = projectWithSections();
    const io = memIo(sub);
    await main(['check', '../../references.bib', '--offline', '--json'], io);
    const report = JSON.parse(io.stdoutText()) as Report;
    expect(report.checks.map((c) => c.check)).toEqual(['references']);
    expect(report.checks[0]?.status).not.toBe('skipped');
  });

  it('doctor from a subfolder reports the config above', async () => {
    const { sub } = projectWithSections();
    const io = memIo(sub, { PATH: '/nonexistent' });
    await main(['doctor'], io);
    expect(io.stdoutText()).toMatch(
      /✓ overfull\.yml +valid \(\.\.\/\.\.\/overfull\.yml\) \(main main\.tex/,
    );
  });

  it('cite from a subfolder writes to the bibliography of the project', async () => {
    const { dir, sub } = projectWithSections();
    const io = memIo(sub);
    // No network in tests: the lookup fails, but the message names the file seen from here.
    await main(['cite', '--dry-run', '10.1145/359545.359563'], io);
    expect(io.stderrText()).toContain('Using ../../overfull.yml.');
    expect(existsSync(join(dir, 'references.bib'))).toBe(true);
  });

  it.skipIf(!hasPdftoppm)('pages from a subfolder renders the project PDF', async () => {
    const { dir, sub } = projectWithSections();
    const io = memIo(sub);
    expect(await main(['pages', '1', '--dpi', '20'], io)).toBe(0);
    expect(io.stdoutText()).toBe('../../.overfull/pages/page-1.png\n');
    expect(existsSync(join(dir, '.overfull/pages/page-1.png'))).toBe(true);
  });
});

describe('build: the main file hint', () => {
  it('names no made-up file when there is no document', async () => {
    const io = memIo(tempDir());
    expect(await main(['build'], io)).toBe(2);
    expect(io.stderrText()).toContain('no other LaTeX document found');
    expect(io.stderrText()).toContain('`overfull build <file>.tex`');
    expect(io.stderrText()).not.toContain('thesis.tex');
  });

  it('points at `main:` when the configured main file is missing', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'overfull.yml'), 'main: chapter.tex\n');
    mkdirSync(join(dir, 'sub'));
    const io = memIo(join(dir, 'sub'));
    expect(await main(['build'], io)).toBe(2);
    expect(io.stderrText()).toContain('Using ../overfull.yml.');
    expect(io.stderrText()).toContain('chapter.tex (`main:` in overfull.yml) not found');
  });

  it('lists the candidates when several files could be the main file', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a.tex'), '\\documentclass{article}\n');
    writeFileSync(join(dir, 'b.tex'), '\\documentclass{article}\n');
    const io = memIo(dir);
    expect(await main(['build'], io)).toBe(2);
    expect(io.stderrText()).toContain('a.tex');
    expect(io.stderrText()).toContain('b.tex');
  });

  it('builds one main file at a time', async () => {
    const io = memIo(tempDir());
    expect(await main(['build', 'a.tex', 'b.tex'], io)).toBe(2);
    expect(io.stderrText()).toContain('Build one main file at a time');
  });
});
