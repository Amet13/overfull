/** Install-on-demand in the slim image: which missing files to install, and from which package. */
import type { Problem } from '@overfull/core';
import { describe, expect, it } from 'vitest';
import {
  historicRepositories,
  installMissing,
  missingTexFiles,
  needsSelfUpdate,
  packagesProviding,
  remoteTlmgr,
  rolloverYear,
} from '../src/commands/build.js';

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

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string) => ({ code: 1, stdout: '', stderr });

/** A fake tlmgr: answers each call from the list, recording its arguments. */
function fakeTlmgr(answers: ReturnType<typeof ok>[]) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    return answers.shift() ?? ok();
  };
  return { calls, exec };
}

const CRITICAL = [
  'tlmgr: Unable to update and repository is not the same as remote.',
  '=============================================================================',
  'tlmgr itself needs to be updated.',
  'Please do this via either',
  '  tlmgr update --self',
  'tlmgr: Terminating; please see warning above!',
].join('\n');
const ROLLOVER = [
  'tlmgr: Local TeX Live (2026) is older than remote repository (2027).',
  'Cross release updates are only supported with',
  '  update-tlmgr-latest(.sh/.exe) --update',
  'See https://tug.org/texlive/upgrade.html for details.',
].join('\n');

describe('tlmgr output', () => {
  it('recognizes a critical tlmgr update and the yearly rollover', () => {
    expect(needsSelfUpdate(CRITICAL)).toBe(true);
    expect(needsSelfUpdate(ROLLOVER)).toBe(false);
    expect(rolloverYear(ROLLOVER)).toBe('2026');
    expect(rolloverYear(CRITICAL)).toBeUndefined();
    expect(historicRepositories('2026')[0]).toBe(
      'https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2026/tlnet-final',
    );
  });
});

describe('remoteTlmgr', () => {
  it('tries a failing call three times (another mirror each time)', async () => {
    const t = fakeTlmgr([fail('mirror down'), fail('mirror down'), fail('mirror down')]);
    const r = await remoteTlmgr(t.exec, () => {})(['install', 'x']);
    expect(r.code).toBe(1);
    expect(t.calls).toHaveLength(3);
  });

  it('updates tlmgr itself once when asked to, then retries', async () => {
    const notes: string[] = [];
    const t = fakeTlmgr([fail(CRITICAL), ok(), ok('installed')]);
    const r = await remoteTlmgr(t.exec, (m) => notes.push(m))(['install', 'x']);
    expect(r).toEqual(ok('installed'));
    expect(t.calls).toEqual([
      ['install', 'x'],
      ['update', '--self'],
      ['install', 'x'],
    ]);
    expect(notes.join('')).toContain('tlmgr update --self');
  });

  it('gives up when tlmgr still asks for an update after updating itself', async () => {
    const t = fakeTlmgr([fail(CRITICAL), ok(), fail(CRITICAL)]);
    const r = await remoteTlmgr(t.exec, () => {})(['install', 'x']);
    expect(r.code).toBe(1);
    expect(t.calls).toHaveLength(3);
  });

  it('returns the failed self-update', async () => {
    const t = fakeTlmgr([fail(CRITICAL), fail('cannot update')]);
    const r = await remoteTlmgr(t.exec, () => {})(['install', 'x']);
    expect(r.stderr).toBe('cannot update');
  });

  it('after the rollover uses the frozen repository, for later calls too', async () => {
    const notes: string[] = [];
    const t = fakeTlmgr([fail(ROLLOVER), ok('found'), ok('installed')]);
    const tlmgr = remoteTlmgr(t.exec, (m) => notes.push(m));
    expect(await tlmgr(['search', '--global', '--file', '/x.sty'])).toEqual(ok('found'));
    expect(await tlmgr(['install', 'x'])).toEqual(ok('installed'));
    const [utah] = historicRepositories('2026');
    expect(t.calls).toEqual([
      ['search', '--global', '--file', '/x.sty'],
      ['--repository', utah, 'search', '--global', '--file', '/x.sty'],
      ['--repository', utah, 'install', 'x'],
    ]);
    expect(notes.join('')).toContain('frozen repository');
  });

  it('moves to the next frozen repository when one is down, and stops after the last', async () => {
    const [utah, chemnitz] = historicRepositories('2026');
    const t = fakeTlmgr([fail(ROLLOVER), fail('down'), fail('down'), fail('down'), fail('down')]);
    const r = await remoteTlmgr(t.exec, () => {})(['install', 'x']);
    expect(r.code).toBe(1);
    expect(t.calls.map((c) => c[1])).toEqual(['x', utah, chemnitz, chemnitz, chemnitz]);
  });
});

const MISSING_LOG = [
  'This is LuaHBTeX, Version 1.22.0 (TeX Live 2026)',
  '(./main.tex',
  'LaTeX2e <2025-11-01>',
  '',
  "! LaTeX Error: File `chemfig.sty' not found.",
  '',
  'Type X to quit or <RETURN> to proceed,',
  'or enter new name. (Default extension: sty)',
  '',
  'Enter file name: ',
  '! Emergency stop.',
  '<read *> ',
  '         ',
  'l.2 \\usepackage',
  '               {chemfig}^^M',
  '*** (cannot \\read from terminal in nonstop modes)',
].join('\n');
const SEARCH = 'chemfig:\n\ttexmf-dist/tex/latex/chemfig/chemfig.sty\n';

describe('installMissing', () => {
  it('installs the package that provides a missing file and builds again', async () => {
    const err: string[] = [];
    const t = fakeTlmgr([ok(SEARCH), ok()]);
    let builds = 0;
    const r = await installMissing({
      result: fail('latexmk failed'),
      readLog: () => (builds ? 'no errors' : MISSING_LOG),
      root: '/p',
      tlmgr: t.exec,
      rebuild: async () => {
        builds++;
        return ok();
      },
      stderr: (s) => err.push(s),
    });
    expect(r.code).toBe(0);
    expect(builds).toBe(1);
    expect(t.calls).toEqual([
      ['search', '--global', '--file', '/chemfig.sty'],
      ['install', 'chemfig'],
    ]);
    expect(err.join('')).toContain('Installing chemfig from CTAN');
  });

  it('says why when the TeX Live tree is not writable', async () => {
    const err: string[] = [];
    const t = fakeTlmgr([
      ok(SEARCH),
      fail(
        "tlmgr: You don't have permission to change the installation in any way,\nspecifically, the directory /usr/local/texlive/2026/tlpkg/ is not writable.",
      ),
    ]);
    const r = await installMissing({
      result: fail('latexmk failed'),
      readLog: () => MISSING_LOG,
      root: '/p',
      tlmgr: t.exec,
      rebuild: async () => ok(),
      stderr: (s) => err.push(s),
    });
    expect(r.code).toBe(1);
    expect(err.join('')).toContain('not writable for this user');
  });

  it('does nothing without a log, or when nothing installable is missing', async () => {
    const t = fakeTlmgr([]);
    const args = {
      result: fail('x'),
      root: '/p',
      tlmgr: t.exec,
      rebuild: async () => ok(),
      stderr: () => {},
    };
    expect((await installMissing({ ...args, readLog: () => undefined })).code).toBe(1);
    expect(
      (await installMissing({ ...args, readLog: () => '! Undefined control sequence.' })).code,
    ).toBe(1);
    expect(t.calls).toEqual([]);
  });

  it('stops when tlmgr knows no package for the file', async () => {
    const t = fakeTlmgr([ok('')]);
    let builds = 0;
    await installMissing({
      result: fail('x'),
      readLog: () => MISSING_LOG,
      root: '/p',
      tlmgr: t.exec,
      rebuild: async () => {
        builds++;
        return ok();
      },
      stderr: () => {},
    });
    expect(builds).toBe(0);
    expect(t.calls).toHaveLength(1);
  });
});
