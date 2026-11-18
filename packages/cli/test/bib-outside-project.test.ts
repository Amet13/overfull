/** A discovered .bib outside the project is a warning, not an abort. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Report } from '@overfull/core';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { memIo, tempDir } from './helpers.js';

const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

// --- R8: bib outside the project -------------------------------------------------

describe('R8: a discovered .bib outside the project is a warning, not an abort', () => {
  it('\\bibliography{../shared/refs} → bib-outside-project, exit 0', async () => {
    const parent = tempDir();
    mkdirSync(join(parent, 'shared'));
    writeFileSync(join(parent, 'shared', 'refs.bib'), '@misc{s, title={Secret}}\n');
    const dir = join(parent, 'paper');
    mkdirSync(dir);
    writeFileSync(join(dir, 'main.tex'), '\\bibliography{../shared/refs}\n');
    const io = memIo(dir);
    const code = await main(['check', '--offline', '--checks', 'references', '--json'], io);
    expect(code).toBe(0);
    const report = JSON.parse(io.stdoutText()) as Report;
    const p = report.checks[0]?.problems[0];
    expect(p?.rule).toBe('bib-outside-project');
    expect(p?.message).toContain('../shared/refs.bib');
    expect(JSON.stringify(report)).not.toContain('Secret');
  });

  it('an explicit --bib outside is still refused', async () => {
    const parent = tempDir();
    const dir = join(parent, 'paper');
    mkdirSync(dir);
    writeFileSync(join(parent, 'x.bib'), '');
    const io = memIo(dir);
    expect(
      await main(['check', '--offline', '--checks', 'references', '--bib', '../x.bib'], io),
    ).toBe(2);
  });
});
