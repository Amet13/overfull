/** scripts/release-notes.mjs: version bump, merged headings, dependency lines, dates. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script without type declarations
import {
  buildRelease,
  dependencyName,
  nextVersion,
  parseSection,
  summarize,
} from '../release-notes.mjs';

type Release = { next: string; section: string; changelog: string };
const release = (changelog: string, subjects: string[] = [], version = '3.1.2'): Release =>
  buildRelease({ changelog, version, subjects, date: '2026-12-01' });

const HEAD = '# Changelog\n\nIntro.\n\n## [Unreleased]\n';
const OLD = '## [v3.1.2] - 2026-11-16\n\n### Changed\n\n- Old entry\n';

describe('release-notes', () => {
  it('bumps the patch version when nothing was added', () => {
    const r = release(`${HEAD}\n### Fixed\n\n- A fix\n\n${OLD}`);
    expect(r.next).toBe('3.1.3');
  });

  it('bumps the minor version when the release has an Added entry', () => {
    const r = release(`${HEAD}\n### Added\n\n- A feature\n\n${OLD}`);
    expect(r.next).toBe('3.2.0');
  });

  it('never bumps the major version', () => {
    const sections = parseSection('### Added\n\n- Breaking thing\n\n### Removed\n\n- X\n').sections;
    expect(nextVersion('3.9.4', sections)).toBe('3.10.0');
    expect(nextVersion('3.9.4', new Map())).toBe('3.9.5');
  });

  it('ignores an empty Added heading', () => {
    const r = release(`${HEAD}\n### Added\n\n### Fixed\n\n- A fix\n\n${OLD}`);
    expect(r.next).toBe('3.1.3');
    expect(r.section).not.toContain('### Added');
  });

  it('merges commit subjects into the existing Changed list: one heading each', () => {
    const r = release(`${HEAD}\n### Added\n\n- A\n\n### Changed\n\n- Curated\n\n${OLD}`, [
      'Speed up the CLI',
      'Curated',
    ]);
    const section = r.section;
    expect(section.match(/^### Changed$/gm)).toHaveLength(1);
    expect(section).toContain('- Curated\n- Speed up the CLI');
    expect(section.match(/- Curated/g)).toHaveLength(1);
    expect(section.indexOf('### Added')).toBeLessThan(section.indexOf('### Changed'));
  });

  it('dates the release and empties [Unreleased]', () => {
    const r = release(`${HEAD}\n### Fixed\n\n- A fix\n\n${OLD}`);
    expect(r.section.split('\n')[0]).toBe('## [v3.1.3] - 2026-12-01');
    expect(r.changelog).toContain('## [Unreleased]\n\n## [v3.1.3] - 2026-12-01\n');
    expect(r.changelog).toContain(OLD);
    expect(r.changelog).not.toMatch(/\n{3,}/);
    // The [Unreleased] entries moved into the release.
    expect(r.changelog.indexOf('- A fix')).toBeGreaterThan(r.changelog.indexOf('## [v3.1.3]'));
  });

  it('keeps the intro text of [Unreleased]', () => {
    const r = release(`${HEAD}\nFaster everywhere.\n\n### Fixed\n\n- A fix\n\n${OLD}`);
    expect(r.section).toContain('autorelease.yml.\n\nFaster everywhere.\n\n### Fixed');
  });

  it('folds dependency bumps into one line and drops generated-file commits', () => {
    expect(
      summarize([
        'Bump the github-actions group with 3 updates (#72)',
        'Bump the github-actions group with 2 updates',
        'Bump texlive/texlive from `a389491` to `c8bb7e1` in the docker group',
        'Bump virtualenv from 21.2.1 to 21.7.13 in /.devcontainer (#73)',
        'build(deps): bump esbuild from 0.28.1 to 0.28.2',
        'Update dependency yaml to v2.9.1',
        'Rebuild action/dist',
        'Update toolchain to the latest November 2026 releases',
      ]),
    ).toEqual([
      'Update toolchain to the latest November 2026 releases',
      'Dependency updates: github-actions group, texlive/texlive, virtualenv, esbuild, yaml.',
    ]);
    expect(dependencyName('Fix the bump script')).toBeNull();
  });

  it('writes a placeholder line for a release with nothing but generated files', () => {
    const r = release(`${HEAD}\n${OLD}`, ['Rebuild action/dist']);
    expect(r.next).toBe('3.1.3');
    expect(r.section).toContain('### Changed\n\n- Maintenance release: no user-visible changes.');
  });

  it('refuses a changelog without [Unreleased]', () => {
    expect(() => release(`# Changelog\n\n${OLD}`)).toThrow(/Unreleased/);
  });
});

describe('CHANGELOG.md', () => {
  const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
  const releases = text.split(/^(?=## )/m).filter((s) => s.startsWith('## '));

  it('dates every release', () => {
    const undated = releases
      .map((s) => s.split('\n')[0] as string)
      .filter((h) => !h.startsWith('## [Unreleased]') && !/ - \d{4}-\d{2}-\d{2}$/.test(h));
    expect(undated).toEqual([]);
  });

  it('has each subsection heading once per release', () => {
    const dup = releases.flatMap((s) => {
      const names = [...s.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
      return names.filter((n, i) => names.indexOf(n) !== i).map((n) => `${s.split('\n')[0]}: ${n}`);
    });
    expect(dup).toEqual([]);
  });

  it('can be released by the script', () => {
    const r = release(text, ['Bump the npm group with 3 updates']);
    expect(r.section).toMatch(/^## \[v3\.\d+\.\d+\] - 2026-12-01/);
  });
});
