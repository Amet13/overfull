import { type Dirent, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatHuman, type RefResult } from '@overfull/core';
import { list, type Parsed, parse, str } from '../args.js';
import { exitCodeFor, runCheck } from '../check.js';
import { loadConfig, locateProject, parseChecks } from '../config.js';
import { type Io, noteProject, progressLine, UsageError, useColor } from '../io.js';
import { REPORT_FORMATS, type ReportFormat, renderReport } from '../report.js';
import { isCI, type ReportTarget, reportTarget, writeReport } from '../safety.js';

const checkHelp = `Usage: overfull check [file...] [options]

Check the built document: build log, PDF output, references, accessibility, venue rules.
Reads <jobname>.log / .pdf / .aux and the .bib files named in overfull.yml.
Without overfull.yml, the main file is main.tex, or the only .tex file here with
a \\documentclass; check says what it assumed.

Files (optional): a .tex file is the main file; .bib, .log, .pdf and .aux files
are the same as --bib, --log, --pdf and --aux. Only .bib files: check references only.
  overfull check paper.tex
  overfull check refs.bib

Options:
  --main file         Main .tex file (default from overfull.yml, else detected)
  --checks a,b        Only these checks (build, output, references, accessibility, venue)
  --profile name      Venue profile: generic, thesis, paper, arxiv, double-blind, or a
                      venue id such as neurips-2026 (an unknown name lists them all)
  --offline           Do not look references up online
  --refresh           Ignore cached reference answers and look everything up again
                      (the new answers are still cached)
  --project-cache     Cache reference answers in .overfull/cache/refs.json instead of
                      your user cache folder (also OVERFULL_REFS_CACHE=project). Never
                      used in CI. references.cache in overfull.yml cannot turn it on.
  --fail-on level     error (default), warning or never
  --json              Print the report as JSON (stable, for agents and scripts)
  --markdown          Print a Markdown summary (GitHub job summary / PR comment)
  --annotations       Print GitHub workflow annotations
  --sarif             Print a SARIF 2.1.0 log (GitHub code scanning upload)
  --html              Print a self-contained HTML page of the report (to share or attach)
  --gcc               Print one line per problem for editors (VS Code tasks, Vim
                      quickfix, Emacs): file:line:col: error|warning|note: message [rule]
  --write fmt=file    Also write the report to a file: json, markdown, annotations, sarif,
                      html or gcc. Repeat it to get several formats from one run, e.g.
                      --write json=report.json --write markdown=summary.md
                      A relative file must stay inside the project and not be a symlink.
  --verbose, -v       Show why and how to fix each problem
  --watch             Check again whenever the log, PDF, .aux or a .bib file changes
                      (references are looked up again only when a .bib changed;
                      otherwise each entry keeps its last answer);
                      stop with Ctrl-C. Human output only.
  --pdf file          PDF to check (default <jobname>.pdf)
  --log file          Build log (default <jobname>.log)
  --aux file          .aux file (default <jobname>.aux)
  --bib a.bib,b.bib   Bibliography files (default from overfull.yml or main.tex)
  --mailto address    Contact address for CrossRef's polite pool
  --no-verapdf        Do not run veraPDF even if installed
  --engine e          Where veraPDF/pdffonts run if not installed: auto (default: the
                      Overfull image when Docker already has it), docker, or local
  --image name        Image for veraPDF/pdffonts (default $OVERFULL_IMAGE, else the
                      Overfull image). build.image in overfull.yml is not used by check:
                      check never runs code chosen by the project.
  --config file       Config file (default overfull.yml)
  -h, --help          Show this help

Exit codes: 0 pass (or warnings without --fail-on warning), 1 fail, 2 usage error.
`;

interface FileArgs {
  main?: string;
  pdf?: string;
  log?: string;
  aux?: string;
  bib: string[];
  onlyBib: boolean;
}

/** Sorts positional files by extension and merges them with the --main/--pdf/--log/--aux/--bib flags. */
function classifyFiles(
  positionals: string[],
  values: Parsed['values'],
  rebase: (p: string) => string = (p) => p,
): FileArgs {
  const out: FileArgs = {
    bib: (list(values.bib) ?? []).map(rebase),
    onlyBib: false,
  };
  for (const k of ['main', 'pdf', 'log', 'aux'] as const) {
    const v = str(values[k]);
    if (v) out[k] = rebase(v);
  }
  const positionalBib: string[] = [];
  let others = 0;
  for (const typed of positionals) {
    const p = rebase(typed);
    const ext = /\.([A-Za-z0-9]+)$/.exec(p)?.[1]?.toLowerCase();
    if (ext === 'bib') {
      positionalBib.push(p);
      continue;
    }
    const key =
      ext === 'tex' ? 'main' : ext === 'pdf' || ext === 'log' || ext === 'aux' ? ext : undefined;
    if (!key)
      throw new UsageError(
        `Cannot check "${typed}": expected a .tex, .bib, .log, .pdf or .aux file.\nRun \`overfull check --help\` for usage.`,
      );
    if (out[key])
      throw new UsageError(
        `Two ${key === 'main' ? 'main .tex' : `.${key}`} files given (${out[key]} and ${p}). Check one at a time.`,
      );
    out[key] = p;
    others++;
  }
  out.bib.push(...positionalBib);
  out.onlyBib =
    positionalBib.length > 0 &&
    others === 0 &&
    !values.main &&
    !values.pdf &&
    !values.log &&
    !values.aux;
  return out;
}

/**
 * `--write format=file` (repeatable): the extra report files one run writes. A
 * file inside the project must not be, or go through, a symlink (`reportTarget`).
 */
function writeTargets(
  value: unknown,
  cwd: string,
  rebase: (p: string) => string = (p) => p,
): { format: ReportFormat; target: ReportTarget }[] {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => {
    const at = item.indexOf('=');
    const format = item.slice(0, at) as ReportFormat;
    const file = item.slice(at + 1);
    if (at < 1 || !file || !REPORT_FORMATS.includes(format)) {
      throw new UsageError(
        `--write takes format=file with format one of ${REPORT_FORMATS.join(', ')}; got "${item}"`,
      );
    }
    return { format, target: reportTarget(cwd, rebase(file), '--write file') };
  });
}

export async function checkCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      checks: { type: 'string' },
      profile: { type: 'string' },
      offline: { type: 'boolean' },
      refresh: { type: 'boolean' },
      'project-cache': { type: 'boolean' },
      'fail-on': { type: 'string' },
      json: { type: 'boolean' },
      markdown: { type: 'boolean' },
      annotations: { type: 'boolean' },
      sarif: { type: 'boolean' },
      html: { type: 'boolean' },
      gcc: { type: 'boolean' },
      write: { type: 'string', multiple: true },
      verbose: { type: 'boolean', short: 'v' },
      watch: { type: 'boolean' },
      main: { type: 'string' },
      pdf: { type: 'string' },
      log: { type: 'string' },
      aux: { type: 'string' },
      bib: { type: 'string' },
      mailto: { type: 'string' },
      'no-verapdf': { type: 'boolean' },
      engine: { type: 'string' },
      image: { type: 'string' },
      config: { type: 'string' },
    },
    'check',
  );
  if (values.help) {
    io.stdout(checkHelp);
    return 0;
  }
  const failOn = str(values['fail-on']) ?? 'error';
  if (!['error', 'warning', 'never'].includes(failOn)) {
    throw new UsageError(`--fail-on must be error, warning or never, got "${failOn}"`);
  }
  const formats = REPORT_FORMATS.filter((f) => values[f]);
  if (formats.length > 1)
    throw new UsageError(
      `Choose one output format, not ${formats.map((f) => `--${f}`).join(' and ')}`,
    );
  const engine = str(values.engine) ?? 'auto';
  if (!['auto', 'local', 'docker'].includes(engine))
    throw new UsageError(`--engine must be auto, local or docker, got "${engine}"`);
  // Run from a subfolder, the project is the folder of the nearest overfull.yml above.
  const location = locateProject(io.cwd, str(values.config));
  const cwd = location.root;
  const files = classifyFiles(positionals, values, location.rebase);
  const checksArg = list(values.checks) ?? (files.onlyBib ? ['references'] : undefined);
  const machine = formats.length > 0;
  const writes = writeTargets(values.write, cwd, location.rebase);
  noteProject(io, location);
  if (values.watch && machine)
    throw new UsageError(
      '--watch prints the human report; leave out --json, --markdown, --annotations, --sarif, --html and --gcc',
    );
  const progress = machine || isCI(io.env) ? undefined : progressLine(io, 'references');
  // check --watch keeps each entry's last answer, so an offline re-run does not forget them.
  const refsMemo = values.watch ? new Map<string, RefResult>() : undefined;
  const runOnce = async (offline: boolean) => {
    const report = await runCheck({
      ...(refsMemo ? { refsMemo } : {}),
      cwd,
      env: io.env,
      ...(io.fetch ? { fetch: io.fetch } : {}),
      ...(str(values.config) ? { config: str(values.config) } : {}),
      ...(checksArg ? { checks: parseChecks(checksArg, '--checks', '--checks') } : {}),
      ...(str(values.profile) ? { profile: str(values.profile) } : {}),
      ...(files.main ? { main: files.main } : {}),
      ...(files.pdf ? { pdf: files.pdf } : {}),
      ...(files.log ? { log: files.log } : {}),
      ...(files.aux ? { aux: files.aux } : {}),
      ...(files.bib.length ? { bib: files.bib } : {}),
      ...(str(values.mailto) ? { mailto: str(values.mailto) } : {}),
      offline,
      ...(values.refresh ? { refresh: true } : {}),
      ...(values['project-cache'] ? { projectCache: true } : {}),
      ...(progress ? { progress } : {}),
      verapdf: values['no-verapdf'] !== true,
      engine: engine as 'auto' | 'local' | 'docker',
      ...(str(values.image) ? { image: str(values.image) } : {}),
    });
    if (!machine && report.assumed?.mainSource === 'default' && report.status === 'skipped') {
      io.stderr(
        `No ${report.assumed.main} here and no other LaTeX document found. Run in the project folder, or name the main file: \`overfull check paper.tex\`.\n`,
      );
    } else if (!machine && report.assumed) {
      const a = report.assumed;
      io.stderr(
        `No overfull.yml: assuming main ${a.main}${a.mainSource === 'detected' ? ' (the only document here)' : ''}, profile ${a.profile}. Run \`overfull init --here\` to save these settings.\n`,
      );
    }
    const configPath = str(values.config);
    const render = (format: ReportFormat): string =>
      renderReport(report, format, {
        cwd,
        env: io.env,
        ...(configPath ? { configPath } : {}),
        ...(files.main ? { main: files.main } : {}),
      });
    for (const w of writes) writeReport(w.target, render(w.format));
    const stdoutFormat = formats[0];
    if (stdoutFormat) io.stdout(render(stdoutFormat));
    else io.stdout(formatHuman(report, { color: useColor(io), verbose: values.verbose === true }));
    return exitCodeFor(report, failOn as 'error' | 'warning' | 'never');
  };
  const offline = values.offline === true;
  if (!values.watch) return runOnce(offline);
  let dirs: string[] = [];
  try {
    const config = loadConfig(cwd, str(values.config), io.env);
    dirs = [config.build.outDir, config.build.auxDir];
  } catch {
    /* runOnce reports a bad config */
  }
  return watch(io, cwd, dirs, runOnce, offline);
}

/**
 * Files whose change starts a new check, as path → "mtime:size". Folders whose name
 * starts with a dot are skipped, except the build folders in `dirs` (relative to
 * `root`, such as a `.build` outDir).
 */
export function watchedState(root: string, dirs: string[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (e.isFile() && WATCHED.test(e.name)) {
        try {
          const st = statSync(p);
          out.set(p, `${st.mtimeMs}:${st.size}`);
        } catch {
          /* vanished between listing and stat: not watched */
        }
      }
    }
  };
  walk(root, 0);
  for (const d of new Set(dirs)) {
    if (d !== '.' && d.split('/').some((part) => part.startsWith('.'))) walk(join(root, d), 0);
  }
  return out;
}

const WATCHED = /\.(?:log|pdf|aux|bcf|bib)$/i;

/** What changed between two states: anything, and whether a .bib file did. */
export function changes(
  before: Map<string, string>,
  after: Map<string, string>,
): { any: boolean; bib: boolean } {
  let any = false;
  let bib = false;
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) === after.get(key)) continue;
    any = true;
    if (/\.bib$/i.test(key)) bib = true;
  }
  return { any, bib };
}

async function watch(
  io: Io,
  root: string,
  dirs: string[],
  runOnce: (offline: boolean) => Promise<number>,
  offline: boolean,
): Promise<number> {
  const intervalMs = Number(io.env.OVERFULL_WATCH_INTERVAL_MS) || 1000;
  // Ctrl-C ends the watch with the last exit code (only the real CLI has no signal).
  let signal = io.signal;
  if (!signal) {
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort());
    signal = stop.signal;
  }
  let code = await runOnce(offline);
  let state = watchedState(root, dirs);
  io.stderr('Watching the log, PDF, .aux and .bib files. Press Ctrl-C to stop.\n');
  while (!signal.aborted) {
    await new Promise<void>((done) => {
      const onAbort = () => {
        clearTimeout(t);
        done();
      };
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        done();
      }, intervalMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    if (signal.aborted) break;
    const next = watchedState(root, dirs);
    const c = changes(state, next);
    state = next;
    if (!c.any) continue;
    io.stderr(`\n— ${new Date().toLocaleTimeString()} —\n`);
    // Reference lookups only when a bibliography changed; otherwise each entry keeps its
    // last answer (refsMemo), and entries never answered are reported as not checked.
    code = await runOnce(offline || !c.bib);
  }
  return code;
}
