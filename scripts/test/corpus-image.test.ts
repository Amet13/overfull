/** scripts/corpus.mjs compiles the cases in the TeX Live image docker/Dockerfile pins. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(new URL(p, new URL('../../', import.meta.url)), 'utf8');

describe('corpus TeX Live image', () => {
  it('is the texbase-full image of docker/Dockerfile', () => {
    const from = /^FROM (\S+) AS texbase-full$/m.exec(read('docker/Dockerfile'))?.[1];
    expect(from).toMatch(/^texlive\/texlive:\S+@sha256:[0-9a-f]{64}$/);
    const env = { ...process.env };
    delete env.OVERFULL_TEX_IMAGE;
    const printed = execFileSync(process.execPath, ['scripts/corpus.mjs', '--print-image'], {
      cwd: root,
      env,
      encoding: 'utf8',
    }).trim();
    expect(printed).toBe(from);
  });

  it('keeps no pin of its own', () => {
    expect(read('scripts/corpus.mjs')).not.toMatch(/sha256:[0-9a-f]{64}/);
  });
});
