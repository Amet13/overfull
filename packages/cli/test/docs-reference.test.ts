/**
 * The command reference is written by hand in three places: `overfull --help` (main.ts),
 * docs/guide/cli.md (synopsis and one section per command) and the README's command list.
 * This test compares each of them with every command's real `--help`, so they cannot
 * drift: a command missing from one of them, a flag the command does not have, a flag the
 * reference leaves out, or a different list of choices (`--hook claude|gemini|codex`, the
 * identifiers `cite` takes) fails here. Offline: nothing runs but --help.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { memIo, tempDir } from './helpers.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

async function helpOf(command?: string): Promise<string> {
  const io = memIo(tempDir());
  await main(command ? [command, '--help'] : ['--help'], io);
  return io.stdoutText();
}

/** The commands `overfull --help` lists (an alias such as `adopt` is not listed). */
function commandsOf(top: string): string[] {
  const block = top.split(/^Commands:$/m)[1]?.split(/\n\n/)[0] ?? '';
  return [...new Set([...block.matchAll(/^ {2}([a-z]+)\b/gm)].map((m) => m[1] as string))];
}

const FLAG = /(?<![\w-])(--?[a-z][a-z0-9-]*)/g;
const flagsIn = (s: string) =>
  [...s.matchAll(FLAG)].map((m) => m[1] as string).filter((f) => f !== '-h' && f !== '--help');

/** The flags a command's --help offers: usage lines and option lines. */
function helpFlags(help: string): Set<string> {
  const out = new Set<string>();
  for (const line of help.split('\n')) {
    if (/^\s*(Usage:|overfull )/.test(line)) for (const f of flagsIn(line)) out.add(f);
    // An option line: the flag (and its short form) at the start, then two spaces.
    const m =
      /^\s*(--?[a-z][a-z0-9-]*)(?:,\s*(--?[a-z][a-z0-9-]*))?(?:\s+[^\s-][^\s]*)?\s{2,}/.exec(line);
    if (m) for (const f of [m[1], m[2]]) if (f && f !== '-h' && f !== '--help') out.add(f);
  }
  return out;
}

/** The `a|b|c` choices and `<…>` operands in a command's usage lines. */
function usageChoices(help: string): string[] {
  const usage = help.split('\n').filter((l) => /^\s*(Usage:|overfull )/.test(l));
  return usage.flatMap((l) =>
    [...l.matchAll(/(<[^>]+>|\[[a-z]+(?:\|[a-z]+)+\])/g)].map((m) => m[1] as string),
  );
}

const cli = read('docs/guide/cli.md');

/** The `overfull …` lines of the synopsis at the top of cli.md, by command. */
function synopsis(): Map<string, string> {
  const block = /```text\n([\s\S]*?)```/.exec(cli)?.[1] ?? '';
  const out = new Map<string, string>();
  let current = '';
  for (const line of block.split('\n')) {
    const m = /^overfull ([a-z]+)\b/.exec(line);
    if (m) current = m[1] as string;
    if (current) out.set(current, `${out.get(current) ?? ''}${line}\n`);
  }
  return out;
}

/** The `## <command>` section of cli.md. */
function section(command: string): string {
  return cli.split(new RegExp(`^## ${command}$`, 'm'))[1]?.split(/^## /m)[0] ?? '';
}

/** The flags in the first column of a section's tables. */
function tableFlags(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('| `-'))
    .flatMap((l) => flagsIn(l.split(/(?<!\\)\|/)[1] ?? ''));
}

/** The `overfull …` lines in the README's "Commands" block. */
function readmeCommands(): Map<string, string> {
  const readme = read('README.md');
  const block = /## Commands\n+```text\n([\s\S]*?)```/.exec(readme)?.[1] ?? '';
  const out = new Map<string, string>();
  for (const line of block.split('\n')) {
    const m = /^overfull ([a-z]+)\b/.exec(line);
    if (m) out.set(m[1] as string, `${out.get(m[1] as string) ?? ''}${line}\n`);
  }
  return out;
}

describe('the command reference matches each command --help', async () => {
  const top = await helpOf();
  const commands = commandsOf(top);
  const helps = new Map<string, string>();
  for (const c of commands) helps.set(c, await helpOf(c));
  const syn = synopsis();
  const readme = readmeCommands();

  it('finds the commands', () => {
    expect(commands).toEqual(expect.arrayContaining(['init', 'check', 'cite', 'guard', 'mcp']));
  });

  it('cli.md has a synopsis line and a section for every command, and nothing else', () => {
    expect([...syn.keys()].sort()).toEqual([...commands].sort());
    const sections = [...cli.matchAll(/^## ([a-z]+)$/gm)].map((m) => m[1]);
    expect(commands.filter((c) => !sections.includes(c))).toEqual([]);
  });

  it('cli.md names every flag of every command, and only real flags', () => {
    const wrong: string[] = [];
    for (const c of commands) {
      const real = helpFlags(helps.get(c) as string);
      const syno = new Set(flagsIn(syn.get(c) ?? ''));
      const body = section(c);
      for (const f of real) {
        // A short alias (`-v` for `--verbose`) need not be in the synopsis.
        if (!syno.has(f) && f.startsWith('--')) wrong.push(`synopsis of ${c} lacks ${f}`);
        if (!new RegExp(`(?<![\\w-])${f}(?![\\w-])`).test(body))
          wrong.push(`## ${c} does not mention ${f}`);
      }
      for (const f of syno) if (!real.has(f)) wrong.push(`synopsis of ${c} has no-such ${f}`);
      for (const f of tableFlags(body))
        if (!real.has(f)) wrong.push(`## ${c} table has no-such ${f}`);
    }
    expect(wrong).toEqual([]);
  });

  it('cli.md and the README list the same choices and operands as --help', () => {
    const wrong: string[] = [];
    for (const c of commands) {
      for (const choice of usageChoices(helps.get(c) as string)) {
        if (!(syn.get(c) ?? '').includes(choice)) wrong.push(`cli.md synopsis of ${c}: ${choice}`);
        const escaped = choice.replace(/\|/g, '\\|');
        const body = section(c);
        if (choice.startsWith('[') && !body.includes(escaped) && !body.includes(choice))
          wrong.push(`## ${c}: ${choice}`);
        const line = readme.get(c) ?? '';
        if (choice.startsWith('<') && line && !line.includes(choice))
          wrong.push(`README ${c}: ${choice}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('overfull --help shows the same operands as each command', () => {
    const wrong: string[] = [];
    for (const c of commands) {
      const lines = top.split('\n').filter((l) => new RegExp(`^ {2}${c}\\b`).test(l));
      for (const operand of usageChoices(helps.get(c) as string).filter((o) => o.startsWith('<'))) {
        if (!lines.some((l) => l.includes(operand))) wrong.push(`${c}: ${operand}`);
      }
      for (const l of lines)
        for (const f of flagsIn(l.replace(/\s{2,}\S.*$/, '')))
          if (!helpFlags(helps.get(c) as string).has(f)) wrong.push(`${c}: no-such ${f}`);
    }
    expect(wrong).toEqual([]);
  });

  it('the README lists every command with real flags', () => {
    const wrong: string[] = [];
    for (const c of commands) {
      const line = readme.get(c);
      if (!line) {
        wrong.push(`README lacks ${c}`);
        continue;
      }
      for (const f of flagsIn(line.replace(/\s{2,}\S.*$/gm, '')))
        if (!helpFlags(helps.get(c) as string).has(f)) wrong.push(`README ${c}: no-such ${f}`);
    }
    expect(wrong).toEqual([]);
  });

  it('claims --json only for commands that have it', () => {
    const without = commands.filter((c) => !helpFlags(helps.get(c) as string).has('--json'));
    expect(without.length).toBeGreaterThan(0);
    const claims = [cli, read('README.md')].flatMap(
      (t) => t.match(/every command (takes|prints)[^.,]*--json/gi) ?? [],
    );
    expect(claims).toEqual([]);
    // The JSON output table names each command that has --json.
    const table = cli.split(/^## JSON output$/m)[1]?.split(/^```/m)[0] ?? '';
    const listed = commands.filter((c) => c !== 'build' && !without.includes(c));
    expect(listed.filter((c) => !table.includes(`\`${c}`))).toEqual([]);
  });
});
