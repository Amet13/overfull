/** init and adopt: when to ask, end of input, --yes, and template typos. */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { askYesNo } from '../src/commands/init.js';
import { main } from '../src/main.js';
import { memIo, tempDir } from './helpers.js';

function latexProject(): string {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'paper.tex'),
    '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n',
  );
  return dir;
}

describe('init --here: questions', () => {
  it('stdout a terminal but stdin not: asks nothing, writes overfull.yml and says so', async () => {
    const dir = latexProject();
    const asked: string[] = [];
    const io = {
      ...memIo(dir),
      isTTY: true,
      stdinIsTTY: false,
      ask: async (q: string) => {
        asked.push(q);
        return true;
      },
    };
    expect(await main(['init', '--here'], io)).toBe(0);
    expect(asked).toEqual([]);
    expect(existsSync(join(dir, 'overfull.yml'))).toBe(true);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    expect(io.stdoutText()).toContain('Wrote:');
    expect(io.stdoutText()).toContain('Asked nothing (not an interactive terminal)');
  });

  it('asks when stdin and stdout are terminals; --yes asks nothing', async () => {
    const dir = latexProject();
    const asked: string[] = [];
    const io = {
      ...memIo(dir),
      isTTY: true,
      stdinIsTTY: true,
      ask: async (q: string) => {
        asked.push(q);
        return q.includes('Makefile');
      },
    };
    expect(await main(['adopt'], io)).toBe(0);
    expect(asked).toHaveLength(3);
    expect(existsSync(join(dir, 'Makefile'))).toBe(true);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);

    const again = latexProject();
    const quiet = {
      ...memIo(again),
      isTTY: true,
      stdinIsTTY: true,
      ask: async () => {
        throw new Error('must not ask');
      },
    };
    expect(await main(['init', '--here', '--yes'], quiet)).toBe(0);
    expect(existsSync(join(again, 'overfull.yml'))).toBe(true);
    expect(quiet.stdoutText()).toContain('Asked nothing (--yes)');
  });
});

describe('askYesNo', () => {
  it('reads y/yes as yes and anything else as no', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = askYesNo('Go?', input, output);
    input.write('yes\n');
    expect(await answer).toBe(true);
    const input2 = new PassThrough();
    const answer2 = askYesNo('Go?', input2, new PassThrough());
    input2.write('\n');
    expect(await answer2).toBe(false);
  });

  it('answers no when the input ends before an answer, instead of hanging', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = askYesNo('Go?', input, output);
    input.end();
    expect(await answer).toBe(false);
  });
});

describe('init: template names and arguments', () => {
  it('refuses a near miss of a template name with a suggestion', async () => {
    const dir = tempDir();
    const io = memIo(dir);
    expect(await main(['init', 'papr'], io)).toBe(2);
    expect(io.stderrText()).toContain('Unknown template "papr". Did you mean `paper`?');
    expect(existsSync(join(dir, 'papr'))).toBe(false);
    const two = memIo(dir);
    expect(await main(['init', 'thesys', 'x'], two)).toBe(2);
    expect(two.stderrText()).toContain('Did you mean `thesis`?');
  });

  it('still takes a folder name that is not close to a template', async () => {
    const dir = tempDir();
    const io = memIo(dir);
    expect(await main(['init', 'my-thesis', '--no-git', '--json'], io)).toBe(0);
    expect(JSON.parse(io.stdoutText())).toMatchObject({ template: 'thesis', dir: 'my-thesis' });
  });

  it('rejects extra arguments', async () => {
    const dir = tempDir();
    const io = memIo(dir);
    expect(await main(['init', 'paper', 'a', 'b'], io)).toBe(2);
    expect(io.stderrText()).toContain('Too many arguments');
    expect(existsSync(join(dir, 'a'))).toBe(false);
  });
});
