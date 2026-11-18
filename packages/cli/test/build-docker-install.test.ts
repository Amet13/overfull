/** `build --engine docker` with an image that installs on demand (the slim image). */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { memIo, tempDir } from './helpers.js';

/** Shell-script fakes on PATH do not exist on Windows; these tests run on Linux and macOS. */
const POSIX_ONLY = process.platform === 'win32';

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

const MISSING_LOG = [
  '(./main.tex',
  "! LaTeX Error: File `chemfig.sty' not found.",
  '',
  'Type X to quit or <RETURN> to proceed,',
  'or enter new name. (Default extension: sty)',
  '',
  'Enter file name: ',
  '! Emergency stop.',
].join('\n');

/**
 * A fake `docker`: the first build (`docker run --rm`) fails on a missing package; the
 * long-lived container (`docker run -d`) installs it with `docker exec … tlmgr` and
 * builds again with `docker exec … latexmk`. Every call is appended to `calls`.
 */
function fakeDocker(calls: string, env: string): string {
  const bin = tempDir();
  writeFileSync(join(bin, 'missing.log'), `${MISSING_LOG}\n`);
  const script = `#!/bin/sh
echo "$*" >> ${calls}
case "$1" in
  info) echo 29.0; exit 0 ;;
  image)
    if [ "$3" = --format ]; then echo '${env}'; fi
    exit 0 ;;
  run)
    if [ "$2" = -d ]; then echo 0123456789ab; exit 0; fi
    cp ${join(bin, 'missing.log')} main.log
    exit 12 ;;
  exec)
    case "$3" in
      tlmgr)
        if [ "$4" = search ]; then printf 'chemfig:\\n\\ttexmf-dist/tex/latex/chemfig/chemfig.sty\\n'; fi
        exit 0 ;;
      latexmk)
        echo 'Output written on main.pdf (1 page).' > main.log
        echo '%PDF-1.4' > main.pdf
        exit 0 ;;
    esac ;;
  rm) exit 0 ;;
esac
exit 1
`;
  writeFileSync(join(bin, 'docker'), script);
  chmodSync(join(bin, 'docker'), 0o755);
  return bin;
}

describe.skipIf(POSIX_ONLY)('build --engine docker installs missing packages', () => {
  function setup(env: string) {
    const dir = tempDir();
    writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}\\usepackage{chemfig}\n');
    const calls = join(tempDir(), 'calls');
    writeFileSync(calls, '');
    process.env.PATH = `${fakeDocker(calls, env)}:${savedPath}`;
    const io = memIo(dir, { PATH: process.env.PATH });
    return { io, read: () => readFileSync(calls, 'utf8').trim().split('\n'), dir };
  }

  it('in one container that lives for this build only, when the image sets OVERFULL_TEX_INSTALL=1', async () => {
    const { io, read } = setup('["PATH=/usr/bin","OVERFULL_TEX_INSTALL=1"]');
    const code = await main(['build', '--engine', 'docker', '--image', 'overfull:slim'], io);
    const calls = read();
    expect(io.stderrText()).toContain('Installing chemfig from CTAN');
    expect(
      calls.some((c) => c.startsWith('run -d ') && c.endsWith('overfull:slim sleep infinity')),
    ).toBe(true);
    expect(calls).toContain('exec 0123456789ab tlmgr search --global --file /chemfig.sty');
    expect(calls).toContain('exec 0123456789ab tlmgr install chemfig');
    expect(calls.some((c) => c.startsWith('exec 0123456789ab latexmk -g '))).toBe(true);
    expect(calls.at(-1)).toBe('rm -f 0123456789ab');
    expect(code).toBe(0);
  });

  it('not when the image does not install on demand (the full image)', async () => {
    const { io, read } = setup('["PATH=/usr/bin"]');
    const code = await main(['build', '--engine', 'docker', '--image', 'overfull:full'], io);
    expect(code).toBe(1);
    expect(read().some((c) => c.startsWith('run -d') || c.startsWith('exec'))).toBe(false);
  });
});
