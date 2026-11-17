/**
 * `overfull init` (new project and --here) offers to set `references.mailto` from
 * `git config user.email`, and writes it only after an explicit yes on a terminal.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderConfig } from '../src/adopt.js';
import { offerMailto, withMailto } from '../src/commands/init.js';
import { main } from '../src/main.js';
import { templatesDir } from '../src/templates.js';
import { memIo, tempCopy, tempDir } from './helpers.js';

/** An environment whose git knows only a fresh global config with this user.email. */
function gitEnv(email?: string): Record<string, string> {
  const home = tempDir();
  const config = join(home, '.gitconfig');
  writeFileSync(config, email ? `[user]\n\temail = ${email}\n` : '');
  return { HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
}

const CONFIG = 'references:\n  # Your e-mail ...\n  # mailto: you@example.org\n  ignore: []\n';

describe('withMailto', () => {
  it('turns the commented-out line into a setting, keeping its indent', () => {
    expect(withMailto(CONFIG, 'ann@example.org')).toBe(
      'references:\n  # Your e-mail ...\n  mailto: ann@example.org\n  ignore: []\n',
    );
    expect(withMailto('references:\n  ignore: []\n', 'ann@example.org')).toBeUndefined();
  });

  it('finds the line in what `init --here` writes', () => {
    const d = { bib: ['refs.bib'] } as unknown as Parameters<typeof renderConfig>[0];
    const text = withMailto(renderConfig(d), 'ann@example.org');
    expect(text).toContain('\n  mailto: ann@example.org\n');
  });
});

describe('offerMailto', () => {
  const setup = () => {
    const dir = tempDir();
    const path = join(dir, 'overfull.yml');
    writeFileSync(path, CONFIG);
    return { dir, path };
  };

  it('writes the git e-mail only after a yes on a terminal', async () => {
    const { dir, path } = setup();
    const io = { ...memIo(dir, gitEnv('ann@example.org')), isTTY: true, stdinIsTTY: true };
    const asked: string[] = [];
    const note = await offerMailto(path, io, async (q) => {
      asked.push(q);
      return true;
    });
    expect(asked[0]).toContain('ann@example.org');
    expect(asked[0]).toContain('CrossRef');
    expect(note).toBe('Set references.mailto: ann@example.org in overfull.yml.');
    expect(readFileSync(path, 'utf8')).toContain('\n  mailto: ann@example.org\n');
  });

  it('writes nothing after a no, and prints the hint', async () => {
    const { dir, path } = setup();
    const io = { ...memIo(dir, gitEnv('ann@example.org')), isTTY: true, stdinIsTTY: true };
    const note = await offerMailto(path, io, async () => false);
    expect(note).toMatch(/^Tip: set references\.mailto/);
    expect(readFileSync(path, 'utf8')).toBe(CONFIG);
  });

  it('never asks, and writes nothing, when not on a terminal', async () => {
    const { dir, path } = setup();
    const io = memIo(dir, gitEnv('ann@example.org'));
    const note = await offerMailto(path, io, async () => {
      throw new Error('must not ask');
    });
    expect(note).toMatch(/^Tip: set references\.mailto/);
    expect(note?.split('\n')).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(CONFIG);
  });

  it('only hints when git has no usable e-mail', async () => {
    for (const email of [undefined, 'not an address', 'a@b.org"; rm']) {
      const { dir, path } = setup();
      const io = { ...memIo(dir, gitEnv(email)), isTTY: true, stdinIsTTY: true };
      const note = await offerMailto(path, io, async () => {
        throw new Error('must not ask');
      });
      expect(note, String(email)).toMatch(/^Tip:/);
      expect(readFileSync(path, 'utf8')).toBe(CONFIG);
    }
  });

  it('says nothing for a config without a mailto line', async () => {
    const dir = tempDir();
    const path = join(dir, 'overfull.yml');
    writeFileSync(path, 'checks: [build, output]\n');
    expect(
      await offerMailto(path, { ...memIo(dir), isTTY: true, stdinIsTTY: true }, async () => true),
    ).toBe(undefined);
  });
});

describe('overfull init', () => {
  const haveTemplates = Boolean(
    templatesDir() && existsSync(join(templatesDir() as string, 'paper', 'main.tex')),
  );

  it.skipIf(!haveTemplates)('prints the hint in a new project and writes no e-mail', async () => {
    const cwd = tempDir();
    const io = memIo(cwd, gitEnv('ann@example.org'));
    expect(await main(['init', 'paper', 'p', '--no-git'], io)).toBe(0);
    expect(io.stdoutText()).toContain('Tip: set references.mailto');
    const yml = readFileSync(join(cwd, 'p', 'overfull.yml'), 'utf8');
    expect(yml).toContain('# mailto: you@example.org');
    expect(yml).not.toContain('ann@example.org');
  });

  it.skipIf(!haveTemplates)('prints nothing extra with --json', async () => {
    const cwd = tempDir();
    const io = memIo(cwd, gitEnv('ann@example.org'));
    expect(await main(['init', 'paper', 'p', '--no-git', '--json'], io)).toBe(0);
    expect(() => JSON.parse(io.stdoutText())).not.toThrow();
  });

  it('prints the hint after --here writes overfull.yml', async () => {
    const dir = tempCopy('project');
    rmSync(join(dir, 'overfull.yml'));
    const io = memIo(dir, gitEnv('ann@example.org'));
    expect(await main(['init', '--here'], io)).toBe(0);
    expect(io.stdoutText()).toContain('Tip: set references.mailto');
    expect(readFileSync(join(dir, 'overfull.yml'), 'utf8')).not.toContain('ann@example.org');
  });
});
