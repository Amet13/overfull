/** Templates compiled into the standalone build, and the npm-tarball symlink repair. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentKit,
  copyTemplate,
  hasEmbeddedTemplate,
  writeEmbeddedTemplate,
} from '../src/templates.js';
import { tempDir } from './helpers.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('embedded templates (standalone build)', () => {
  const tree = {
    'paper/main.tex': b64('\\documentclass{article}\n'),
    'paper/figures/a.txt': b64('figure'),
    'paper/main.log': b64('build output, skipped'),
    'paper/paper.pdf': b64('root PDF, skipped'),
    'paper/AGENTS.md': b64('# agents\n'),
    'paper/.agents/skills/check/SKILL.md': b64('skill'),
    'paper/.claude/skills': { link: '../.agents/skills' },
    'thesis/main.tex': b64('thesis'),
  };

  it('is absent outside the standalone build', () => {
    expect(hasEmbeddedTemplate('paper')).toBe(false);
    const dest = join(tempDir(), 'out');
    writeEmbeddedTemplate('paper', dest);
    expect(existsSync(dest)).toBe(true);
  });

  it('writes one template, skips build outputs and restores the skills symlink', () => {
    vi.stubGlobal('__OVERFULL_TEMPLATES__', tree);
    expect(hasEmbeddedTemplate('paper')).toBe(true);
    expect(hasEmbeddedTemplate('slides')).toBe(false);
    const dest = join(tempDir(), 'paper');
    writeEmbeddedTemplate('paper', dest);
    expect(readFileSync(join(dest, 'main.tex'), 'utf8')).toBe('\\documentclass{article}\n');
    expect(readFileSync(join(dest, 'figures', 'a.txt'), 'utf8')).toBe('figure');
    expect(existsSync(join(dest, 'main.log'))).toBe(false);
    expect(existsSync(join(dest, 'paper.pdf'))).toBe(false);
    const link = join(dest, '.claude', 'skills');
    // Windows reports the target with backslashes (..\.agents\skills); same link.
    if (lstatSync(link).isSymbolicLink())
      expect(readlinkSync(link).replaceAll('\\', '/')).toBe('../.agents/skills');
    expect(readFileSync(join(link, 'check', 'SKILL.md'), 'utf8')).toBe('skill');
    expect(existsSync(join(dest, 'thesis'))).toBe(false);
  });

  it('reads the agent kit from the embedded tree', () => {
    vi.stubGlobal('__OVERFULL_TEMPLATES__', tree);
    expect(agentKit()?.map((f) => f.path)).toEqual(['.agents/skills/check/SKILL.md', 'AGENTS.md']);
  });
});

describe('copyTemplate', () => {
  it('recreates .claude/skills when the npm tarball dropped the symlink', () => {
    const src = tempDir();
    mkdirSync(join(src, '.agents', 'skills', 'cite'), { recursive: true });
    writeFileSync(join(src, '.agents', 'skills', 'cite', 'SKILL.md'), 'cite');
    writeFileSync(join(src, 'main.tex'), 'x');
    writeFileSync(join(src, 'main.aux'), 'build output');
    const dest = join(tempDir(), 'copy');
    copyTemplate(src, dest);
    expect(existsSync(join(dest, 'main.aux'))).toBe(false);
    expect(readFileSync(join(dest, '.claude', 'skills', 'cite', 'SKILL.md'), 'utf8')).toBe('cite');
  });
});
