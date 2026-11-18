/** Pure helpers of the browser check: loose-file limits, overfull.yml, reference hints, tables. */
import { type CheckResult, parseBib } from '@overfull/core';
import { describe, expect, it } from 'vitest';
import { wrapTables } from '../src/lib/tables';
import { readWithinLimits } from '../src/scripts/loose';
import { profileFromConfig } from '../src/scripts/project';
import { browserRefHints } from '../src/scripts/refs-hints';

const file = (name: string, text: string) => Object.assign(new Blob([text]), { name });
const limits = { maxEntryBytes: 100, maxTotalBytes: 150 };

describe('readWithinLimits', () => {
  it('reads a file under the limits and counts its bytes', async () => {
    const used = { bytes: 0 };
    const r = await readWithinLimits(file('a.bib', 'x'.repeat(60)), false, used, limits);
    expect(r.ok).toBe(true);
    expect(used.bytes).toBe(60);
  });

  it('skips a file over the per-file limit', async () => {
    const r = await readWithinLimits(file('a.pdf', 'x'.repeat(101)), false, { bytes: 0 }, limits);
    expect(r).toEqual({ ok: false, reason: 'too large (1 MB; the limit is 1 MB)' });
  });

  it('skips a file that would pass the total limit', async () => {
    const used = { bytes: 100 };
    const r = await readWithinLimits(file('b.bib', 'x'.repeat(60)), false, used, limits);
    expect(r.ok).toBe(false);
    expect(used.bytes).toBe(100);
  });

  it('keeps the head and tail of a log over the limit', async () => {
    const text = `HEAD${'.'.repeat(200)}TAIL`;
    const r = await readWithinLimits(file('big.log', text), true, { bytes: 0 }, limits, 10);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new TextDecoder().decode(r.data)).toBe(`HEAD${'.'.repeat(6)}\n${'.'.repeat(6)}TAIL`);
    expect(r.note).toMatch(/^big\.log is 1 MB: only its first and last 1 MB were checked\.$/);
  });
});

describe('profileFromConfig', () => {
  it('reads a plain or quoted profile name', () => {
    expect(profileFromConfig('main: main.tex\nprofile: neurips-2026 # venue\n')).toBe(
      'neurips-2026',
    );
    expect(profileFromConfig("profile: 'thesis'")).toBe('thesis');
    expect(profileFromConfig('profile: "paper"\r\n')).toBe('paper');
  });

  it('ignores a mapping, an indented key and a missing key', () => {
    expect(profileFromConfig('profile:\n  extends: paper\n')).toBeUndefined();
    expect(profileFromConfig('venue:\n  profile: paper\n')).toBeUndefined();
    expect(profileFromConfig('main: main.tex\n')).toBeUndefined();
  });
});

describe('browserRefHints', () => {
  const entries = parseBib(`
@misc{arx, title = {T}, eprint = {2001.01234}, archiveprefix = {arXiv}}
@article{withdoi, title = {T}, doi = {10.1000/x}}
@article{bare, title = {T}}`);
  const problem = (key: string) => ({
    rule: 'reference-lookup-failed',
    check: 'references' as const,
    severity: 'warning' as const,
    message: `\`${key}\` could not be checked`,
    fix: 'OpenAlex could not answer. Add the DOI or arXiv id to the entry.',
    data: { key },
  });
  it('points entries that have an identifier to overfull check', () => {
    const check: CheckResult = {
      check: 'references',
      status: 'warn',
      problems: [problem('arx'), problem('withdoi'), problem('bare')],
    };
    browserRefHints(check, entries);
    const [a, d, b] = check.problems;
    expect(a?.fix).toMatch(/the browser cannot reach arXiv; run `overfull check`/);
    expect(d?.fix).toMatch(/already has a DOI.*run `overfull check`/);
    expect(b?.fix).toMatch(/Add the DOI/);
  });
});

describe('wrapTables', () => {
  it('wraps each table in a labelled, focusable region named after its section', () => {
    const html =
      '<h2 id="o">Options &amp; flags</h2><table><tr><td>1</td></tr></table><p>x</p><table><tr><td>2</td></tr></table><h3>Exit</h3><table></table>';
    const out = wrapTables(html);
    expect(out.match(/role="region" tabindex="0"/g)).toHaveLength(3);
    expect(out).toContain('aria-label="Table: Options &amp; flags"><table>');
    expect(out).toContain('aria-label="Table: Options &amp; flags (2)"');
    expect(out).toContain('aria-label="Table: Exit"');
    expect(out).toContain('<h2 id="o">Options &amp; flags</h2>');
  });
});
