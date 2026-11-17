/** `overfull guard --hook`: payload fixtures per harness, fail-open behaviour, settings wiring. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { guardCommand } from '../src/commands/guard.js';
import { onlyRemovesEntries } from '../src/guard/entries.js';
import { decide, detectHarness, MAX_PAYLOAD_BYTES, runHook } from '../src/guard/hook.js';
import { mergeHookSettings } from '../src/guard/settings.js';
import { main } from '../src/main.js';
import { memIo, tempDir } from './helpers.js';

const BIB = `@article{doe2020,
  title = {A Real Title},
  author = {Doe, Jane},
  year = {2020},
}

@book{roe2019,
  title = {Another Book},
  author = {Roe, Rick},
  year = {2019},
}
`;

// The fixtures name /work/paper; tests run them against a real project folder.
let project = '';
beforeAll(() => {
  project = tempDir();
  writeFileSync(join(project, 'overfull.yml'), 'main: main.tex\n');
  writeFileSync(join(project, 'references.bib'), BIB);
  mkdirSync(join(project, 'refs'));
  writeFileSync(join(project, 'refs', 'Library.BIB'), BIB);
});

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/guard/${name}`, import.meta.url), 'utf8').replaceAll(
    '/work/paper',
    project,
  );
const repo = fileURLToPath(new URL('../../../', import.meta.url));

async function hook(args: string[], stdin: string) {
  const io = memIo(project);
  const code = await guardCommand(['--hook', ...args], io, async () => stdin);
  return { code, out: io.stdoutText(), err: io.stderrText() };
}

describe('guard --hook, Claude Code', () => {
  const denied = [
    'claude-write-bib.json',
    'claude-edit-bib.json',
    'claude-edit-bib-relative.json',
    'claude-multiedit-bib.json',
  ];
  for (const name of denied) {
    it(`denies ${name} in the documented PreToolUse format`, async () => {
      for (const args of [[], ['claude']]) {
        const r = await hook(args, fixture(name));
        expect(r.code).toBe(0);
        const out = JSON.parse(r.out);
        expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(out.hookSpecificOutput.permissionDecisionReason).toContain('overfull cite');
        // The payload's content is never echoed back.
        expect(r.out).not.toContain('Invented');
      }
    });
  }

  const allowed = [
    'claude-edit-tex.json',
    'claude-read-bib.json',
    'claude-bash-bib.json',
    'claude-write-bib-lookalike.json',
    'claude-malformed.json',
    'claude-wrong-types.json',
  ];
  for (const name of allowed) {
    it(`allows ${name} (exit 0, no output)`, async () => {
      for (const args of [[], ['claude']]) {
        const r = await hook(args, fixture(name));
        expect(r).toEqual({ code: 0, out: '', err: '' });
      }
    });
  }
});

describe('guard --hook, Gemini CLI', () => {
  for (const name of ['gemini-write-file-bib.json', 'gemini-replace-bib.json']) {
    it(`denies ${name} in the documented BeforeTool format`, async () => {
      for (const args of [[], ['gemini']]) {
        const r = await hook(args, fixture(name));
        expect(r.code).toBe(0);
        const out = JSON.parse(r.out);
        expect(out.decision).toBe('deny');
        expect(out.reason).toContain('overfull cite');
        expect(r.out).not.toContain('Invented');
      }
    });
  }
  for (const name of [
    'gemini-write-file-tex.json',
    'gemini-read-bib.json',
    'gemini-malformed.json',
  ]) {
    it(`allows ${name}`, async () => {
      expect(await hook([], fixture(name))).toEqual({ code: 0, out: '', err: '' });
    });
  }
  it('a Gemini payload is not denied by the claude adapter, and the reverse', async () => {
    expect((await hook(['claude'], fixture('gemini-write-file-bib.json'))).out).toBe('');
    expect((await hook(['gemini'], fixture('claude-write-bib.json'))).out).toBe('');
  });
});

describe('guard --hook, general', () => {
  it('detects the harness from the payload', () => {
    expect(detectHarness(JSON.parse(fixture('claude-write-bib.json')))).toBe('claude');
    expect(detectHarness(JSON.parse(fixture('gemini-write-file-bib.json')))).toBe('gemini');
    expect(detectHarness(null)).toBeUndefined();
    expect(detectHarness([])).toBeUndefined();
    expect(detectHarness({ tool_name: 'Frobnicate' })).toBeUndefined();
  });

  it('resolves relative paths against the payload cwd, and the extension in any case', () => {
    const p = (file_path: string, cwd = project) =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        cwd,
        tool_input: { file_path },
      });
    expect(runHook(p('a.BiB'), undefined, '/').decision.allow).toBe(false);
    expect(runHook(p('a.bib.tex'), undefined, '/').decision.allow).toBe(true);
    expect(runHook(p('.bib'), undefined, '/').decision.allow).toBe(true);
    expect(runHook(p('x\0.bib'), undefined, '/').decision.allow).toBe(true);
    expect(runHook(p(''), undefined, '/').decision.allow).toBe(true);
  });

  it('allows everything that is not understood', async () => {
    for (const text of ['', 'null', '[]', '"x"', '42', '{}', '{"tool_name":7}', 'x'.repeat(50)]) {
      expect(await hook([], text)).toEqual({ code: 0, out: '', err: '' });
    }
    const huge = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/a/b.bib', content: 'x'.repeat(MAX_PAYLOAD_BYTES) },
    });
    expect((await hook([], huge)).out).toBe('');
  });

  it('allows when reading stdin fails', async () => {
    const io = memIo('/work');
    const code = await guardCommand(['--hook'], io, async () => {
      throw new Error('stdin closed');
    });
    expect(code).toBe(0);
    expect(io.stdoutText()).toBe('');
  });

  it('rejects an unknown harness name and a missing mode', async () => {
    expect(await main(['guard', '--hook', 'vim'], memIo('/work'))).toBe(2);
    expect(await main(['guard'], memIo('/work'))).toBe(2);
    expect(await main(['guard', '--staged', '--hook'], memIo('/work'))).toBe(2);
  });

  it('has help that names both modes and the shell limitation', async () => {
    const io = memIo('/work');
    expect(await main(['guard', '--help'], io)).toBe(0);
    expect(io.stdoutText()).toContain('--staged');
    expect(io.stdoutText()).toContain('--hook');
    expect(io.stdoutText()).toContain('shell command');
    const top = memIo('/work');
    await main(['--help'], top);
    expect(top.stdoutText()).toContain('guard --staged | --hook');
  });
});

describe('hook settings files', () => {
  const claude = readFileSync(join(repo, 'shared/agents/.claude/settings.json'), 'utf8');
  const gemini = readFileSync(join(repo, 'shared/agents/.gemini/settings.json'), 'utf8');

  it('call overfull guard --hook, and say so when overfull is not installed', () => {
    const c = JSON.parse(claude).hooks.PreToolUse[0];
    expect(c.matcher).toBe('Write|Edit|MultiEdit');
    expect(c.hooks[0].command).toContain('command -v overfull');
    expect(c.hooks[0].command).toContain('overfull guard --hook claude');
    // Without overfull: a notice (JSON systemMessage) for a .bib write in an Overfull project.
    expect(c.hooks[0].command).toContain('[ -f overfull.yml ]');
    expect(c.hooks[0].command).toContain('systemMessage');
    expect(c.hooks[0].command).toMatch(/; fi$/);
    const g = JSON.parse(gemini).hooks.BeforeTool[0];
    expect(g.matcher).toBe('write_file|replace');
    expect(g.hooks[0].command).toContain('overfull guard --hook gemini');
  });

  it('the plugin manifest carries the same hook as the Claude settings', () => {
    const plugin = JSON.parse(readFileSync(join(repo, '.claude-plugin/plugin.json'), 'utf8'));
    expect(plugin.hooks).toEqual(JSON.parse(claude).hooks);
  });

  it('merging keeps other keys and other hooks, and is idempotent', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash(make:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'true' }] }],
      },
    });
    const first = mergeHookSettings(existing, claude);
    expect(first.error).toBeUndefined();
    const merged = JSON.parse(first.text as string);
    expect(merged.permissions).toEqual({ allow: ['Bash(make:*)'] });
    expect(merged.hooks.Stop).toHaveLength(1);
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.PreToolUse[0].hooks[0].command).toBe('echo hi');
    expect(mergeHookSettings(first.text as string, claude)).toEqual({});
    expect(mergeHookSettings('{', claude).error).toContain('not valid JSON');
    expect(mergeHookSettings('[]', claude).error).toBeDefined();
    expect(mergeHookSettings('{"hooks":[]}', claude).error).toBeDefined();
  });
});

describe('guard --hook, Codex CLI', () => {
  const patch = (body: string) =>
    JSON.stringify({
      session_id: 's1',
      cwd: project,
      hook_event_name: 'PreToolUse',
      turn_id: 't1',
      tool_name: 'apply_patch',
      tool_use_id: 'u1',
      tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` },
    });

  it('denies a patch that updates a .bib file, in the documented PreToolUse format', async () => {
    for (const args of [[], ['codex']]) {
      const r = await hook(args, fixture('codex-apply-patch-bib.json'));
      expect(r.code).toBe(0);
      const out = JSON.parse(r.out);
      expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('overfull cite');
    }
  });

  it('denies adding, changing or moving a .bib entry or file, anywhere in the patch', async () => {
    for (const body of [
      '*** Add File: refs/new.BIB\n+@misc{x, title={Invented}}',
      '*** Update File: main.tex\n@@\n-a\n+b\n*** Update File: notes.txt\n*** Move to: refs.bib',
      `  *** Update File:   ${project}/references.bib  \n@@\n+@misc{y, title={Invented}}`,
      '*** Update File: references.bib\n@@\n-  year = {2020},\n+  year = {2021},',
      '*** Update File: references.bib\n@@\n-  year = {1999},',
      // Removing a field changes the entry.
      '*** Update File: references.bib\n@@\n @book{roe2019,\n-  title = {Another Book},',
      '*** Update File: references.bib\n@@ no such line\n-  year = {2020},',
      '*** Update File: references.bib\n@@\n?bad line',
      '*** Update File: missing.bib\n@@\n-x',
    ]) {
      const r = await hook(['codex'], patch(body));
      expect(JSON.parse(r.out).hookSpecificOutput.permissionDecision, body).toBe('deny');
    }
  });

  it('allows a patch that only removes whole entries, or the whole file', async () => {
    const removeRoe = [
      '*** Update File: references.bib',
      '@@ year = {2020},',
      ' }',
      ' ',
      '-@book{roe2019,',
      '-  title = {Another Book},',
      '-  author = {Roe, Rick},',
      '-  year = {2019},',
      '-}',
    ].join('\n');
    for (const body of [removeRoe, '*** Delete File: references.bib']) {
      expect(await hook(['codex'], patch(body)), body).toEqual({ code: 0, out: '', err: '' });
    }
  });

  it('allows patches that touch no .bib file, and other tools', async () => {
    for (const body of [
      '*** Update File: main.tex\n@@\n-a\n+b',
      '*** Add File: refs.bib.txt\n+x',
    ]) {
      expect(await hook(['codex'], patch(body))).toEqual({ code: 0, out: '', err: '' });
    }
    const bash = JSON.stringify({
      hook_event_name: 'PreToolUse',
      turn_id: 't',
      tool_name: 'Bash',
      tool_input: { command: 'echo >> refs.bib' },
    });
    expect(await hook([], bash)).toEqual({ code: 0, out: '', err: '' });
  });
});

describe('guard --hook, removing entries and other projects', () => {
  const claude = (tool: string, tool_input: Record<string, unknown>, cwd = project) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, cwd, tool_input });
  const gemini = (tool: string, tool_input: Record<string, unknown>) =>
    JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: tool, cwd: project, tool_input });
  const roe = BIB.slice(BIB.indexOf('@book'));
  const allowed = async (text: string) => (await hook([], text)).out === '';

  it('allows edits and writes that only remove whole entries', async () => {
    const bib = join(project, 'references.bib');
    expect(await allowed(claude('Edit', { file_path: bib, old_string: roe, new_string: '' }))).toBe(
      true,
    );
    expect(
      await allowed(
        claude('MultiEdit', {
          file_path: 'references.bib',
          edits: [{ old_string: roe, new_string: '' }],
        }),
      ),
    ).toBe(true);
    expect(await allowed(claude('Write', { file_path: bib, content: roe }))).toBe(true);
    expect(await allowed(claude('Write', { file_path: bib, content: '' }))).toBe(true);
    // Whitespace and field order do not count as a change.
    const reordered = roe.replace('  title = {Another Book},\n', '').replace('}\n', '');
    expect(
      await allowed(
        claude('Write', {
          file_path: bib,
          content: `${reordered.trimEnd()}\n  title   =   {Another Book},\n}\n`,
        }),
      ),
    ).toBe(true);
    expect(
      await allowed(gemini('replace', { file_path: bib, old_string: roe, new_string: '' })),
    ).toBe(true);
    expect(await allowed(gemini('write_file', { file_path: bib, content: roe }))).toBe(true);
  });

  it('denies edits that add, change or duplicate an entry, or cannot be worked out', async () => {
    const bib = join(project, 'references.bib');
    for (const text of [
      claude('Edit', { file_path: bib, old_string: '2019', new_string: '2018' }),
      claude('Edit', { file_path: bib, old_string: '2019', new_string: '2018', replace_all: true }),
      claude('Edit', { file_path: bib, old_string: 'not in the file', new_string: '' }),
      claude('Edit', { file_path: bib, old_string: '', new_string: '' }),
      claude('Edit', { file_path: bib, old_string: 7, new_string: '' }),
      claude('MultiEdit', { file_path: bib, edits: [] }),
      claude('MultiEdit', { file_path: bib, edits: [roe] }),
      claude('MultiEdit', { file_path: bib, edits: 'x' }),
      claude('Write', { file_path: bib, content: `${BIB}${roe}` }),
      claude('Write', { file_path: bib, content: `${roe}@misc{broken, title = {x}\n` }),
      claude('NotebookEdit', { notebook_path: bib }),
      claude('Write', { file_path: join(project, 'new.bib'), content: '@misc{x, title={New}}' }),
      gemini('replace', { file_path: bib, old_string: 'Rick', new_string: 'Rik' }),
      gemini('replace', {
        file_path: bib,
        old_string: '20',
        new_string: '19',
        expected_replacements: 2,
      }),
    ]) {
      expect(await allowed(text), text).toBe(false);
    }
  });

  it('allows creating an empty .bib, and an edit that creates one with no entries', async () => {
    const file = join(project, 'empty.bib');
    expect(await allowed(claude('Write', { file_path: file, content: '% none\n' }))).toBe(true);
    expect(await allowed(claude('Edit', { file_path: file, old_string: '', new_string: '' }))).toBe(
      true,
    );
  });

  it('does nothing outside an Overfull project (no overfull.yml found upward)', async () => {
    const other = tempDir();
    const text = claude(
      'Write',
      { file_path: join(other, 'references.bib'), content: '@misc{x, title={Invented}}' },
      other,
    );
    expect(await allowed(text)).toBe(true);
    // A subfolder of the project is still guarded.
    mkdirSync(join(project, 'sub'), { recursive: true });
    const sub = claude('Write', {
      file_path: join(project, 'sub', 'more.bib'),
      content: '@misc{x, title={Invented}}',
    });
    expect(await allowed(sub)).toBe(false);
  });

  it('denies when the file cannot be read', () => {
    const payload = JSON.parse(
      claude('Edit', { file_path: 'references.bib', old_string: roe, new_string: '' }),
    );
    const fs = {
      read: () => {
        throw new Error('EACCES');
      },
      inProject: () => true,
    };
    expect(decide(payload, 'claude', project, fs).allow).toBe(false);
    expect(decide(payload, 'claude', project, { ...fs, inProject: () => false }).allow).toBe(true);
  });

  it('compares entries, not text', () => {
    expect(onlyRemovesEntries(BIB, BIB)).toBe(true);
    expect(onlyRemovesEntries(BIB, '')).toBe(true);
    expect(onlyRemovesEntries('', '@misc{x, title={y}}')).toBe(false);
    expect(onlyRemovesEntries(BIB, BIB.replace('Doe, Jane', 'Doe, J.'))).toBe(false);
    expect(onlyRemovesEntries(BIB, BIB.replace('@article{doe2020', '@misc{doe2020'))).toBe(false);
    // @string macros are expanded: changing one changes the entries that use it.
    const macro = (v: string) => `@string{R = {${v}}}\n@misc{k, author = R}\n`;
    expect(onlyRemovesEntries(macro('Roe'), macro('Roe'))).toBe(true);
    expect(onlyRemovesEntries(macro('Roe'), macro('Invented'))).toBe(false);
  });
});
