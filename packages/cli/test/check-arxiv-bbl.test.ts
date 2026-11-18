/** The venue check reads `<main>.bbl` for the arXiv .bbl format rule. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCheck } from '../src/check.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('arXiv .bbl format', () => {
  it('warns when main.bbl has a biblatex format arXiv cannot read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overfull-arxiv-bbl-'));
    dirs.push(dir);
    writeFileSync(
      join(dir, 'main.tex'),
      '\\documentclass{article}\n\\usepackage{biblatex}\n\\addbibresource{refs.bib}\n\\begin{document}x\\end{document}\n',
    );
    writeFileSync(join(dir, 'refs.bib'), '@misc{a, title={T}}\n');
    writeFileSync(
      join(dir, 'main.bbl'),
      '% $ biblatex auxiliary file $\n% $ biblatex bbl format version 3.4 $\n',
    );
    const report = await runCheck({
      cwd: dir,
      checks: ['venue'],
      profile: 'arxiv',
      offline: true,
      env: { PATH: process.env.PATH },
    });
    const rules = report.checks.flatMap((c) => c.problems.map((p) => p.rule));
    expect(rules).toContain('arxiv-bbl-version');
    expect(rules).not.toContain('arxiv-missing-bbl');
  });
});
