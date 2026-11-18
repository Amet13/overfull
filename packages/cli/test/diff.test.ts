import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { memIo, tempDir } from './helpers.js';

/** Shell-script fakes on PATH do not exist on Windows. */
const POSIX_ONLY = process.platform === 'win32';
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

/** latexdiff-vc and latexmk fakes that record the revision and write a complete PDF. */
function fakeTools(): string {
  const dir = tempDir();
  const scripts: Record<string, string> = {
    'latexdiff-vc':
      'sha=""; while [ $# -gt 0 ]; do if [ "$1" = -r ]; then sha="$2"; fi; shift; done\necho "$sha" > .revision\necho x > "main-diff$sha.tex"',
    latexmk: 'mkdir -p .overfull/diff; echo pdf > .overfull/diff/overfull-diff.pdf',
  };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

function repo(): { dir: string; git: (...args: string[]) => string } {
  const dir = tempDir();
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.org',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.org',
      },
    })
      .toString()
      .trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}\n1');
  git('add', '-A');
  git('commit', '-qm', 'one');
  return { dir, git };
}

describe('overfull diff', () => {
  it.skipIf(POSIX_ONLY)(
    'in a fresh project (one commit) compares uncommitted changes with HEAD',
    async () => {
      process.env.PATH = `${fakeTools()}:${savedPath}`;
      const { dir, git } = repo();
      writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}\n2');
      const io = memIo(dir, { PATH: process.env.PATH });
      expect(await main(['diff', '--engine', 'local'], io)).toBe(0);
      expect(io.stderrText()).toContain('comparing your uncommitted changes with HEAD');
      expect(io.stdoutText()).toBe('overfull-diff.pdf\n');
      const head = git('rev-parse', '--short', 'HEAD');
      expect(readFileSync(join(dir, '.revision'), 'utf8').trim()).toBe(head);
    },
  );

  it.skipIf(POSIX_ONLY)('with one commit and nothing changed names --base HEAD', async () => {
    process.env.PATH = `${fakeTools()}:${savedPath}`;
    const { dir } = repo();
    const io = memIo(dir, { PATH: process.env.PATH });
    expect(await main(['diff', '--engine', 'local'], io)).toBe(2);
    expect(io.stderrText()).toContain('`overfull diff --base HEAD`');
  });

  it.skipIf(POSIX_ONLY)('runs from a subfolder, in the folder of overfull.yml', async () => {
    process.env.PATH = `${fakeTools()}:${savedPath}`;
    const { dir } = repo();
    writeFileSync(join(dir, 'overfull.yml'), 'main: main.tex\n');
    mkdirSync(join(dir, 'sections'));
    writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}\n3');
    const io = memIo(join(dir, 'sections'), { PATH: process.env.PATH });
    expect(await main(['diff', '--engine', 'local', '--json'], io)).toBe(0);
    expect(io.stderrText()).toContain('Using ../overfull.yml.');
    expect(JSON.parse(io.stdoutText())).toMatchObject({ pdf: '../overfull-diff.pdf' });
    expect(existsSync(join(dir, 'overfull-diff.pdf'))).toBe(true);
  });

  it('validates --engine like build and check', async () => {
    const io = memIo(tempDir());
    expect(await main(['diff', '--engine', 'podman'], io)).toBe(2);
    expect(io.stderrText()).toContain('--engine must be auto, local or docker, got "podman"');
  });
});
