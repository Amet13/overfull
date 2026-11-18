/**
 * Tools run from the absolute path `which` found, never by bare name: on Windows a
 * bare name is looked up in the current directory (the project) first, so a planted
 * `docker.exe` or `pdffonts.exe` would run. spawn is replaced to record what starts.
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { tempDir } from './helpers.js';

const spawned: { file: string; args: string[]; shell: boolean }[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return {
    ...real,
    spawn: (file: string, args: string[], opts: { shell?: boolean }) => {
      spawned.push({ file, args, shell: opts.shell === true });
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => void;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      setTimeout(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 1, null);
      }, 1);
      return child;
    },
  };
});

const { dockerAvailable, dockerImagePresent, dockerImageStatus, resolveCommand, run, which } =
  await import('../src/tools.js');
const { readPdfFacts } = await import('../src/pdf.js');
const { runVeraPdf } = await import('../src/verapdf.js');

const savedPath = process.env.PATH;
let bin: string;
let project: string;
beforeEach(() => {
  spawned.length = 0;
  bin = tempDir();
  project = tempDir();
  for (const tool of ['docker', 'pdffonts', 'verapdf']) {
    writeFileSync(join(bin, tool), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, tool), 0o755);
    // The planted copies in the project must never be what runs.
    writeFileSync(join(project, tool), '#!/bin/sh\nexit 1\n');
    chmodSync(join(project, tool), 0o755);
  }
  process.env.PATH = bin;
});
afterEach(() => {
  process.env.PATH = savedPath;
});

const pdf = new URL('./fixtures/project/thesis.pdf', import.meta.url).pathname;

describe('tools run by absolute path', () => {
  it.skipIf(process.platform === 'win32')(
    'docker, pdffonts and verapdf start from the PATH directory',
    async () => {
      await dockerAvailable(process.env);
      await dockerImagePresent('img');
      await dockerImageStatus('img');
      await readPdfFacts(pdf);
      await runVeraPdf(pdf, process.env);
      // Without pdffonts and veraPDF on PATH, the Docker fallbacks run docker by path too.
      process.env.PATH = join(bin, 'docker-only');
      mkdirSync(process.env.PATH);
      writeFileSync(join(process.env.PATH, 'docker'), '#!/bin/sh\n');
      chmodSync(join(process.env.PATH, 'docker'), 0o755);
      await readPdfFacts(pdf, { docker: { image: 'img', root: project } });
      await runVeraPdf(pdf, process.env, { docker: { image: 'img', root: project } });
      expect(spawned.length).toBeGreaterThanOrEqual(7);
      for (const s of spawned) {
        expect(isAbsolute(s.file), s.file).toBe(true);
        expect(s.file.startsWith(project), s.file).toBe(false);
      }
      expect(spawned.map((s) => s.file.split(/[\\/]/).pop())).toEqual(
        expect.arrayContaining(['docker', 'pdffonts', 'verapdf']),
      );
    },
  );

  it('run() starts nothing when a bare name is not on PATH', async () => {
    process.env.PATH = tempDir();
    const r = await run('docker', ['info'], { cwd: project });
    expect(r.code).toBe(127);
    expect(r.error).toMatch(/not found on PATH/);
    expect(spawned).toEqual([]);
  });

  it('resolveCommand keeps paths, resolves names, and ignores relative PATH entries', () => {
    expect(resolveCommand('/opt/x/tool')).toBe('/opt/x/tool');
    // Windows finds only names with an executable extension (PATHEXT).
    const exe = process.platform === 'win32' ? 'docker.EXE' : 'docker';
    if (process.platform === 'win32') writeFileSync(join(bin, exe), '');
    expect(resolveCommand('docker', { PATH: bin })).toBe(join(bin, exe));
    expect(which('docker', { PATH: `.${process.platform === 'win32' ? ';' : ':'}bin` })).toBe(
      undefined,
    );
  });

  it('which() never returns a relative PATH entry, on POSIX or win32', () => {
    // A truly relative entry: a folder under the current directory. (path.relative
    // from the checkout to the temp folder is absolute on Windows when the two are on
    // different drives, as on GitHub's runners.)
    const local = mkdtempSync(join(process.cwd(), '.tool-paths-'));
    onTestFinished(() => rmSync(local, { recursive: true, force: true }));
    writeFileSync(join(local, 'pdffonts.EXE'), '');
    writeFileSync(join(bin, 'pdffonts.EXE'), '');
    const rel = relative(process.cwd(), local);
    expect(isAbsolute(rel)).toBe(false);
    expect(which('pdffonts', { PATH: rel })).toBeUndefined();
    expect(
      which('pdffonts', { PATH: rel, PATHEXT: '.EXE' }, { platform: 'win32' }),
    ).toBeUndefined();
    expect(
      which('pdffonts', { PATH: `${rel};${bin}`, PATHEXT: '.EXE' }, { platform: 'win32' }),
    ).toBe(join(bin, 'pdffonts.EXE'));
  });
});
