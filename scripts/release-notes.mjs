#!/usr/bin/env node
// Writes the next version's CHANGELOG section from the [Unreleased] section and the commits
// since the last release tag, and prints the new version. Used by autorelease.yml.
//
//   node scripts/release-notes.mjs            print the next version and the section (dry run)
//   node scripts/release-notes.mjs --write    also move [Unreleased] into the new section
//
// The version is a minor bump when the release adds something (an `### Added` section with
// entries), else a patch bump; never a major bump (that is a decision, made by hand).
// Commit subjects are merged into the section's `### Changed` list (one heading each), and
// dependency bumps are folded into one "Dependency updates: …" line.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Subjects that only record generated files; never worth a changelog line. */
const NOISE = /^(Rebuild action\/dist|Rebuild the bundled Action|Regenerate generated files)$/;

/** The usual order of Keep a Changelog subsections; others keep their place after these. */
const ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

/** Dependabot and similar subjects: `Bump x from a to b`, `build(deps): bump …`, `Update dependency x`. */
const DEPENDENCY =
  /^(?:(?:build|chore|fix)\(deps(?:-dev)?\):\s*)?(?:bump|update dependency)\s+(.+)$/i;

/** The name a dependency subject updates, or null when the subject is not a dependency bump. */
export function dependencyName(subject) {
  const m = DEPENDENCY.exec(subject.trim());
  if (!m) return null;
  const name = (m[1] ?? '')
    .split(/\s+(?:from|in|with|across|to)\s+|\s+\(#\d+\)/)[0]
    ?.replace(/^the\s+/i, '')
    .trim();
  return name || null;
}

/** Sorts commit subjects into changelog lines: dependency bumps become one line. */
export function summarize(subjects) {
  const lines = [];
  const deps = [];
  for (const raw of subjects) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!s || NOISE.test(s)) continue;
    const dep = dependencyName(s);
    if (dep) {
      if (!deps.includes(dep)) deps.push(dep);
    } else if (!lines.includes(s)) {
      lines.push(s);
    }
  }
  if (deps.length) lines.push(`Dependency updates: ${deps.join(', ')}.`);
  return lines;
}

/**
 * Splits a changelog section body into its intro text and `### ` subsections, merging
 * repeated headings into one list.
 */
export function parseSection(body) {
  const intro = [];
  const sections = new Map();
  let current;
  for (const line of body.split('\n')) {
    const h = /^###\s+(.+?)\s*$/.exec(line);
    if (h) {
      const name = h[1];
      if (!sections.has(name)) sections.set(name, []);
      current = sections.get(name);
      continue;
    }
    (current ?? intro).push(line);
  }
  const trim = (lines) => {
    const out = [...lines];
    while (out.length && !out[0].trim()) out.shift();
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out;
  };
  for (const [name, lines] of sections) sections.set(name, trim(lines));
  return { intro: trim(intro), sections };
}

/** True when a subsection has at least one list entry. */
const hasEntries = (lines) => (lines ?? []).some((l) => /^\s*[-*]\s+\S/.test(l));

/** The next version: minor when something was added, else patch. Never major. */
export function nextVersion(version, sections) {
  const [maj, min, pat] = version.split('.').map(Number);
  if ([maj, min, pat].some((n) => !Number.isInteger(n))) throw new Error(`bad version ${version}`);
  return hasEntries(sections.get('Added')) ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

/** Normalised text of a list entry, to drop a commit subject that an entry already says. */
const plain = (s) =>
  s
    .replace(/^\s*[-*]\s+/, '')
    .replace(/[`*.]/g, '')
    .trim()
    .toLowerCase();

/**
 * Builds the release: the [Unreleased] content plus the commit subjects become the new
 * version's section, dated, and [Unreleased] is left empty.
 */
export function buildRelease({ changelog, version, subjects, date }) {
  const head = /^## \[Unreleased\][^\n]*\n/m.exec(changelog);
  if (!head) throw new Error('CHANGELOG.md has no [Unreleased] heading');
  const start = head.index + head[0].length;
  const rest = changelog.slice(start);
  const nextHeading = /^## /m.exec(rest);
  const body = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  const after = nextHeading ? rest.slice(nextHeading.index) : '';

  const { intro, sections } = parseSection(body);
  const changed = sections.get('Changed') ?? [];
  const known = new Set(
    [...sections.values()]
      .flat()
      .filter((l) => /^\s*[-*]\s/.test(l))
      .map(plain),
  );
  const extra = summarize(subjects).filter((s) => !known.has(plain(s)));
  changed.push(...extra.map((s) => `- ${s}`));
  if (!hasEntries(changed) && ![...sections.values()].some(hasEntries)) {
    changed.push('- Maintenance release: no user-visible changes.');
  }
  if (changed.length) sections.set('Changed', changed);

  const next = nextVersion(version, sections);
  const names = [
    ...ORDER.filter((n) => sections.has(n)),
    ...[...sections.keys()].filter((n) => !ORDER.includes(n)),
  ];
  const out = [
    `## [v${next}] - ${date}`,
    '',
    `Changes merged since v${version}, each after the full test suite and the template`,
    'builds passed. Released automatically by autorelease.yml.',
    '',
  ];
  if (intro.length) out.push(...intro, '');
  for (const name of names) {
    const lines = sections.get(name);
    if (!hasEntries(lines) && !lines.some((l) => l.trim())) continue;
    out.push(`### ${name}`, '', ...lines, '');
  }
  const section = out.join('\n');
  const fresh = `\n${section}\n`.replace(/\n{3,}/g, '\n\n');
  return { next, section, changelog: `${changelog.slice(0, start)}${fresh}${after}` };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const pkg = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
  const subjects = git('log', '--no-merges', '--format=%s', `v${pkg.version}..HEAD`).split('\n');
  const path = join(root, 'CHANGELOG.md');
  const result = buildRelease({
    changelog: readFileSync(path, 'utf8'),
    version: pkg.version,
    subjects,
    date: new Date().toISOString().slice(0, 10),
  });
  if (process.argv.includes('--write')) writeFileSync(path, result.changelog);
  else console.error(result.section);
  console.log(result.next);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
