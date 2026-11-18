/** build <file> derives the jobname unless overfull.yml sets it. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { fakeBin, memIo, tempDir } from './helpers.js';

/** Shell-script fakes on PATH and FIFOs do not exist on Windows; these tests run on Linux and macOS. */
const POSIX_ONLY = process.platform === 'win32';

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

// --- R6: build jobname ---------------------------------------------------------

describe.skipIf(POSIX_ONLY)(
  'R6: build <file> derives the jobname unless overfull.yml sets it',
  () => {
    async function jobnameFor(config: [string, string] | undefined): Promise<string> {
      const log = join(tempDir(), 'latexmk-args');
      const bin = fakeBin({ latexmk: `echo "$@" > ${log}\nexit 1` });
      process.env.PATH = `${bin}:${savedPath}`;
      const dir = tempDir();
      writeFileSync(join(dir, 'main.tex'), '');
      writeFileSync(join(dir, 'other.tex'), '');
      if (config) writeFileSync(join(dir, config[0]), config[1]);
      await main(
        ['build', 'other.tex', '--engine', 'local'],
        memIo(dir, { PATH: process.env.PATH }),
      );
      return /-jobname=(\S+)/.exec(readFileSync(log, 'utf8'))?.[1] ?? '';
    }

    it('follows the given file with overfull.yaml or overfull.yml lacking jobname', async () => {
      expect(await jobnameFor(['overfull.yaml', 'checks: [build]\n'])).toBe('other');
      expect(await jobnameFor(['overfull.yml', 'checks: [build]\n'])).toBe('other');
      expect(await jobnameFor(undefined)).toBe('other');
    });

    it('keeps an explicit jobname', async () => {
      expect(await jobnameFor(['overfull.yml', 'jobname: thesis\n'])).toBe('thesis');
    });
  },
);
