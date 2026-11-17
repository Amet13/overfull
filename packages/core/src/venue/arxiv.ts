import type { Problem } from '../types.js';
import { ARXIV_TEXLIVE, bblFormatVersion } from './arxiv-texlive.js';
import { type CommandUse, findCommands, grepTex } from './tex.js';
import type { VenueContext } from './types.js';

const PATH_COMMANDS = [
  'includegraphics',
  'input',
  'include',
  'addbibresource',
  'bibliography',
  'subfile',
  'includepdf',
  'lstinputlisting',
  'inputminted',
];

/** Detects the TeX engine from the first line of a log ("This is pdfTeX, ..."). */
export function detectEngine(
  log: string | undefined,
): 'pdflatex' | 'lualatex' | 'xelatex' | undefined {
  if (!log) return undefined;
  const head = log.slice(0, 400);
  if (/This is LuaH?B?TeX|This is LuaTeX/i.test(head)) return 'lualatex';
  if (/This is XeTeX/i.test(head)) return 'xelatex';
  if (/This is pdfTeX|This is e-pTeX/i.test(head)) return 'pdflatex';
  return undefined;
}

function isAbsolute(p: string): boolean {
  return /^(\/|~[/\\]|[A-Za-z]:[\\/]|\\\\)/.test(p.trim());
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

/** `dir` + `rel` with `./` and `../` resolved, forward slashes. */
function joinPath(dir: string, rel: string): string {
  const out: string[] = [];
  for (const part of `${dir}${rel}`.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** Project-relative .bib files the sources name (`\bibliography{a,b}`, `\addbibresource{a.bib}`). */
function bibFiles(uses: CommandUse[], main: string): string[] {
  const out: string[] = [];
  for (const use of uses) {
    if (use.name === 'addbibresource') {
      const arg = use.arg.trim();
      if (/location\s*=\s*remote/.test(use.optional ?? '') || /^[a-z]+:\/\//i.test(arg)) continue;
      if (arg && !isAbsolute(arg)) out.push(joinPath(dirname(main), arg));
    } else if (use.name === 'bibliography') {
      for (const raw of use.arg.split(',')) {
        const name = raw.trim();
        if (!name || isAbsolute(name)) continue;
        out.push(joinPath(dirname(main), /\.bib$/i.test(name) ? name : `${name}.bib`));
      }
    }
  }
  return [...new Set(out)];
}

/** arxiv-bbl-version: a shipped biblatex .bbl must be in a format arXiv's TeX Live reads. */
function bblVersionProblems(bbl: { path: string; text: string }): Problem[] {
  const format = bblFormatVersion(bbl.text);
  if (!format) return [];
  const { versions, defaultYear } = ARXIV_TEXLIVE;
  const current = versions.find((v) => v.year === defaultYear);
  if (!current || current.bblFormats.includes(format)) return [];
  const older = versions.find((v) => v.bblFormats.includes(format));
  const supported = `TeX Live ${current.year}, the default, reads format ${current.bblFormats.join(' or ')}`;
  return [
    {
      rule: 'arxiv-bbl-version',
      check: 'venue',
      severity: 'warning',
      message: older
        ? `${bbl.path} has biblatex .bbl format ${format}; on arXiv only TeX Live ${older.year} reads it (${supported})`
        : `${bbl.path} has biblatex .bbl format ${format}, which arXiv cannot read (${supported})`,
      location: { file: bbl.path },
      fix: `Upload the .bib files without the .bbl, so arXiv runs Biber or BibTeX itself, or build the .bbl with TeX Live ${current.year} (biblatex ${current.biblatex}, Biber ${current.biber})${older ? `, or choose TeX Live ${older.year} when you submit` : ''}`,
      data: {
        format,
        arxivFormats: current.bblFormats,
        texLive: current.year,
        source: ARXIV_TEXLIVE.source[0],
        checkedOn: ARXIV_TEXLIVE.checkedOn,
      },
    },
  ];
}

export function arxivProblems(ctx: VenueContext): Problem[] {
  const problems: Problem[] = [];
  const files = ctx.texFiles ?? [];
  const uses = findCommands(files, PATH_COMMANDS);
  for (const use of uses) {
    for (const p of use.arg.split(',')) {
      if (!isAbsolute(p)) continue;
      problems.push({
        rule: 'arxiv-absolute-path',
        check: 'venue',
        severity: 'error',
        message: `Absolute path in \\${use.name}: ${p.trim()}`,
        location: { file: use.file, line: use.line },
        fix: 'Use a path relative to the main file (arXiv only has your uploaded files)',
      });
    }
    if (/\s/.test(use.arg.trim()) && use.name !== 'bibliography') {
      problems.push({
        rule: 'arxiv-filename-space',
        check: 'venue',
        severity: 'warning',
        message: `File name with a space in \\${use.name}: ${use.arg.trim()}`,
        location: { file: use.file, line: use.line },
        fix: 'Rename the file without spaces (use - or _)',
      });
    }
  }
  const engine = detectEngine(ctx.log);
  if (engine === 'lualatex') {
    problems.push({
      rule: 'arxiv-unsupported-engine',
      check: 'venue',
      severity: 'error',
      message:
        'This build used LuaLaTeX, which arXiv does not offer (it compiles with pdfLaTeX or XeLaTeX)',
      fix: 'Build with pdfLaTeX (`latexmk -pdf`) or XeLaTeX (`latexmk -xelatex`) and check that log with `--log`',
      data: { engine },
    });
  }
  for (const use of uses.filter(
    (u) => u.name === 'includegraphics' && /\.e?ps$/i.test(u.arg.trim()),
  )) {
    problems.push({
      rule: 'arxiv-eps-pdflatex',
      check: 'venue',
      severity: 'warning',
      message: `EPS figure (arXiv compiles with pdfLaTeX, which cannot include it): ${use.arg.trim()}`,
      location: { file: use.file, line: use.line },
      fix: 'Convert to PDF (`epstopdf figure.eps`) and include the .pdf; arXiv’s pdfLaTeX will not convert it',
    });
  }
  const shell =
    /\\usepackage(\[[^\]]*\])?\{[^}]*\b(minted|pythontex|svg|gnuplottex|shellesc)\b[^}]*\}|\\write18|\\ShellEscape|\\immediate\\write18/g;
  for (const hit of grepTex(files, shell)) {
    problems.push({
      rule: 'arxiv-shell-escape',
      check: 'venue',
      severity: 'warning',
      message: `Needs shell escape, which arXiv does not allow: ${hit.match.slice(0, 60)}`,
      location: { file: hit.file, line: hit.line },
      fix: 'Use `listings` instead of `minted`, or pre-generate the output (minted: `frozencache`) and upload it',
    });
  }
  if (ctx.main && ctx.files) {
    for (const f of ctx.files.filter((f) => /\s/.test(f) && !f.startsWith('.'))) {
      problems.push({
        rule: 'arxiv-filename-space',
        check: 'venue',
        severity: 'warning',
        message: `File name with a space: ${f}`,
        location: { file: f },
        fix: 'Rename the file without spaces (use - or _)',
      });
    }
    // arXiv uses an uploaded `<main>.bbl`; without one it runs BibTeX, or the backend
    // biblatex selects (Biber), on the uploaded .bib files, and blocks the submission when
    // a .bib file is missing.
    const has = (f: string) => ctx.files?.some((x) => x.toLowerCase() === f.toLowerCase());
    const stem = ctx.main.replace(/\.tex$/i, '');
    const expected = `${stem}.bbl`;
    const bibs = bibFiles(uses, ctx.main);
    const usesBib = uses.some((u) => u.name === 'addbibresource' || u.name === 'bibliography');
    const missingBibs = bibs.filter((b) => !has(b));
    if (usesBib && !has(expected) && (missingBibs.length > 0 || bibs.length === 0)) {
      const other = ctx.files.find(
        (f) => f.toLowerCase().endsWith('.bbl') && dirname(f) === dirname(ctx.main ?? ''),
      );
      const bibText = missingBibs.length ? missingBibs.join(', ') : 'the .bib file';
      problems.push({
        rule: 'arxiv-missing-bbl',
        check: 'venue',
        severity: 'warning',
        message: other
          ? `Found ${other}, but arXiv reads ${expected} (named like ${ctx.main}), and ${bibText} is not in the project`
          : `Neither ${expected} nor ${bibText} is in the project; arXiv needs one of them to build the bibliography`,
        fix: other
          ? `Copy ${other} to ${expected}, or add ${bibText} to the upload so arXiv builds the bibliography itself`
          : `Add ${bibText} to the project (arXiv runs BibTeX or Biber on it), or upload the ${expected} your build made`,
        data: {
          expected,
          ...(missingBibs.length ? { missingBibs } : {}),
          ...(other ? { found: other } : {}),
        },
      });
    }
    if (ctx.bbl && ctx.bbl.path.toLowerCase() === expected.toLowerCase()) {
      problems.push(...bblVersionProblems(ctx.bbl));
    }
  }
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.rule}|${p.location?.file}|${p.location?.line}|${p.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
