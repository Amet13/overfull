/**
 * One report renderer for `overfull check` and the GitHub Action, so the two pick
 * formats, the SARIF fallback file and annotation options the same way.
 */
import {
  formatHtml,
  formatJson,
  formatMarkdown,
  formatSarif,
  githubAnnotations,
  type Report,
} from '@overfull/core';
import { sarifFallbackFile } from './check.js';

/** Machine formats `check` can print or write (`--json`, `--write sarif=…`). */
export const REPORT_FORMATS = ['json', 'markdown', 'annotations', 'sarif', 'html'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface RenderOptions {
  /** Project root, for the SARIF fallback file. */
  cwd: string;
  env: Record<string, string | undefined>;
  /** `--config`, for the SARIF fallback file. */
  configPath?: string;
  /** `--main`, for the SARIF fallback file. */
  main?: string;
  /** Path of the project in the repository, for SARIF and annotation file paths. */
  root?: string;
  /** At most this many annotations (GitHub shows 50 per step). */
  annotationLimit?: number;
}

/** The report in one machine format, as the text to print or write. */
export function renderReport(report: Report, format: ReportFormat, opts: RenderOptions): string {
  const root = opts.root ? { root: opts.root } : {};
  switch (format) {
    case 'json':
      return formatJson(report);
    case 'markdown':
      return formatMarkdown(report);
    case 'html':
      return formatHtml(report);
    case 'sarif': {
      // GitHub shows only results with a location: problems without a file point at main.
      const fallbackFile = sarifFallbackFile(opts.cwd, opts.env, opts.configPath, opts.main);
      return formatSarif(report, { ...root, ...(fallbackFile ? { fallbackFile } : {}) });
    }
    case 'annotations': {
      const lines = githubAnnotations(report, {
        ...root,
        ...(opts.annotationLimit ? { limit: opts.annotationLimit } : {}),
      });
      return lines.length ? `${lines.join('\n')}\n` : '';
    }
  }
}
