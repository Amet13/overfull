import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { isTemplateFile, templatesDir } from '../src/templates.js';
import { memIo, tempDir } from './helpers.js';

describe('templates', () => {
  it('skips build outputs but keeps sources and figures', () => {
    expect(isTemplateFile('main.tex')).toBe(true);
    expect(isTemplateFile('figures/plot.pdf')).toBe(true);
    expect(isTemplateFile('.agents/skills/cite/SKILL.md')).toBe(true);
    for (const f of [
      'thesis.pdf',
      'thesis.aux',
      'thesis.log',
      'thesis.synctex.gz',
      'thesis.bcf-SAVE-ERROR',
      'thesis-luamml-mathml.html',
      '.overfull/cache/refs.json',
      'chapters/intro.aux',
    ]) {
      expect(isTemplateFile(f), f).toBe(false);
    }
  });
});

describe('template project files', () => {
  const dir = templatesDir();
  const read = (t: string, f: string) => readFileSync(join(dir as string, t, f), 'utf8');
  it.skipIf(!dir)('ignore only root PDFs, ship the guard and the agent make targets', () => {
    for (const t of ['paper', 'thesis', 'slides']) {
      const ignore = read(t, '.gitignore').split('\n');
      expect(ignore, t).toContain('/*.pdf');
      expect(ignore, t).not.toContain('*.pdf');
      expect(ignore, t).toContain('notes/reviews.md');
      expect(read(t, '.pre-commit-config.yaml')).toContain('entry: overfull guard --staged');
      const make = read(t, 'Makefile');
      for (const target of ['build', 'check', 'cite', 'explain', 'doctor'])
        expect(make, `${t}: ${target}`).toMatch(new RegExp(`\\n${target}: ##`));
      expect(make).toContain('$(RUN_OVERFULL) build');
      expect(make).not.toContain('overfull-tex:dev');
      const wf = read(t, '.github/workflows/preflight.yml');
      expect(wf).toContain('name: preflight');
      expect(wf).toContain('(success() || failure())');
      expect(read(t, 'overfull.yml')).toContain('ghcr.io/amet13/overfull:3-slim');
    }
    const paper = read('paper', '.github/workflows/preflight.yml');
    expect(paper.indexOf('name: Preflight')).toBeLessThan(paper.indexOf('arXiv'));
    expect(paper).toContain('overfull check --profile arxiv');
  });
});

describe('overfull init', () => {
  const haveTemplates = Boolean(
    templatesDir() && existsSync(join(templatesDir() as string, 'thesis', 'main.tex')),
  );

  it.skipIf(!haveTemplates)('copies the thesis template and prints next steps', async () => {
    const cwd = tempDir();
    const io = memIo(cwd);
    expect(await main(['init', 'thesis', 'my-thesis'], io)).toBe(0);
    expect(existsSync(join(cwd, 'my-thesis', 'main.tex'))).toBe(true);
    expect(existsSync(join(cwd, 'my-thesis', 'thesis.log'))).toBe(false);
    expect(io.stdoutText()).toContain('cd my-thesis');
    expect(io.stdoutText()).toContain('With an AI agent');
    expect(io.stdoutText()).toContain('By hand');
  });

  it('refuses a non-empty directory without --force', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'x'));
    writeFileSync(join(cwd, 'x', 'notes.txt'), 'keep');
    const io = memIo(cwd);
    const code = await main(['init', 'paper', 'x'], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toMatch(/x is not empty|not bundled/);
  });

  it('rejects unknown templates', async () => {
    const io = memIo(tempDir());
    expect(await main(['init', 'poster', 'dir'], io)).toBe(2);
    expect(io.stderrText()).toContain('Unknown template "poster"');
  });
});

describe('overfull doctor', () => {
  it('lists tools; exits 1 only when nothing can build', async () => {
    const io = memIo(tempDir());
    const code = await main(['doctor'], io);
    const text = io.stdoutText();
    expect(code).toBe(text.includes('Ready to build.') ? 0 : 1);
    if (code === 1) expect(text).toMatch(/^Cannot build/);
    for (const name of [
      'node',
      'latexmk',
      'docker',
      'pdftoppm',
      'verapdf',
      'latexdiff',
      'api.crossref.org',
      'overfull.yml',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toMatch(/api\.crossref\.org +unreachable/);
  });

  it('marks an invalid config with ✕ and exits 1', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'overfull.yml'), 'mian: x.tex');
    const io = memIo(dir);
    const code = await main(['doctor', '--json'], io);
    const { items, configValid } = JSON.parse(io.stdoutText()) as {
      configValid: boolean;
      items: { name: string; ok: boolean; error?: boolean; detail: string }[];
    };
    expect(code).toBe(1);
    expect(configValid).toBe(false);
    expect(items.find((i) => i.name === 'overfull.yml')).toMatchObject({ ok: false, error: true });
    const human = memIo(dir);
    expect(await main(['doctor'], human)).toBe(1);
    expect(human.stdoutText()).toMatch(/✕ overfull\.yml +overfull\.yml: unknown key `mian`/);
  });

  it('a missing --config file is ✕ and exit 1', async () => {
    const io = memIo(tempDir());
    expect(await main(['doctor', '--config', 'nope.yml'], io)).toBe(1);
    expect(io.stdoutText()).toContain('✕ overfull.yml');
    expect(io.stdoutText()).toContain('Config file not found: nope.yml');
  });

  it('keeps the whole YAML error, with the line it points at (doctor and check)', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'overfull.yml'), 'main: a: b\n');
    const io = memIo(dir);
    expect(await main(['doctor'], io)).toBe(1);
    expect(io.stdoutText()).toMatch(/invalid YAML: .*at line 1, column \d+:\n/);
    expect(io.stdoutText()).toContain('main: a: b');
    const check = memIo(dir);
    expect(await main(['check'], check)).toBe(2);
    expect(check.stderrText()).toMatch(/at line 1, column \d+:\n\nmain: a: b\n +\^/);
  });
});
