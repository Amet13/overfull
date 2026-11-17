/** .github/scripts/image-labels.sh: each image has its own title, and no base image authors. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../.github/scripts/image-labels.sh', import.meta.url));
const labels = (...args: string[]) =>
  Object.fromEntries(
    execFileSync('bash', [script, ...args], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

describe.skipIf(process.platform === 'win32')('image-labels.sh', () => {
  it('gives the three images their own title and description', () => {
    const all = ['full', 'slim', 'check'].map((n) => labels(n));
    expect(new Set(all.map((l) => l['org.opencontainers.image.title'])).size).toBe(3);
    expect(new Set(all.map((l) => l['org.opencontainers.image.description'])).size).toBe(3);
    expect(labels('overfull')).toEqual(labels('full'));
  });

  it("overrides the base image's authors and sets the version only when given", () => {
    const full = labels('full');
    expect(full['org.opencontainers.image.authors']).toBe('Overfull contributors');
    expect(full['org.opencontainers.image.version']).toBeUndefined();
    expect(labels('slim', '3.2.0-slim')['org.opencontainers.image.version']).toBe('3.2.0-slim');
  });

  it('refuses an unknown image', () => {
    expect(() => execFileSync('bash', [script, 'medium'], { stdio: 'ignore' })).toThrow();
  });
});
