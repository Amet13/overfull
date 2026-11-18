import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allRules, getRule } from '../src/rules.js';
import { CHECK_IDS } from '../src/types.js';

describe('rule registry', () => {
  const rules = allRules();

  it('has unique kebab-case ids', () => {
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('documents every rule', () => {
    for (const r of rules) {
      expect(r.title.trim(), r.id).not.toBe('');
      expect(r.summary.trim(), r.id).not.toBe('');
      expect(r.fix.trim(), r.id).not.toBe('');
      expect(CHECK_IDS).toContain(r.check);
      expect(['error', 'warning', 'info']).toContain(r.severity);
    }
  });

  it('covers every module', () => {
    const checks = new Set(rules.map((r) => r.check));
    for (const c of CHECK_IDS) expect(checks.has(c), c).toBe(true);
  });

  it('looks rules up by id, including dynamic veraPDF clauses', () => {
    expect(getRule('pdf-not-tagged')?.check).toBe('accessibility');
    expect(getRule('verapdf-8-2-5-26')).toMatchObject({
      id: 'verapdf-8-2-5-26',
      title:
        'PDF/UA clause 8.2.5.26: Structure element used where the standard does not allow it (veraPDF)',
    });
    expect(getRule('verapdf-6-9-9')).toMatchObject({
      id: 'verapdf-6-9-9',
      title: 'PDF/UA clause 6.9.9 failed (veraPDF)',
    });
    expect(getRule('no-such-rule')).toBeUndefined();
  });
});

describe('every rule is tested', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  /** Rules that cannot have a test or corpus case. Keep this short and say why for each. */
  const EXEMPT = new Map<string, string>([]);

  /** All test sources, and the rule ids each corpus case expects. */
  function evidence(): { tests: string; corpus: Set<string> } {
    let tests = '';
    for (const dir of ['packages/core/test', 'packages/cli/test', 'site/tests']) {
      for (const f of readdirSync(join(root, dir), { recursive: true }) as string[]) {
        if (f.endsWith('.ts') && f !== 'rules.test.ts')
          tests += readFileSync(join(root, dir, f), 'utf8');
      }
    }
    const corpus = new Set<string>();
    for (const c of readdirSync(join(root, 'corpus'))) {
      const file = join(root, 'corpus', c, 'case.json');
      if (!existsSync(file)) continue;
      for (const id of (JSON.parse(readFileSync(file, 'utf8')) as { expect: string[] }).expect)
        corpus.add(id);
    }
    return { tests, corpus };
  }

  it('names each rule id in a test or a corpus case', () => {
    const { tests, corpus } = evidence();
    const untested = allRules()
      .map((r) => r.id)
      .filter((id) => !EXEMPT.has(id))
      .filter((id) => !corpus.has(id) && !tests.includes(`'${id}'`) && !tests.includes(`"${id}"`));
    expect(untested, 'add a unit test or a corpus case for these rules').toEqual([]);
  });

  it('exempts only rules that exist', () => {
    const ids = new Set(allRules().map((r) => r.id));
    for (const id of EXEMPT.keys()) expect(ids.has(id), id).toBe(true);
  });
});
