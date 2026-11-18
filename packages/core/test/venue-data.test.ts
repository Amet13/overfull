import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  profilesForStyleFile,
  resolveProfile,
  UnknownProfileError,
  type VenueProfileData,
  venueCheck,
} from '../src/venue/index.js';
import { tempDir } from './helpers.js';

const script = fileURLToPath(new URL('../../../scripts/build-venues.mjs', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/venue/', import.meta.url));

function load(dir: string): Record<string, VenueProfileData> {
  const out = execFileSync('node', [script, '--print', '--dir', dir], { encoding: 'utf8' });
  return JSON.parse(out).profiles;
}
const venues = load(`${fixtures}venues`);
const tex = (content: string, path = 'main.tex') => ({ path, content });

describe('venue profiles from data', () => {
  it('validates the fixture and resolves it with defaults from its base', () => {
    const p = resolveProfile('example-test-venue', venues);
    expect(p.name).toMatch(/test fixture/);
    expect(p.year).toBe(2027);
    expect(p.pageLimit).toEqual({
      max: 9,
      endLabel: 'overfull:main-end',
      counts: 'Test text',
      excludes: ['References'],
    });
    expect(p.anonymous).toBe(true);
    expect(p.disclosure).toBe('required');
    expect(p.accessibility).toBe('recommended'); // from double-blind
    expect(p.checks).toBeDefined();
    expect(p.styleFiles?.[0]?.name).toBe('exampletest.sty');
  });

  it('keeps `extends` working on top of a venue profile', () => {
    const p = resolveProfile(
      { extends: 'example-test-venue', pageLimit: { max: 12 }, anonymous: false },
      venues,
    );
    expect(p.pageLimit).toMatchObject({ max: 12, endLabel: 'overfull:main-end' });
    expect(p.anonymous).toBe(false);
    expect(p.id).toBe('example-test-venue');
  });

  it('leaves the built-in profiles unchanged and rejects unknown names', () => {
    expect(resolveProfile('paper', venues).disclosure).toBe('recommended');
    expect(resolveProfile('generic').pageLimit).toBeUndefined();
    expect(() => resolveProfile('nope', venues)).toThrow(UnknownProfileError);
    expect(() => resolveProfile('example-test-venue')).toThrow(/Unknown profile/);
  });

  it('maps style file names to profile ids from the data', () => {
    expect(profilesForStyleFile('exampletest.sty', venues)).toEqual(['example-test-venue']);
    expect(profilesForStyleFile('sub/dir/ExampleTest.STY', venues)).toEqual(['example-test-venue']);
    expect(profilesForStyleFile('other.sty', venues)).toEqual([]);
  });
});

describe('venue-profile-stale', () => {
  const ctx = (now: string) => ({ texFiles: [tex('x')], now: new Date(now) });
  const profile = resolveProfile('example-test-venue', venues); // checkedOn 2026-01-15

  it('is silent up to 14 months', () => {
    const r = venueCheck(profile, ctx('2027-03-15T00:00:00Z'));
    expect(r.problems.map((p) => p.rule)).not.toContain('venue-profile-stale');
  });

  it('gives an info note after 14 months', () => {
    const r = venueCheck(profile, ctx('2027-03-16T00:00:00Z'));
    const p = r.problems.find((x) => x.rule === 'venue-profile-stale');
    expect(p?.severity).toBe('info');
    expect(p?.message).toMatch(/2026-01-15.*out of date/);
    expect(p?.fix).toContain('https://example.invalid/test-fixture');
  });

  it("says so 30 days after the edition's deadline", () => {
    const p = resolveProfile({ extends: 'example-test-venue', deadline: '2026-05-01' }, venues);
    expect(venueCheck(p, ctx('2026-05-31T12:00:00Z')).problems.map((x) => x.rule)).not.toContain(
      'venue-profile-stale',
    );
    const r = venueCheck(p, ctx('2026-06-01T12:00:00Z'));
    const stale = r.problems.filter((x) => x.rule === 'venue-profile-stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.severity).toBe('info');
    expect(stale[0]?.message).toMatch(/deadline \(2026-05-01\) passed 31 days ago/);
    expect(stale[0]?.data).toMatchObject({ deadline: '2026-05-01', days: 31 });
  });

  it('gives one note when the deadline passed and the check is old', () => {
    const p = resolveProfile({ extends: 'example-test-venue', deadline: '2026-05-01' }, venues);
    const r = venueCheck(p, ctx('2027-06-01T00:00:00Z'));
    const stale = r.problems.filter((x) => x.rule === 'venue-profile-stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]?.message).toMatch(/deadline/);
  });

  it('is silent before the deadline even with an old check date', () => {
    const p = resolveProfile({ extends: 'example-test-venue', deadline: '2027-09-01' }, venues);
    const r = venueCheck(p, ctx('2027-03-16T00:00:00Z'));
    const stale = r.problems.filter((x) => x.rule === 'venue-profile-stale');
    expect(stale.map((x) => x.data?.checkedOn)).toEqual(['2026-01-15']);
  });

  it('does not apply to profiles without checkedOn', () => {
    const r = venueCheck(resolveProfile('paper'), ctx('2040-01-01T00:00:00Z'));
    expect(r.problems.map((p) => p.rule)).not.toContain('venue-profile-stale');
  });
});

describe('scripts/build-venues.mjs', () => {
  const run = (...a: string[]) => spawnSync('node', [script, ...a], { encoding: 'utf8' });

  it('--check passes for the committed module and venues/', () => {
    expect(run('--check').status).toBe(0);
  });

  it('--check fails on a missing source or checkedOn', () => {
    const r = run('--check', '--dir', `${fixtures}venues-invalid`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('example-no-source.yml: missing "source"');
    expect(r.stderr).toContain('example-no-checked-on.yml: missing "checkedOn"');
  });

  it('--check fails when the generated file is stale, and a write fixes it', () => {
    const dir = tempDir();
    const out = join(dir, 'gen.ts');
    const base = ['--dir', `${fixtures}venues`, '--out', out];
    expect(run('--check', ...base).status).toBe(1);
    expect(run(...base).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('"example-test-venue"');
    expect(run('--check', ...base).status).toBe(0);
    writeFileSync(out, `${readFileSync(out, 'utf8')}// edited\n`);
    expect(run('--check', ...base).status).toBe(1);
  });

  it('validates deadline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'venues-'));
    const base = 'name: X\nyear: 2027\nsource: https://example.org\ncheckedOn: 2026-11-10\n';
    writeFileSync(join(dir, 'good-venue.yml'), `id: good-venue\n${base}deadline: 2027-01-31\n`);
    writeFileSync(join(dir, 'bad-venue.yml'), `id: bad-venue\n${base}deadline: 2027-02-30\n`);
    const r = run('--print', '--dir', dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('bad-venue.yml: \\"deadline\\" must be a date');
    expect(JSON.parse(r.stdout).profiles['good-venue'].deadline).toBe('2027-01-31');
  });

  it('validates anonymizedByClass', () => {
    const dir = tempDir();
    const base =
      'name: X\nyear: 2027\nsource: https://example.org\ncheckedOn: 2026-11-10\nanonymous: true\n';
    writeFileSync(
      join(dir, 'good-venue.yml'),
      `id: good-venue\n${base}anonymizedByClass:\n  package: good_2027\n  unlessOptions: [final]\n`,
    );
    writeFileSync(
      join(dir, 'bad-venue.yml'),
      `id: bad-venue\n${base}anonymizedByClass:\n  package: bad\n  options: [x]\n  withOptions: []\n`,
    );
    const r = run('--print', '--dir', dir);
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toContain('unknown anonymizedByClass field \\"options\\"');
    expect(r.stdout).toContain('anonymizedByClass.withOptions');
    expect(JSON.parse(r.stdout).profiles['good-venue'].anonymizedByClass).toEqual({
      package: 'good_2027',
      unlessOptions: ['final'],
    });
  });
});
