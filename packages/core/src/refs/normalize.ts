/** Text normalization and similarity used to compare bib entries with index records. */

import { texToPlain } from '../bib/tex.js';

const GREEK_NAMES: Record<string, string> = {
  α: 'alpha',
  β: 'beta',
  γ: 'gamma',
  δ: 'delta',
  ε: 'epsilon',
  ζ: 'zeta',
  η: 'eta',
  θ: 'theta',
  ϑ: 'theta',
  ι: 'iota',
  κ: 'kappa',
  λ: 'lambda',
  μ: 'mu',
  ν: 'nu',
  ξ: 'xi',
  π: 'pi',
  ρ: 'rho',
  σ: 'sigma',
  ς: 'sigma',
  τ: 'tau',
  υ: 'upsilon',
  φ: 'phi',
  ϕ: 'phi',
  χ: 'chi',
  ψ: 'psi',
  ω: 'omega',
};

const FOLD: Record<string, string> = {
  ß: 'ss',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ł: 'l',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  ŋ: 'ng',
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Removes tags (`<i>`, `<sub>`, …) until none is left: one pass can leave a tag behind
 * when tags are nested inside each other (`<<b>i>`).
 */
export function stripTags(s: string): string {
  let out = s;
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/<[^<>]*>/g, '');
  }
  return out;
}

/** The character for a numeric entity, or U+FFFD when the number is not a code point. */
export function codePointText(n: number): string {
  // Out of range (> U+10FFFF) or a lone surrogate half: String.fromCodePoint would throw
  // or produce broken text, and one bad entity must not stop the whole run.
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) {
    return '\uFFFD';
  }
  return String.fromCodePoint(n);
}

/** Decodes `&#x…;` and `&#…;` without throwing on numbers that are not code points. */
export function decodeNumericEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => codePointText(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => codePointText(Number(d)));
}

/** Decodes entities and removes HTML/JATS/MathML tags (CrossRef titles contain `<i>`, `<sub>`…). */
export function stripMarkup(s: string): string {
  // Entities first, so an encoded tag (`&lt;i&gt;`) is removed like a written one.
  const decoded = decodeNumericEntities(s).replace(
    /&([a-z]+);/gi,
    (m, name: string) => ENTITIES[name.toLowerCase()] ?? m,
  );
  return stripTags(decoded).replace(/\s+/g, ' ').trim();
}

/**
 * Folds plain text for comparison: lowercases, strips diacritics and other combining
 * marks (after NFKD), spells out Greek letters and folds a few Latin letters (ß, ø, æ…).
 * Letters of other scripts (Cyrillic, Arabic, CJK…) are kept as they are.
 */
export function foldText(plain: string): string {
  return plain
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[α-ωϑϕς]/g, (c) => ` ${GREEK_NAMES[c] ?? c} `)
    .replace(/[ßøæœłðþıŋ]/g, (c) => FOLD[c] ?? c);
}

/** Scripts written without spaces between words: each character counts as a word. */
const NO_SPACE_SCRIPTS = /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu;

/** Normalized word list for a title written in TeX (bib) or markup (records). */
function titleWords(title: string, isTex = true): string[] {
  const plain = isTex ? texToPlain(title) : stripMarkup(title);
  return foldText(plain)
    .replace(NO_SPACE_SCRIPTS, ' $1 ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * The title normalization used before Unicode letters were kept: ASCII letters and
 * digits only. Provenance hashes written by `overfull cite` until then cover this form.
 */
export function asciiNormalizeTitle(title: string): string {
  return texToPlain(title)
    .toLowerCase()
    .replace(/[α-ωϑϕς]/g, (c) => ` ${GREEK_NAMES[c] ?? c} `)
    .replace(/[ßøæœłðþıŋ]/g, (c) => FOLD[c] ?? c)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalized title string: lowercase words (letters and digits of any script) separated
 * by single spaces. Empty when the title has no letter or digit at all.
 */
export function normalizeTitle(title: string, isTex = true): string {
  return titleWords(title, isTex).join(' ');
}

function dice(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const counts = new Map<string, number>();
  for (const w of a) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of b) {
    const n = counts.get(w) ?? 0;
    if (n > 0) {
      shared++;
      counts.set(w, n - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/** The part of a title before its subtitle separator (`:`, `?`, `.`, ` - `, em dash). */
function mainTitle(plain: string): string {
  const m = /^(.+?)(?:\s*[:?!.]\s+|\s+[-–—]+\s+|\s*—\s*)\S/.exec(plain);
  return m ? (m[1] as string) : plain;
}

/**
 * Title similarity in [0, 1]: Sørensen–Dice on normalized words, plus a
 * subtitle rule — when one title equals the other's main title (the part
 * before `:` etc.) and has at least two words, the score is 0.92.
 * `bibTitle` is TeX; `recordTitle` is plain text/markup from an index.
 */
export function titleSimilarity(bibTitle: string, recordTitle: string): number {
  const a = titleWords(bibTitle, true);
  const b = titleWords(recordTitle, false);
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 1;
  let score = dice(a, b);
  const aMain = titleWords(mainTitle(texToPlain(bibTitle)), false);
  const bMain = titleWords(mainTitle(stripMarkup(recordTitle)), false);
  const subtitleMatch =
    (aMain.length >= 2 && aMain.join(' ') === b.join(' ') && aMain.length < a.length) ||
    (bMain.length >= 2 && bMain.join(' ') === a.join(' ') && bMain.length < b.length);
  if (subtitleMatch) score = Math.max(score, 0.92);
  return score;
}

/** Folded surname for comparison: `Erd{\H{o}}s` → `erdos`, `van der Aalst` → `van der aalst`. */
export function foldName(name: string): string {
  return foldText(stripMarkup(name))
    .replace(/[^\p{L}\s-]+/gu, '')
    .replace(/[\s-]+/g, ' ')
    .trim();
}

const PARTICLES = new Set([
  'van',
  'von',
  'der',
  'den',
  'de',
  'del',
  'della',
  'di',
  'da',
  'du',
  'dos',
  'la',
  'le',
  'ten',
  'ter',
  'jr',
  'sr',
]);

function significant(name: string): string[] {
  return name.split(' ').filter((w) => w.length > 1 && !PARTICLES.has(w));
}

/**
 * Two folded surnames match when the significant words (particles dropped) of
 * one are a subset of the other's: `van der aalst` ~ `aalst`, `garcia marquez` ~ `garcia`.
 */
export function namesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = significant(a);
  const sb = significant(b);
  if (!sa.length || !sb.length) return false;
  const [small, large] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  return small.every((w) => large.includes(w));
}
