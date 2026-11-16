import type { CheckStatus, Problem, Report, Severity } from '../types.js';
import {
  checkLine,
  formatLocation,
  nothingCheckedLine,
  sortProblems,
  stripUnsafe,
  tally,
  tallyLine,
} from './shared.js';

const esc = (s: string) => stripUnsafe(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Inline `code` spans; everything else is escaped text. */
const inline = (s: string) =>
  esc(s).replace(/`([^`\n]+)`/g, (_m, code: string) => `<code>${code}</code>`);

const STATUS_WORD: Record<CheckStatus, string> = {
  pass: 'Pass',
  warn: 'To review',
  fail: 'To fix',
  skipped: 'Nothing checked',
};
const CHECK_WORD: Record<CheckStatus, string> = {
  pass: 'pass',
  warn: 'review',
  fail: 'fix',
  skipped: 'skipped',
};
const SEVERITY_WORD: Record<Severity, string> = { error: 'Fix', warning: 'Review', info: 'Note' };

const CSS = `
:root{color-scheme:light dark;--bg:#f6f5f1;--ink:#161a2b;--dim:#5b6274;--line:#d9d6cc;--card:#fff;
--fail:#b3261e;--warn:#8a5a00;--pass:#1e6b3a;--info:#2f5d8a;--code:#ecebe4}
@media (prefers-color-scheme:dark){:root{--bg:#12141c;--ink:#e8e6df;--dim:#9aa1b2;--line:#2b2f3d;
--card:#191c27;--fail:#ff8a80;--warn:#f2c267;--pass:#7fd49b;--info:#8fbfe8;--code:#232735}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.55 ui-serif,Georgia,"Times New Roman",serif}
main{max-width:920px;margin:0 auto;padding:40px 20px 64px}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:baseline;justify-content:space-between;
border-bottom:2px solid var(--ink);padding-bottom:16px}
h1{font-size:28px;line-height:1.2;margin:0;overflow-wrap:anywhere}
.stamp{font:600 13px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;
border:2px solid currentColor;padding:8px 12px;transform:rotate(-2deg)}
.s-fail{color:var(--fail)}.s-warn{color:var(--warn)}.s-pass{color:var(--pass)}.s-skipped{color:var(--dim)}
.meta,.tally{color:var(--dim);font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:12px 0 0}
table{width:100%;border-collapse:collapse;margin:28px 0 8px;font:15px/1.4 ui-sans-serif,system-ui,sans-serif}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;white-space:nowrap}td.st{white-space:nowrap;font-weight:600}
h2{font-size:20px;margin:36px 0 8px}
.p{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--dim);
border-radius:4px;padding:12px 14px;margin:10px 0}
.p.error{border-left-color:var(--fail)}.p.warning{border-left-color:var(--warn)}.p.info{border-left-color:var(--info)}
.p h3{font-size:16px;margin:0;font-weight:600;overflow-wrap:anywhere}
.tag{font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;margin-right:8px}
.error .tag{color:var(--fail)}.warning .tag{color:var(--warn)}.info .tag{color:var(--info)}
.where{color:var(--dim);font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:4px;overflow-wrap:anywhere}
.p p{margin:8px 0 0}code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);
padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}
pre{margin:8px 0 0;padding:10px;background:var(--code);border-radius:4px;overflow:auto;
font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
summary{cursor:pointer;color:var(--dim);font:13px/1.4 ui-sans-serif,system-ui,sans-serif;margin-top:8px}
footer{margin-top:48px;color:var(--dim);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
@media print{body{background:#fff}.p{break-inside:avoid}}
`;

function problemHtml(p: Problem): string {
  const where = formatLocation(p.location);
  const parts = [
    `<h3><span class="tag">${SEVERITY_WORD[p.severity]}</span>${inline(p.message)}</h3>`,
    `<div class="where">${where ? `${esc(where)} · ` : ''}${esc(p.rule)}</div>`,
  ];
  if (p.detail) parts.push(`<p>${inline(p.detail)}</p>`);
  if (p.fix) parts.push(`<p><strong>Fix:</strong> ${inline(p.fix)}</p>`);
  if (p.evidence) {
    parts.push(`<details><summary>Evidence</summary><pre>${esc(p.evidence)}</pre></details>`);
  }
  return `<article class="p ${p.severity}">${parts.join('')}</article>`;
}

/**
 * A self-contained HTML page of the report: no scripts, no external files, light and
 * dark, printable. For sharing with co-authors or attaching to a CI run. Every piece of
 * text from the project or the network is escaped.
 */
export function formatHtml(report: Report): string {
  const target = report.target ?? 'LaTeX project';
  const rows = report.checks
    .map(
      (c) =>
        `<tr><th scope="row">${esc(c.check)}</th><td class="st s-${c.status}">${CHECK_WORD[c.status]}</td><td>${inline(checkLine(c))}</td></tr>`,
    )
    .join('');
  const sections = report.checks
    .filter((c) => c.problems.length > 0)
    .map((c) => `<h2>${esc(c.check)}</h2>${sortProblems(c.problems).map(problemHtml).join('')}`)
    .join('');
  const why = nothingCheckedLine(report);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Overfull report: ${esc(target)}</title>
<style>${CSS}</style></head>
<body><main>
<header><h1>${esc(target)}</h1><div class="stamp s-${report.status}">${STATUS_WORD[report.status]}</div></header>
${why ? `<p class="meta">${inline(why)}</p>` : ''}
<p class="tally">${esc(tallyLine(tally(report)))}</p>
<table><thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Summary</th></tr></thead><tbody>${rows}</tbody></table>
${sections}
<footer>Overfull ${esc(report.version)} · <code>overfull explain &lt;rule&gt;</code> explains a rule.</footer>
</main></body></html>
`;
}
