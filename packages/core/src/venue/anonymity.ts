import type { Problem } from '../types.js';
import { findCommands, grepTex, readGroup, stripComments } from './tex.js';
import type { AnonymizedByClass, TexFile, VenueContext, VenueProfile } from './types.js';

const ANON = /anonym|blind|submission|paper\s*id|author\s*names?\s*(hidden|withheld)/i;

/** Longest macro body kept, and the most expansion rounds, so expansion stays small. */
const MAX_BODY = 2000;
const MAX_ROUNDS = 4;

/**
 * Argument-free macros defined in the sources with `\newcommand`, `\renewcommand`,
 * `\providecommand` (starred or not, with or without braces around the name) or `\def`.
 * Macros with arguments are skipped. Later definitions win.
 */
export function simpleMacros(files: TexFile[]): Map<string, string> {
  const macros = new Map<string, string>();
  const re =
    /\\(?:(?:re)?newcommand|providecommand)\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*(?=\{)|\\[gex]?def\s*\\([A-Za-z@]+)\s*(?=\{)/g;
  for (const f of files) {
    const src = stripComments(f.content);
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const name = m[1] ?? m[2] ?? m[3];
      const group = readGroup(src, m.index + m[0].length);
      if (!name || !group || group.value.length > MAX_BODY) continue;
      macros.set(name, group.value);
      re.lastIndex = group.end;
    }
  }
  return macros;
}

/** Replaces known argument-free macros in `text`, a few rounds deep. */
function expandMacros(text: string, macros: Map<string, string>): string {
  if (!macros.size) return text;
  let out = text;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let changed = false;
    let budget = MAX_BODY * 4;
    out = out.replace(/\\(?:([A-Za-z@]+)|[^])/g, (whole, name?: string) => {
      const body = name === undefined ? undefined : macros.get(name);
      if (body === undefined || body.length > budget) return whole;
      budget -= body.length;
      changed = true;
      return ` ${body} `;
    });
    if (!changed) break;
  }
  return out;
}

/** Option names given to a package or class, without `=false` ones. */
function optionNames(optional: string | undefined): string[] {
  if (!optional) return [];
  return optional
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o && !/=\s*false\s*$/i.test(o))
    .map((o) => o.replace(/\s*=.*$/s, ''));
}

export interface ClassAnonymity {
  /** The class or package is loaded. */
  loaded: boolean;
  /** It is loaded in review mode, so it prints "Anonymous" itself. */
  anonymized: boolean;
  /** Why review mode is off, e.g. "it is loaded with the `final` option". */
  reason?: string;
  /** How to turn review mode on. */
  how?: string;
}

/**
 * Whether the venue class or package named in `rule` hides the authors in these sources.
 * Only `.tex` files count: the venue's own style file defines the commands it looks for.
 */
export function classAnonymity(rule: AnonymizedByClass, sources: TexFile[]): ClassAnonymity {
  const files = sources.filter((f) => /\.tex$/i.test(f.path));
  const loads = findCommands(files, ['documentclass', 'usepackage', 'RequirePackage']).filter(
    (use) =>
      use.arg
        .split(',')
        .map((n) => n.trim())
        .includes(rule.package),
  );
  if (!loads.length) return { loaded: false, anonymized: false };
  const options = new Set(loads.flatMap((use) => optionNames(use.optional)));
  const off = rule.unlessOptions?.find((o) => options.has(o));
  if (off) {
    return {
      loaded: true,
      anonymized: false,
      reason: `it is loaded with the \`${off}\` option`,
      how: 'remove that option',
    };
  }
  if (rule.withOptions && !rule.withOptions.some((o) => options.has(o))) {
    const need = rule.withOptions.map((o) => `\`${o}\``).join(' or ');
    return {
      loaded: true,
      anonymized: false,
      reason: `it is loaded without the ${need} option`,
      how: `add the \`${rule.withOptions[0]}\` option`,
    };
  }
  for (const cmd of rule.unlessCommands ?? []) {
    if (grepTex(files, new RegExp(`\\\\${cmd}(?![A-Za-z@])`)).length) {
      return {
        loaded: true,
        anonymized: false,
        reason: `the source uses \`\\${cmd}\``,
        how: 'remove or comment out that command',
      };
    }
  }
  return { loaded: true, anonymized: true };
}

/** Text of an `\author{...}` argument with commands, markup and separators removed. */
function authorText(arg: string, macros: Map<string, string> = new Map()): string {
  return expandMacros(arg, macros)
    .replace(/\\(and|And|AND|thanks|footnote|email|affil|inst|orcid)\b(\s*\{[^}]*\})?/g, ' ')
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\[A-Za-z@]+\*?/g, ' ')
    .replace(/[{}$^_~&,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function authorFix(profile: VenueProfile | undefined, cls: ClassAnonymity | undefined): string {
  const rule = profile?.anonymizedByClass;
  if (rule && cls?.reason) {
    return `\`${rule.package}\` hides the authors only in review mode, but ${cls.reason}: ${cls.how} for the review version, or use \`\\author{Anonymous}\``;
  }
  return 'Use `\\author{Anonymous}` or the venue class’s review/anonymous option';
}

export function anonymityProblems(ctx: VenueContext, profile?: VenueProfile): Problem[] {
  const problems: Problem[] = [];
  const pdfAuthor = ctx.facts?.info.author ?? ctx.facts?.xmp.creators?.join(', ');
  if (pdfAuthor && !ANON.test(pdfAuthor)) {
    problems.push({
      rule: 'anonymity-pdf-author',
      check: 'venue',
      severity: 'error',
      message: `PDF metadata names the author: "${pdfAuthor}"`,
      fix: 'Set `\\hypersetup{pdfauthor={Anonymous}}` (or remove `pdfauthor`) for the review version',
      data: { author: pdfAuthor },
    });
  }
  const files = ctx.texFiles ?? [];
  const cls = profile?.anonymizedByClass
    ? classAnonymity(profile.anonymizedByClass, files)
    : undefined;
  const authors = cls?.anonymized ? [] : findCommands(files, ['author']);
  const macros = authors.length ? simpleMacros(files) : new Map<string, string>();
  for (const use of authors) {
    const text = authorText(use.arg, macros);
    if (!text || ANON.test(text)) continue;
    if (!/\p{L}{2,}/u.test(text)) continue;
    problems.push({
      rule: 'anonymity-author-named',
      check: 'venue',
      severity: 'error',
      message: `\\author names someone: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`,
      location: { file: use.file, line: use.line },
      fix: authorFix(profile, cls),
    });
  }
  const ack =
    /\\(?:section|chapter|subsection|paragraph|subsubsection)\*?\s*\{\s*Acknowledg|\\begin\{acknowledg|\\acknowledg(?:e)?ments\b/i;
  for (const hit of grepTex(files, ack)) {
    problems.push({
      rule: 'anonymity-acknowledgments',
      check: 'venue',
      severity: 'warning',
      message: 'Acknowledgments section in an anonymous submission',
      location: { file: hit.file, line: hit.line },
      fix: 'Remove or comment out acknowledgments until the camera-ready version',
    });
  }
  const self =
    /\b(?:our|my)\s+(?:previous|prior|earlier|own|recent)\s+(?:work|paper|papers|study|studies|publication|results?)\b/gi;
  for (const hit of grepTex(files, self)) {
    problems.push({
      rule: 'anonymity-self-reference',
      check: 'venue',
      severity: 'info',
      message: `Possible self-identification: "${hit.match}"`,
      location: { file: hit.file, line: hit.line },
      fix: 'Cite your earlier work in the third person ("Smith et al. [3] showed…")',
    });
  }
  return problems;
}
