/** Write paths stay inside the project, also through symlinks. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { citeCommand } from '../src/commands/cite.js';
import { main } from '../src/main.js';
import { insideRootForWrite, reportTarget, writeReport } from '../src/safety.js';
import { memIo, tempCopy, tempDir } from './helpers.js';

/** Shell-script fakes on PATH and FIFOs do not exist on Windows; these tests run on Linux and macOS. */
const POSIX_ONLY = process.platform === 'win32';

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

// --- R5: writes stay inside the project -----------------------------------------

describe('R5: write paths through symlinks', () => {
  function project() {
    const outside = tempDir();
    const dir = tempDir();
    symlinkSync(outside, join(dir, 'link'));
    symlinkSync(join(outside, 'nope', 'new.bib'), join(dir, 'dangling.bib'));
    return { outside, dir };
  }

  it('insideRootForWrite refuses symlinked parents and dangling links', () => {
    const { dir } = project();
    expect(() => insideRootForWrite(dir, 'link/new.bib', 'Bibliography file')).toThrow(
      /through a symlink/,
    );
    expect(() => insideRootForWrite(dir, 'link/a/b/c.pdf', 'Output PDF')).toThrow(/symlink/);
    expect(() => insideRootForWrite(dir, 'dangling.bib', 'Bibliography file')).toThrow(
      /dangling symlink/,
    );
    expect(insideRootForWrite(dir, 'sub/new.bib', 'Bibliography file')).toBe(
      join(dir, 'sub', 'new.bib'),
    );
  });

  it('cite --bib does not create a file outside through a symlinked dir', async () => {
    const { outside, dir } = project();
    const lookup = async () => ({
      entry: {
        key: 'k',
        type: 'misc',
        line: 0,
        raw: '',
        fields: { title: 'T', doi: '10.1/x' },
      },
      source: 'doi.org',
      confidence: 1,
    });
    for (const bib of ['link/new.bib', 'dangling.bib']) {
      const io = memIo(dir);
      await expect(citeCommand(['10.1/x', '--bib', bib], io, lookup)).rejects.toThrow(/symlink/);
    }
    expect(existsSync(join(outside, 'new.bib'))).toBe(false);
    expect(existsSync(join(outside, 'nope'))).toBe(false);
  });

  it('pages --out and init refuse a symlinked target', async () => {
    const { outside, dir } = project();
    execFileSync('cp', [join(tempCopy('project'), 'thesis.pdf'), join(dir, 'main.pdf')]);
    const io = memIo(dir);
    expect(await main(['pages', '1', '--out', 'link/png'], io)).toBe(2);
    expect(io.stderrText()).toContain('symlink');
    const io2 = memIo(dir);
    expect(await main(['init', 'paper', 'link', '--no-git'], io2)).toBe(2);
    expect(await main(['init', 'paper', 'link/x', '--no-git'], memIo(dir))).toBe(2);
    expect(existsSync(join(outside, 'png'))).toBe(false);
    expect(existsSync(join(outside, 'main.tex'))).toBe(false);
    expect(existsSync(join(outside, 'x'))).toBe(false);
  });

  it.skipIf(POSIX_ONLY)('diff --out refuses a symlinked directory', async () => {
    const { dir } = project();
    expect(() => insideRootForWrite(dir, 'link/diff.pdf', 'Output PDF')).toThrow(/symlink/);
  });
});

describe('check --write and the Action sarif input do not follow symlinks out of the project', () => {
  /** A project with a planted `report.sarif -> <outside>/victim` and `out -> <outside>`. */
  function planted() {
    const outside = tempDir();
    const victim = join(outside, 'victim');
    writeFileSync(victim, 'keep me\n');
    const dir = tempCopy('project');
    symlinkSync(victim, join(dir, 'report.sarif'));
    symlinkSync(outside, join(dir, 'out'));
    symlinkSync(join(dir, 'main.tex'), join(dir, 'inner.json'));
    return { outside, victim, dir };
  }

  it.skipIf(POSIX_ONLY)(
    '--write refuses a symlinked file or folder and writes nothing',
    async () => {
      const { outside, victim, dir } = planted();
      for (const target of ['sarif=report.sarif', 'json=out/report.json', 'json=inner.json']) {
        const io = memIo(dir);
        expect(await main(['check', '--offline', '--write', target], io), target).toBe(2);
        expect(io.stderrText(), target).toMatch(/symlink/);
      }
      // An absolute path into the project gets the same checks.
      const abs = memIo(dir);
      expect(
        await main(['check', '--offline', '--write', `sarif=${join(dir, 'report.sarif')}`], abs),
      ).toBe(2);
      expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
      expect(existsSync(join(outside, 'report.json'))).toBe(false);
      expect(readFileSync(join(dir, 'main.tex'), 'utf8')).not.toContain('"status"');
    },
  );

  it('--write refuses a relative path that leaves the project', async () => {
    const dir = tempCopy('project');
    const io = memIo(dir);
    expect(await main(['check', '--offline', '--write', 'json=../report.json'], io)).toBe(2);
    expect(io.stderrText()).toMatch(/outside the project/);
  });

  it('--write still takes an absolute path outside the project ($GITHUB_STEP_SUMMARY)', async () => {
    const dir = tempCopy('project');
    const elsewhere = join(tempDir(), 'summary.md');
    expect(await main(['check', '--offline', '--write', `markdown=${elsewhere}`], memIo(dir))).toBe(
      1,
    );
    expect(readFileSync(elsewhere, 'utf8')).toContain('Overfull preflight');
  });

  it.skipIf(POSIX_ONLY)(
    'Action sarif: reportTarget refuses the planted link; writeReport never follows one',
    () => {
      const { victim, dir } = planted();
      expect(() => reportTarget(dir, 'report.sarif', 'Input "sarif"')).toThrow(/symlink/);
      expect(() => reportTarget(dir, 'out/x.sarif', 'Input "sarif"')).toThrow(/symlink/);
      expect(reportTarget(dir, 'sub/x.sarif', 'Input "sarif"')).toEqual({
        path: join(dir, 'sub', 'x.sarif'),
        inProject: true,
      });
      // A link that appears after the check is not followed either.
      expect(() =>
        writeReport({ path: join(dir, 'report.sarif'), inProject: true }, 'pwned'),
      ).toThrow(/symlink/);
      expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
      writeReport({ path: join(dir, 'sub', 'x.sarif'), inProject: true }, '{}');
      expect(readFileSync(join(dir, 'sub', 'x.sarif'), 'utf8')).toBe('{}');
    },
  );
});
