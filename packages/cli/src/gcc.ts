import { oneLine, type Problem, type Report, sortedProblems } from '@overfull/core';

/** The severity word a GCC-style line uses (editors read error, warning and note). */
const SEVERITY = { error: 'error', warning: 'warning', info: 'note' } as const;

function gccLine(p: Problem): string {
  const severity = SEVERITY[p.severity];
  const page = p.location?.page && !p.location.file ? `page ${p.location.page}: ` : '';
  const message = `${page}${oneLine(p.message)} [${p.rule}]`;
  const file = p.location?.file;
  // A problem in no file (a PDF page, the whole build) is still printed, but with the
  // program name in place of a file, the way compilers do: editors do not attach it.
  if (!file) return `overfull: ${severity}: ${message}`;
  // GCC lines always have a line and a column: line 1 for a whole-file problem, column 1.
  return `${oneLine(file)}:${p.location?.line ?? 1}:1: ${severity}: ${message}`;
}

/**
 * The report as GCC-style diagnostics, one per line, errors first:
 * `file:line:col: error|warning|note: message [rule]`. Editors and their problem
 * matchers (VS Code tasks, Vim's quickfix, Emacs compile mode) read this format.
 */
export function formatGcc(report: Report): string {
  const lines = sortedProblems(report).map(gccLine);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/** VS Code's own variable (not a JavaScript placeholder): the folder that is open. */
const WORKSPACE = '$' + '{workspaceFolder}';

/** The VS Code task `overfull init --here --vscode` writes: check, problems in the editor. */
export const VSCODE_TASKS = `${JSON.stringify(
  {
    version: '2.0.0',
    tasks: [
      {
        label: 'overfull check',
        type: 'shell',
        command: 'overfull',
        args: ['check', '--gcc'],
        options: { cwd: WORKSPACE },
        group: 'test',
        presentation: { reveal: 'silent', clear: true },
        problemMatcher: {
          owner: 'overfull',
          source: 'overfull',
          fileLocation: ['relative', WORKSPACE],
          pattern: {
            regexp: '^(.+?):(\\d+):(\\d+): (error|warning|note): (.*) \\[([a-z0-9-]+)\\]$',
            file: 1,
            line: 2,
            column: 3,
            severity: 4,
            message: 5,
            code: 6,
          },
        },
      },
    ],
  },
  null,
  2,
)}\n`;
