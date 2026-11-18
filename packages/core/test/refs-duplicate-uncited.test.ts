/** reference-duplicate and reference-uncited: offline checks over the parsed entries. */
import { describe, expect, it } from 'vitest';
import { parseBib } from '../src/bib/index.js';
import { refsCheck } from '../src/refs/index.js';
import type { RefResult } from '../src/refs/types.js';

const offline = (keys: string[]): RefResult[] =>
  keys.map((key) => ({ key, status: 'unverifiable', reason: 'offline' }));

function check(bib: string, opts: Parameters<typeof refsCheck>[1] = {}) {
  const entries = parseBib(bib);
  return refsCheck(offline(entries.map((e) => e.key)), { entries, ...opts }).problems;
}

const ruled = (rule: string, bib: string, opts: Parameters<typeof refsCheck>[1] = {}) =>
  check(bib, opts).filter((p) => p.rule === rule);

describe('reference-duplicate', () => {
  it('names the earlier entry when two share a DOI (case-insensitive)', () => {
    const p = ruled(
      'reference-duplicate',
      '@article{a, title={One}, doi={10.1145/359545.359563}}\n' +
        '@article{b, title={Two}, doi={10.1145/359545.359563}}\n' +
        '@article{c, title={Three}, doi={10.1145/359545.359563}}\n',
    );
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({
      severity: 'warning',
      check: 'references',
      data: { key: 'b', duplicateOf: 'a', by: 'doi' },
    });
    expect(p[0]?.message).toContain('the same DOI');
    expect(p[0]?.detail).toContain('10.1145/359545.359563');
    expect(p[1]?.data).toMatchObject({ key: 'c', duplicateOf: 'a' });
  });

  it('finds the same arXiv id and the same long title and year', () => {
    const arxiv = ruled(
      'reference-duplicate',
      '@misc{x, title={A}, eprint={2301.00001}, archivePrefix={arXiv}}\n' +
        '@misc{y, title={B}, eprint={2301.00001}, archivePrefix={arXiv}}\n',
    );
    expect(arxiv[0]?.data).toMatchObject({ key: 'y', duplicateOf: 'x', by: 'arxiv' });
    const title = ruled(
      'reference-duplicate',
      '@article{p, title={Attention Is All You Need}, year={2017}}\n' +
        '@inproceedings{q, title={Attention is all you need.}, year={2017}}\n',
    );
    expect(title[0]?.data).toMatchObject({ key: 'q', duplicateOf: 'p', by: 'title' });
    expect(title[0]?.message).toContain('the same title and year');
  });

  it('reports one problem per later entry even when several keys match', () => {
    const p = ruled(
      'reference-duplicate',
      '@article{a, title={Attention Is All You Need}, year={2017}, doi={10.1145/3000001}}\n' +
        '@article{b, title={Attention Is All You Need}, year={2017}, doi={10.1145/3000001}}\n',
    );
    expect(p).toHaveLength(1);
    expect(p[0]?.data).toMatchObject({ by: 'doi' });
  });

  it('ignores short titles, different years and entries without identifiers', () => {
    expect(
      ruled(
        'reference-duplicate',
        '@article{a, title={Results}, year={2020}}\n@article{b, title={Results}, year={2020}}\n' +
          '@article{c, title={Attention Is All You Need}, year={2017}}\n' +
          '@article{d, title={Attention Is All You Need}, year={2018}}\n' +
          '@misc{e, title={No year at all here, long}}\n@misc{f, title={No year at all here, long}}\n',
      ),
    ).toEqual([]);
  });

  it('needs the entries', () => {
    expect(
      refsCheck(offline(['a', 'b'])).problems.filter((p) => p.rule === 'reference-duplicate'),
    ).toEqual([]);
  });
});

describe('reference-uncited', () => {
  const bib = '@misc{used, title={Used}}\n@misc{spare, title={Spare}}\n';

  it('reports entries no \\cite uses, as info, when asked and the cited keys are known', () => {
    const p = ruled('reference-uncited', bib, { reportUncited: true, citedKeys: ['used'] });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ severity: 'info', check: 'references', data: { key: 'spare' } });
    expect(p[0]?.message).toContain('`spare` is in the bibliography');
  });

  it('is off by default and says nothing without the cited keys', () => {
    expect(ruled('reference-uncited', bib, { citedKeys: ['used'] })).toEqual([]);
    expect(ruled('reference-uncited', bib, { reportUncited: true })).toEqual([]);
  });
});
