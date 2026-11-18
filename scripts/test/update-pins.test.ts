/** scripts/update-pins.mjs: the Debian snapshot read from a base image's config. */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script without type declarations
import { newestSnapshot, snapshotOf } from '../update-pins.mjs';

const config = (createdBy: string) => ({
  history: [{ created_by: createdBy }, { created_by: 'ENV LANG=C.UTF-8' }],
});

describe('snapshotOf', () => {
  it('reads the epoch debian.sh records as the first step', () => {
    expect(snapshotOf(config("# debian.sh --arch 'amd64' out/ 'testing' '@1793059200'"))).toBe(
      '20261027T000000Z',
    );
    expect(snapshotOf(config("# debian.sh --arch 'amd64' out/ 'testing' '@1793827419'"))).toBe(
      '20261104T212339Z',
    );
  });

  it('gives nothing for an image not built by debian.sh', () => {
    expect(snapshotOf(config('ADD file:abc in /'))).toBeUndefined();
    expect(snapshotOf({})).toBeUndefined();
  });
});

describe('newestSnapshot', () => {
  it('only moves forward', () => {
    expect(newestSnapshot('20261104T212339Z', ['20261027T000000Z', '20261104T212339Z'])).toBe(
      '20261104T212339Z',
    );
    expect(newestSnapshot('20261104T212339Z', ['20261027T000000Z', '20261201T000000Z'])).toBe(
      '20261201T000000Z',
    );
    expect(newestSnapshot('20261104T212339Z', [undefined])).toBe('20261104T212339Z');
  });
});
