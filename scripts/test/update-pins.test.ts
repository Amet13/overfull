/** scripts/update-pins.mjs: the Debian snapshot read from a base image's config, and the pnpm pin. */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script without type declarations
import { minimumReleaseAge, newestMature, newestSnapshot, snapshotOf } from '../update-pins.mjs';

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

describe('pnpm pin', () => {
  // 12.21.0 was pinned four days after it was published, and pnpm then refused to
  // install itself at that version (minimumReleaseAge) until it was 7 days old.
  const meta = {
    versions: { '11.9.0': {}, '12.18.0': {}, '12.20.1': {}, '12.21.0': {}, '13.0.0-rc.1': {} },
    time: {
      '11.9.0': '2026-01-01T00:00:00Z',
      '12.18.0': '2026-10-20T00:00:00Z',
      '12.20.1': '2026-11-05T00:00:00Z',
      '12.21.0': '2026-11-13T21:01:11Z',
      '13.0.0-rc.1': '2026-11-01T00:00:00Z',
    },
  };
  const nov17 = Date.parse('2026-11-17T14:50:00Z');

  it('takes the newest release of the major that is old enough', () => {
    expect(newestMature(meta, '12', 10080, nov17)).toBe('12.20.1');
    expect(newestMature(meta, '12', 10080, Date.parse('2026-11-21T00:00:00Z'))).toBe('12.21.0');
    expect(newestMature(meta, '12', 0, nov17)).toBe('12.21.0');
  });

  it('skips a release without a publish time, and finds nothing when none is old enough', () => {
    expect(newestMature({ versions: { '12.21.0': {} } }, '12', 10080, nov17)).toBeUndefined();
    expect(newestMature(meta, '12', 10080, Date.parse('2026-10-01T00:00:00Z'))).toBeUndefined();
  });

  it("reads the repository's own minimumReleaseAge", () => {
    expect(minimumReleaseAge('packages:\n  - x\nminimumReleaseAge: 10080\n')).toBe(10080);
    expect(minimumReleaseAge('packages: []\n')).toBe(0);
  });
});
