/** Install-on-demand in the slim image: which missing files to install, and from which package. */
import type { Problem } from '@overfull/core';
import { describe, expect, it } from 'vitest';
import { missingTexFiles, packagesProviding } from '../src/commands/build.js';

const p = (rule: string, file: string): Problem => ({
  rule,
  check: 'build',
  severity: 'error',
  message: '',
  data: { file },
});

describe('missingTexFiles', () => {
  it('keeps distribution files, not the author’s own files or odd names', () => {
    expect(
      missingTexFiles([
        p('missing-package', 'tikz-cd.sty'),
        p('missing-package', 'acmart.cls'),
        p('missing-file', 'IEEEtran.bst'),
        p('missing-file', 'chapters/intro.tex'),
        p('missing-figure', 'plot.pdf'),
        p('missing-package', 'evil;rm -rf.sty'),
        p('missing-package', 'tikz-cd.sty'),
        {
          rule: 'biblatex-error',
          check: 'build',
          severity: 'error',
          message: "biblatex: Style 'ieee' not found.",
        },
        {
          rule: 'biblatex-error',
          check: 'build',
          severity: 'error',
          message: "biblatex: Command '\\cite' undefined.",
        },
      ]),
    ).toEqual(['tikz-cd.sty', 'acmart.cls', 'IEEEtran.bst', 'ieee.bbx']);
  });
});

describe('packagesProviding', () => {
  it('reads tlmgr search output and matches the exact file name', () => {
    const out = [
      'tlmgr: package repository https://mirror.ctan.org/systems/texlive/tlnet (verified)',
      'tikz-cd:',
      '\ttexmf-dist/tex/latex/tikz-cd/tikz-cd.sty',
      'tikz-cd-extra:',
      '\ttexmf-dist/tex/latex/tikz-cd-extra/my-tikz-cd.sty',
      'other:',
      '\ttexmf-dist/doc/other/tikz-cd.sty.txt',
    ].join('\n');
    expect(packagesProviding(out, 'tikz-cd.sty')).toEqual(['tikz-cd']);
    expect(packagesProviding('', 'x.sty')).toEqual([]);
  });
});
