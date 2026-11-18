/**
 * The browser check without the page: files and options in, a report out. No DOM, so
 * the same steps run in a test next to the CLI's runCheck (site/tests/parity.test.ts).
 * check.ts gives it the files the user added and shows what it returns.
 */
import {
  accessibilityCheck,
  analyzeLog,
  type BibEntry,
  CHECK_IDS,
  type CheckId,
  type CheckResult,
  citedKeys,
  extractPdfFacts,
  mergeDuplicateFindings,
  mergeOutput,
  missingKeys,
  type PdfFacts,
  type PdfjsLike,
  type Problem,
  parseBibWithIssues,
  pdfOutputProblems,
  type RefCache,
  type RefResult,
  type RefsOptions,
  type Report,
  refsCheck,
  reportStatus,
  resolveProfile,
  statusOf,
  VERSION,
  venueCheck,
  verifyEntries,
} from '@overfull/core';
import { browserRefHints } from './refs-hints';

export type Kind = 'log' | 'bib' | 'aux' | 'pdf' | 'tex';

export interface Loaded {
  name: string;
  kind: Kind;
  text?: string;
  data?: Uint8Array;
}

export interface BrowserCheckOptions {
  /** Venue profile id (the profile menu). */
  profile: string;
  /** "Verify references online". */
  online: boolean;
  /** The report's target line. */
  target: string;
  /** Loads pdf.js (only called when a PDF is checked). */
  loadPdfjs: () => Promise<PdfjsLike>;
  cache?: RefCache;
  signal?: AbortSignal;
  /** Progress text; `fraction` drives the progress bar (null hides it). */
  onProgress?: (message: string, fraction?: number | null) => void;
  /** Called with true when online lookups start and false when they end (the Stop button). */
  onLookups?: (running: boolean) => void;
  /** False once a newer run has started: this run stops and returns null. */
  isCurrent?: () => boolean;
}

export interface BrowserCheckResult {
  report: Report;
  /** Files with nothing in them; named in a note, not checked. */
  empty: Loaded[];
  /** Why the PDF could not be read, if it could not. */
  pdfError?: string;
}

/** Files with nothing to check in them. */
export function emptyFiles(files: Loaded[]): Loaded[] {
  return files.filter((f) => (f.kind === 'pdf' ? !f.data?.length : !(f.text ?? '').trim()));
}

/** Runs every check the browser can run on the given files. Null when superseded. */
export async function runBrowserCheck(
  files: Loaded[],
  opts: BrowserCheckOptions,
): Promise<BrowserCheckResult | null> {
  const say = opts.onProgress ?? (() => {});
  const current = opts.isCurrent ?? (() => true);
  const signal = opts.signal;
  const results = new Map<CheckId, CheckResult>();
  // An empty file has nothing to check: it is named, not counted as a check.
  const empty = emptyFiles(files);
  const usable = files.filter((f) => !empty.includes(f));
  const logs = usable.filter((f) => f.kind === 'log');
  const bibs = usable.filter((f) => f.kind === 'bib');
  const auxes = usable.filter((f) => f.kind === 'aux');
  const pdfs = usable.filter((f) => f.kind === 'pdf');
  const texes = usable.filter((f) => f.kind === 'tex');
  const profile = resolveProfile(opts.profile);
  let facts: PdfFacts | undefined;
  let pdfError: string | undefined;

  // Build and output, from the log
  if (logs.length) {
    say('Reading the build log…');
    const merged = mergeChecks(logs.map((l) => analyzeLog(l.text ?? '')));
    results.set('build', merged.build);
    results.set('output', merged.output);
  }

  // PDF facts: output (?? in text) and accessibility
  if (pdfs.length) {
    const pdf = pdfs[0] as Loaded;
    say(`Opening ${pdf.name} with pdf.js…`);
    const pdfjs = await opts.loadPdfjs();
    try {
      facts = await extractPdfFacts(pdf.data ?? new Uint8Array(), pdfjs);
    } catch (err) {
      pdfError = `${pdf.name}: This file isn’t a readable PDF (pdf.js: ${err instanceof Error ? err.message : String(err)}).`;
    }
    if (!current()) return null;
  }
  if (facts && pdfs[0]) {
    const pdf = pdfs[0];
    const out = pdfOutputProblems(facts).map((p) => withFile(p, pdf.name));
    const prev = results.get('output');
    // With a log, PDF "??" findings the log already explains are dropped, as in `overfull check`.
    results.set(
      'output',
      prev
        ? mergeOutput(prev, out)
        : {
            check: 'output',
            status: statusOf(out),
            problems: out,
            summary: `${facts.pageCount} page${facts.pageCount === 1 ? '' : 's'} read`,
          },
    );
    results.set(
      'accessibility',
      browserAccessibility(
        accessibilityCheck(facts, { verapdf: null, level: profile.accessibility }),
      ),
    );
  }

  // References
  if (bibs.length || auxes.length) {
    const entries: BibEntry[] = [];
    const issues: { line: number; message: string; key?: string }[] = [];
    for (const b of bibs) {
      const parsed = parseBibWithIssues(b.text ?? '');
      entries.push(...parsed.entries.map((e) => ({ ...e, file: b.name })));
      issues.push(...parsed.issues);
    }
    const cited = [...new Set(auxes.flatMap((a) => citedKeys(a.text ?? '')))];
    const extra = cited.length && bibs.length ? missingKeys(cited, entries) : [];
    const toCheck = cited.length ? entries.filter((e) => cited.includes(e.key)) : entries;
    if (!bibs.length) {
      results.set('references', {
        check: 'references',
        status: 'skipped',
        problems: [],
        skippedReason: `${cited.length} cited keys found; add the .bib file to check them`,
      });
    } else if (opts.online && toCheck.length) {
      opts.onLookups?.(true);
      const refResults: RefResult[] = [];
      const chunk = 3;
      for (let i = 0; i < toCheck.length; i += chunk) {
        if (signal?.aborted) break;
        say(`Looking up references: ${i} of ${toCheck.length} done…`, i / toCheck.length);
        // arXiv and DBLP refuse cross-origin requests from web pages, so
        // only the sources a browser can reach are asked. (Core calls
        // fetch detached from globalThis, so window.fetch needs no wrapper.)
        const refOpts: RefsOptions = {
          sources: ['crossref', 'doi.org', 'openalex'],
          ...(opts.cache ? { cache: opts.cache } : {}),
          ...(signal ? { signal } : {}),
          concurrency: chunk,
          timeoutMs: 12000,
          arxivIntervalMs: 3000,
        };
        const part = await verifyEntries(toCheck.slice(i, i + chunk), refOpts);
        if (!current()) return null;
        refResults.push(...part);
      }
      opts.onLookups?.(false);
      const check = refsCheck(refResults, { entries, issues, bibFile: bibs[0]?.name, extra });
      browserRefHints(check, entries);
      if (signal?.aborted && refResults.length < toCheck.length) {
        check.summary =
          `Stopped after ${refResults.length} of ${toCheck.length} references. ${check.summary ?? ''}`.trim();
      }
      results.set('references', check);
    } else {
      const offline = await verifyEntries(toCheck, { offline: true });
      const check = refsCheck(offline, { entries, issues, bibFile: bibs[0]?.name, extra });
      const note = `Online verification is off: ${toCheck.length} of ${entries.length} entries parsed, none looked up`;
      if (check.status === 'skipped' || offline.every((r) => r.reason === 'offline')) {
        check.skippedReason = note;
        check.summary = note;
        check.status = check.problems.length ? statusOf(check.problems) : 'skipped';
      }
      results.set('references', check);
    }
  }

  // Venue
  if (facts || texes.length || auxes.length) {
    const v = venueCheck(profile, {
      ...(facts ? { facts } : {}),
      ...(auxes.length ? { aux: auxes.map((a) => a.text ?? '').join('\n') } : {}),
      ...(texes.length
        ? { texFiles: texes.map((t) => ({ path: t.name, content: t.text ?? '' })) }
        : {}),
      ...(logs[0]?.text ? { log: logs[0].text } : {}),
    });
    results.set('venue', v);
  }

  const emptyLog = empty.some((f) => f.kind === 'log');
  const reasons: Record<CheckId, string> = {
    build: emptyLog && !logs.length ? 'The build log is empty' : 'No build log supplied',
    output: pdfError
      ? 'No build log, and the PDF could not be read'
      : 'No build log or PDF supplied',
    references: 'No .bib or .aux file supplied',
    accessibility: pdfError ? 'The PDF could not be read' : 'No PDF supplied',
    venue: 'No PDF, .tex or .aux file supplied',
  };
  const checks: CheckResult[] = CHECK_IDS.map(
    (c) =>
      results.get(c) ?? { check: c, status: 'skipped', problems: [], skippedReason: reasons[c] },
  );
  mergeDuplicateFindings(checks);
  const report: Report = {
    tool: 'overfull',
    version: VERSION,
    target: opts.target,
    status: reportStatus(checks),
    checks,
  };
  return { report, empty, ...(pdfError ? { pdfError } : {}) };
}

function withFile(p: Problem, file: string): Problem {
  return { ...p, location: { ...p.location, file: p.location?.file ?? file } };
}

/** Combines the build/output results of several logs into one pair. */
function mergeChecks(parts: { build: CheckResult; output: CheckResult }[]): {
  build: CheckResult;
  output: CheckResult;
} {
  if (parts.length === 1 && parts[0]) return parts[0];
  const merge = (key: 'build' | 'output'): CheckResult => {
    const problems = parts.flatMap((p) => p[key].problems);
    return { check: key, status: statusOf(problems), problems, summary: `${parts.length} logs` };
  };
  return { build: merge('build'), output: merge('output') };
}

/**
 * veraPDF cannot run in a browser, so its absence here is a note, not a
 * problem: full PDF/UA validation is `overfull check`'s job.
 */
function browserAccessibility(result: CheckResult): CheckResult {
  const problems = result.problems.map((p) =>
    p.rule === 'verapdf-not-run'
      ? {
          ...p,
          severity: 'info' as const,
          message:
            'veraPDF does not run in the browser. Full PDF/UA validation runs in `overfull check`.',
        }
      : p,
  );
  const counted = problems.filter((p) => p.severity !== 'info').length;
  return {
    ...result,
    problems,
    status: statusOf(problems),
    summary: counted
      ? `${counted} accessibility problem${counted === 1 ? '' : 's'}`
      : 'Tagged, language and title set',
  };
}
