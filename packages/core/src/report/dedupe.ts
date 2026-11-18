import { outputSummary } from '../log/analyze.js';
import { type CheckResult, type Problem, statusOf } from '../types.js';

/**
 * Removes findings that two checks report about the same thing, so each problem
 * appears once. A cited key with no .bib entry is reported by the log
 * (`undefined-citation`, output) and by the bibliography (`citation-key-missing`,
 * references); the second carries the fix, so the log's copy is dropped. The output
 * check's status and summary are recomputed. Changes `checks` in place.
 */
export function mergeDuplicateFindings(checks: CheckResult[]): CheckResult[] {
  const refs = checks.find((c) => c.check === 'references');
  const output = checks.find((c) => c.check === 'output');
  if (!refs || !output) return checks;
  const missing = new Set(
    refs.problems.filter((p) => p.rule === 'citation-key-missing').map((p) => String(p.data?.key)),
  );
  if (!missing.size) return checks;
  const kept = output.problems.filter(
    (p) => !(p.rule === 'undefined-citation' && missing.has(String(p.data?.key))),
  );
  if (kept.length === output.problems.length) return checks;
  output.problems = kept;
  if (output.status !== 'skipped') {
    output.status = statusOf(kept);
    output.summary = outputSummary(kept);
  }
  return checks;
}

/**
 * Adds the PDF's "??"/"[?]" findings to the output check, except those the log
 * already explains (an undefined reference or citation), to avoid double counting.
 */
export function mergeOutput(output: CheckResult, pdfProblems: Problem[]): CheckResult {
  const has = (re: RegExp) => output.problems.some((p) => re.test(p.rule));
  const extra = pdfProblems.filter((p) =>
    p.rule === 'pdf-unresolved-reference'
      ? !has(/undefined-reference|reference-undefined/)
      : !has(/undefined-citation|citation-undefined/),
  );
  if (extra.length === 0) return output;
  const problems = [...output.problems, ...extra];
  // The log's summary ("No problems found…") no longer describes the merged list.
  return { ...output, status: statusOf(problems), problems, summary: outputSummary(problems) };
}
