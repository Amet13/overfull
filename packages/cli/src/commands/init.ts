import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { applyPlan, detectProject, planAdopt } from '../adopt.js';
import { parse, str } from '../args.js';
import { editDistance } from '../config.js';
import { type GitHookResult, installGitHook } from '../guard/settings.js';
import { canAsk, type Io, UsageError } from '../io.js';
import { insideRootForWrite, isDanglingSymlink } from '../safety.js';
import {
  copyTemplate,
  hasEmbeddedTemplate,
  TEMPLATE_NAMES,
  type TemplateName,
  templatesDir,
  writeEmbeddedTemplate,
} from '../templates.js';
import { run, which } from '../tools.js';

/**
 * `git init -b main` in a new project that is not already inside a repository,
 * plus an initial commit when user.name and user.email are configured.
 * Returns a line for the user, or undefined when nothing was done.
 */
async function initGit(
  target: string,
  template: string,
  env: Io['env'],
): Promise<string | undefined> {
  if (!which('git', env)) return undefined;
  const opts = { cwd: target, env, timeoutMs: 20000 };
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], opts);
  if (inside.code === 0) return undefined;
  const init = await run('git', ['init', '-q', '-b', 'main'], opts);
  if (init.code !== 0) return undefined;
  const name = await run('git', ['config', 'user.name'], opts);
  const email = await run('git', ['config', 'user.email'], opts);
  const commitCmd = `git add -A && git commit -m "Start from the overfull ${template} template"`;
  if (name.code !== 0 || !name.stdout.trim() || email.code !== 0 || !email.stdout.trim()) {
    return `Initialized a git repository (branch main). Set user.name/user.email, then commit:\n    ${commitCmd}`;
  }
  const add = await run('git', ['add', '-A'], opts);
  const commit =
    add.code === 0
      ? await run(
          'git',
          ['commit', '-q', '-m', `Start from the overfull ${template} template`],
          opts,
        )
      : add;
  return commit.code === 0
    ? 'Initialized a git repository (branch main) with an initial commit.'
    : `Initialized a git repository (branch main). Commit with:\n    ${commitCmd}`;
}

/** The commented-out `references.mailto` line the templates and `--here` write. */
const MAILTO_LINE = /^([ \t]*)#[ \t]*mailto:.*$/m;
/** A plain address: nothing YAML or a shell would read specially. */
const PLAIN_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const MAILTO_HINT =
  'Tip: set references.mailto in overfull.yml to your e-mail: CrossRef then answers from its faster "polite pool" (see the References guide).';

/** `config` with its commented-out `mailto` line set to `email`, or undefined when it has none. */
export function withMailto(config: string, email: string): string | undefined {
  if (!MAILTO_LINE.test(config)) return undefined;
  return config.replace(MAILTO_LINE, (_m, indent: string) => `${indent}mailto: ${email}`);
}

/**
 * Offers to set `references.mailto` in the overfull.yml just written, from
 * `git config user.email`. Asks when stdin and stdout are terminals and writes only
 * after an explicit yes; anywhere else (or with --yes) nothing is written and a
 * one-line hint is returned. Undefined when the
 * file has no commented-out mailto line (no references check, or already set).
 */
export async function offerMailto(
  configPath: string,
  io: Io,
  ask: (question: string) => Promise<boolean> = io.ask ?? askYesNo,
): Promise<string | undefined> {
  let config: string;
  try {
    config = readFileSync(configPath, 'utf8');
  } catch {
    return undefined;
  }
  if (!MAILTO_LINE.test(config)) return undefined;
  if (!canAsk(io)) return MAILTO_HINT;
  const email = await gitEmail(dirname(configPath), io.env);
  if (!email) return MAILTO_HINT;
  const yes = await ask(
    `Set references.mailto to ${email} (your git user.email)? CrossRef and OpenAlex receive it with each lookup and answer faster.`,
  );
  if (!yes) return MAILTO_HINT;
  writeFileSync(configPath, withMailto(config, email) as string);
  return `Set references.mailto: ${email} in overfull.yml.`;
}

/** `git config user.email` when git is installed and it is a plain address. */
async function gitEmail(cwd: string, env: Io['env']): Promise<string | undefined> {
  if (!which('git', env)) return undefined;
  const res = await run('git', ['config', 'user.email'], { cwd, env, timeoutMs: 5000 });
  const email = res.code === 0 ? res.stdout.trim() : '';
  return PLAIN_EMAIL.test(email) ? email : undefined;
}

const initHelp = `Usage: overfull init [thesis|paper|slides] [dir] [options]
       overfull init --here [options]          (alias: overfull adopt)

Create a new project from a template: accessible LaTeX (LuaLaTeX, tagged PDF),
overfull.yml, Makefile, CI workflow, and AGENTS.md + skills for AI agents.

With --here, add Overfull to the LaTeX project in the current folder instead.
It detects the main file, engine, bibliography and venue style files, writes
overfull.yml, and never creates or changes a .tex or .bib file.

Arguments:
  template        thesis (default), paper or slides
  dir             Target directory (default: ./<template>)

Options:
  --force         Copy into a non-empty directory (existing files are overwritten)
  --yes, -y       Ask nothing and take the defaults (also when not on a terminal)
  --json          Print {template, dir, git} as JSON (with --here: {detected, written, skipped})
  --no-git        Do not run \`git init\` (by default a new project outside a git
                  repository gets \`git init -b main\` and, when user.name and
                  user.email are set, an initial commit)
  -h, --help      Show this help

Options for --here (existing project, current folder):
  --here          Adopt the project in the current folder
  --main <file>   The main .tex file (needed when several files have \\documentclass)
  --agents        Also write AGENTS.md, the pointer files (CLAUDE.md, GEMINI.md,
                  .github/copilot-instructions.md, .cursor/rules/overfull.mdc),
                  .agents/skills/ and the .claude/skills link
  --ci            Also write .github/workflows/preflight.yml
  --make          Also write a Makefile; an existing Makefile is not touched and
                  the lines to add are printed
  --hooks         Also install a git pre-commit hook that blocks hand-written .bib
                  entries (\`overfull guard --staged\`), only if .git/hooks/pre-commit
                  does not exist; otherwise the line to add is printed. With --agents
                  the hook settings for Claude Code and Gemini CLI are written too
                  (merged into an existing .claude/settings.json or .gemini/settings.json).
  --all           --agents --ci --make --hooks
  --force         Overwrite files that exist and differ (never a Makefile)
  --dry-run       Write nothing; print what would be written
On a terminal (stdin and stdout), with none of --agents/--ci/--make/--hooks/--all
and no --yes, agents, ci and make are asked about (default no); anywhere else
only overfull.yml is written, and the output says what was done.
Existing files are never overwritten without --force. Safe to run again.
`;

const adoptHelp = `Usage: overfull adopt [options]

Add Overfull to the LaTeX project in the current folder. Same as
\`overfull init --here\`; see \`overfull init --help\` for the options.
`;

export async function initCommand(args: string[], ioIn: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      force: { type: 'boolean' },
      'no-git': { type: 'boolean' },
      json: { type: 'boolean' },
      here: { type: 'boolean' },
      main: { type: 'string' },
      agents: { type: 'boolean' },
      ci: { type: 'boolean' },
      make: { type: 'boolean' },
      hooks: { type: 'boolean' },
      all: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
    },
    'init',
  );
  // --yes, or no person to answer: no questions, the default answers.
  const io: Io = values.yes === true ? { ...ioIn, stdinIsTTY: false } : ioIn;
  if (values.help) {
    io.stdout(initHelp);
    return 0;
  }
  if (values.here === true) return adoptHere(values, positionals, io);
  for (const flag of ['main', 'agents', 'ci', 'make', 'hooks', 'all', 'dry-run'])
    if (values[flag] !== undefined)
      throw new UsageError(
        `--${flag} works only with --here (adding Overfull to the current folder).`,
      );
  if (positionals.length > 2)
    throw new UsageError(
      `Too many arguments: ${positionals.join(' ')}. Use \`overfull init [thesis|paper|slides] [dir]\`.`,
    );
  let [name, dir] = positionals;
  if (name && !(TEMPLATE_NAMES as readonly string[]).includes(name) && dir === undefined) {
    // A near miss of a template name (`papr`) is a typo, not a folder name.
    const near = closeTemplate(name);
    if (near)
      throw new UsageError(
        `Unknown template "${name}". Did you mean \`${near}\`? To create a thesis in a folder named ${name}, run \`overfull init thesis ${name}\`.`,
      );
    // `overfull init my-thesis` → thesis template into my-thesis
    dir = name;
    name = undefined;
  }
  const template = (name ?? 'thesis') as TemplateName;
  if (!(TEMPLATE_NAMES as readonly string[]).includes(template)) {
    const near = closeTemplate(template);
    throw new UsageError(
      `Unknown template "${template}".${near ? ` Did you mean \`${near}\`?` : ''} Choose ${TEMPLATE_NAMES.join(', ')}.`,
    );
  }
  const embedded = hasEmbeddedTemplate(template);
  const root = embedded ? undefined : templatesDir();
  const src = root ? join(root, template) : undefined;
  if (!embedded && (!src || !existsSync(src)))
    throw new UsageError(`Template "${template}" is not bundled with this overfull install.`);
  const target = resolve(io.cwd, dir ?? template);
  // A target under the current directory must not escape it through a symlink
  // (an untrusted checkout could hold `paper -> ~/.ssh`); a dangling symlink is
  // refused anywhere.
  const rel = relative(io.cwd, target);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    insideRootForWrite(io.cwd, target, 'Target directory');
  else if (isDanglingSymlink(target))
    throw new UsageError(`Target directory "${dir}" is a dangling symlink.`);
  if (existsSync(target) && readdirSync(target).length > 0 && values.force !== true) {
    throw new UsageError(
      `${relative(io.cwd, target) || '.'} is not empty. Choose another directory or pass --force.`,
    );
  }
  if (embedded) writeEmbeddedTemplate(template, target);
  else copyTemplate(src as string, target);
  const gitNote = values['no-git'] === true ? undefined : await initGit(target, template, io.env);
  const shown = relative(io.cwd, target) || '.';
  if (values.json) {
    io.stdout(`${JSON.stringify({ template, dir: shown, git: gitNote ?? null }, null, 2)}\n`);
    return 0;
  }
  const mailtoNote = await offerMailto(join(target, 'overfull.yml'), io);
  const cd = shown === '.' ? '' : `  cd ${shown}\n`;
  io.stdout(
    `Created a ${template} project in ${shown}/\n\n` +
      (gitNote ? `${gitNote}\n\n` : '') +
      (mailtoNote ? `${mailtoNote}\n\n` : '') +
      'Next steps\n' +
      cd +
      '  With an AI agent: open the folder in your agent (Claude Code, Codex, Cursor, Copilot)\n' +
      '    and describe what you want; AGENTS.md tells it how to build, cite and check.\n' +
      '  By hand: edit metadata.tex and main.tex, then run `make build` and `make check`\n' +
      '    (or `overfull build` and `overfull check`). Needs Docker or TeX Live.\n' +
      '  `overfull doctor` shows which tools are available.\n',
  );
  return 0;
}

/**
 * The template name within edit distance 2 of `word` (a typo such as `papr`), if any.
 * A folder name like `my-thesis` is further away and stays a folder name.
 */
function closeTemplate(word: string): string | undefined {
  const scored = TEMPLATE_NAMES.map((t) => ({ t, d: editDistance(word.toLowerCase(), t) }));
  const best = scored.sort((a, b) => a.d - b.d)[0];
  return best && best.d <= 2 ? best.t : undefined;
}

/** Set once stdin has ended: later questions are answered "no" at once. */
let stdinEnded = false;

/**
 * Asks a yes/no question; the default is no. When the input ends before an answer
 * (Ctrl-D, or stdin closed), the answer is no and the command goes on.
 */
export async function askYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  if (stdinEnded && input === process.stdin) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output });
  let answered = false;
  const ended = new Promise<undefined>((done) =>
    rl.once('close', () => {
      if (!answered && input === process.stdin) stdinEnded = true;
      done(undefined);
    }),
  );
  try {
    const answer = await Promise.race([rl.question(`${question} [y/N] `), ended]);
    answered = true;
    if (answer === undefined) {
      // End of input: "no", on a line of its own.
      output.write('no\n');
      return false;
    }
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    answered = true;
    rl.close();
  }
}

/** `overfull init --here`: adds Overfull to the existing project in the current folder. */
async function adoptHere(
  values: Record<string, string | boolean | string[] | undefined>,
  positionals: string[],
  io: Io,
): Promise<number> {
  if (positionals.length > 0)
    throw new UsageError(
      '--here works in the current folder and takes no template or directory. Change into the project folder first.',
    );
  const root = io.cwd;
  const main = str(values.main);
  const detected = detectProject(root, main !== undefined ? { main } : {});
  const all = values.all === true;
  const flagged =
    all ||
    values.agents === true ||
    values.ci === true ||
    values.make === true ||
    values.hooks === true;
  const parts = {
    agents: all || values.agents === true,
    ci: all || values.ci === true,
    make: all || values.make === true,
    hooks: all || values.hooks === true,
  };
  const asking = !flagged && canAsk(io) && values.json !== true;
  if (asking) {
    const ask = io.ask ?? askYesNo;
    io.stdout(
      `Found ${detected.main} (${detected.engine}, ${detected.backend === 'none' ? 'no bibliography' : detected.backend}). overfull.yml will be written.\n`,
    );
    parts.agents = await ask('Add AGENTS.md and skills for AI agents?');
    parts.ci = await ask('Add a GitHub Actions workflow (.github/workflows/preflight.yml)?');
    parts.make = await ask('Add a Makefile with build and check targets?');
  }
  const dryRun = values['dry-run'] === true;
  const plan = planAdopt(detected, parts, root);
  const result = applyPlan(root, plan, detected, { force: values.force === true, dryRun });
  const gitHook: GitHookResult | undefined = parts.hooks ? installGitHook(root, dryRun) : undefined;
  if (gitHook?.status === 'written' || gitHook?.status === 'would-write')
    result.written.push({
      path: relative(root, gitHook.path as string)
        .split('\\')
        .join('/'),
      note: 'git pre-commit hook: blocks hand-written .bib entries',
    });
  if (values.json) {
    io.stdout(
      `${JSON.stringify(
        {
          detected,
          written: result.written,
          skipped: result.skipped,
          dryRun,
          ...(result.makefileLines ? { makefileLines: result.makefileLines } : {}),
          ...(gitHook ? { gitHook } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  const lines: string[] = [];
  lines.push(
    'Detected',
    `  main file      ${detected.main} (${detected.mainHow})`,
    `  job name       ${detected.jobname} (${detected.jobnameHow})`,
    `  engine         ${detected.engine} (${detected.engineHow})`,
    `  bibliography   ${detected.bib.length ? detected.bib.join(', ') : 'none'} (${detected.bibHow})`,
    `  backend        ${detected.backend} (${detected.backendHow})`,
    `  document class ${detected.documentClass ?? 'not found'}`,
    `  profile        ${detected.profile} (${detected.profileHow})`,
    '',
  );
  const verb = dryRun ? 'Would write' : 'Wrote';
  if (result.written.length > 0) {
    lines.push(`${verb}:`);
    for (const w of result.written) lines.push(`  ${w.path}  (${w.note})`);
  } else {
    lines.push('Nothing was written: every file is already there.');
  }
  if (result.skipped.length > 0) {
    lines.push('', 'Skipped:');
    for (const s of result.skipped) lines.push(`  ${s.path}  (${s.reason})`);
  }
  if (result.makefileLines) {
    lines.push('', 'Your Makefile was not changed. To add the check, put these lines in it:', '');
    for (const l of result.makefileLines.trimEnd().split('\n')) lines.push(`  ${l}`);
  }
  if (gitHook?.status === 'no-git')
    lines.push('', 'No git repository here, so no pre-commit hook was installed.');
  else if (gitHook?.line)
    lines.push(
      '',
      gitHook.status === 'exists'
        ? 'A pre-commit hook already exists and was not changed. To block hand-written .bib entries, add this line to it:'
        : 'The git hooks directory is outside this repository, so no pre-commit hook was installed. Add this line to your pre-commit hook:',
      '',
      `  ${gitHook.line}`,
    );
  if (!dryRun && result.written.some((w) => w.path === 'overfull.yml')) {
    const mailtoNote = await offerMailto(join(root, 'overfull.yml'), io);
    if (mailtoNote) lines.push('', mailtoNote);
  }
  if (!flagged && !asking)
    lines.push(
      '',
      `Asked nothing (${values.yes === true ? '--yes' : 'not an interactive terminal'}): AGENTS.md, the CI workflow and the Makefile were not added. Add them with --agents, --ci, --make or --all.`,
    );
  lines.push('', '.tex and .bib files were not touched.');
  if (!dryRun && result.written.length > 0)
    lines.push('Next: `overfull build` (or `latexmk`), then `overfull check`.');
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

/** `overfull adopt`: the same as `overfull init --here`. */
export async function adoptCommand(args: string[], io: Io): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.stdout(adoptHelp);
    return 0;
  }
  return initCommand(['--here', ...args], io);
}
