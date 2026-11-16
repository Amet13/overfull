/** formatHtml: a self-contained page where every piece of project or network text is inert. */
import { describe, expect, it } from 'vitest';
import { formatHtml } from '../src/report/index.js';
import type { Report } from '../src/types.js';

const report = (message: string, evidence?: string): Report => ({
  tool: 'overfull',
  version: '9.9.9',
  target: '<b>paper</b>.pdf',
  status: 'fail',
  checks: [
    {
      check: 'references',
      status: 'fail',
      summary: '1 of 2 references verified',
      problems: [
        {
          rule: 'reference-not-found',
          check: 'references',
          severity: 'error',
          message,
          location: { file: 'refs.bib', line: 3 },
          fix: 'Run `overfull cite <doi>`',
          ...(evidence ? { evidence } : {}),
        },
      ],
    },
  ],
});

describe('formatHtml', () => {
  it('escapes markup and strips control and bidi characters', () => {
    const html = formatHtml(
      report('`x` <img src=x onerror=alert(1)> ‮evil\u0007', '<script>alert(1)</script>\nline 2'),
    );
    expect(html).not.toMatch(/<img|<script|onerror=alert\(1\)>/i);
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;');
    expect(html).toContain('&#60;script&#62;');
    expect(html.includes('\u202e')).toBe(false);
    expect(html.includes('\u0007')).toBe(false);
    expect(html).toContain('<title>Overfull report: &#60;b&#62;paper&#60;/b&#62;.pdf</title>');
    // Backtick spans become <code>, with their content still escaped.
    expect(html).toContain('<code>overfull cite &#60;doi&#62;</code>');
  });

  it('is one page with no scripts or outside files, in light and dark', () => {
    const html = formatHtml(report('Not found'));
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script|<link|src="http/i);
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('refs.bib:3');
  });
});
