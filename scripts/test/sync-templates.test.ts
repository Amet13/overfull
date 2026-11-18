/** scripts/sync-templates.mjs on a small copy of the repository layout. */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../sync-templates.mjs', import.meta.url));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'overfull-sync-'));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  cpSync(script, join(dir, 'scripts', 'sync-templates.mjs'));
  write('templates/a/main.tex', 'x\n');
  write('skills/one/SKILL.md', '# one\n');
  write('shared/agents/AGENTS.md', '# agents\n');
  write('shared/agents/.cursor/rules/overfull.mdc', 'rules\n');
  return dir;
}

function sync(dir: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [join(dir, 'scripts', 'sync-templates.mjs'), ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number; stderr: string };
    return { code: e.status, out: e.stderr };
  }
}

// Windows: the script makes a directory symlink (.claude/skills), which needs extra rights there.
describe.skipIf(process.platform === 'win32')('sync-templates', () => {
  it('copies shared files and skills, then reports no drift', () => {
    const dir = repo();
    expect(sync(dir).code).toBe(0);
    expect(existsSync(join(dir, 'templates/a/AGENTS.md'))).toBe(true);
    expect(existsSync(join(dir, 'templates/a/.agents/skills/one/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, 'shared/agent-files.json'))).toBe(true);
    expect(sync(dir, '--check').code).toBe(0);
  });

  it('deletes the copies of a file removed from shared/agents, and empty folders', () => {
    const dir = repo();
    sync(dir);
    rmSync(join(dir, 'shared/agents/.cursor'), { recursive: true });
    const checked = sync(dir, '--check');
    expect(checked.code).toBe(1);
    expect(checked.out).toContain('extra: templates/a/.cursor/rules/overfull.mdc');
    expect(sync(dir).code).toBe(0);
    expect(existsSync(join(dir, 'templates/a/.cursor'))).toBe(false);
    expect(existsSync(join(dir, 'templates/a/main.tex'))).toBe(true);
    expect(sync(dir, '--check').code).toBe(0);
  });
});
