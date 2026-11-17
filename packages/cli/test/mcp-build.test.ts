/** MCP: the build tool behind `overfull mcp --allow-build`, and wording for clients without a shell. */
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../src/main.js';
import { createMcpServer, mcpInstructions } from '../src/mcp/protocol.js';
import { createTools, forClient } from '../src/mcp/tools.js';
import { tempDir } from './helpers.js';

type Msg = Record<string, unknown>;
const POSIX_ONLY = process.platform === 'win32';
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});

async function server(cwd: string, allowBuild: boolean, env: Msg = { PATH: process.env.PATH }) {
  const s = createMcpServer({
    version: '9.9.9',
    instructions: mcpInstructions(allowBuild),
    tools: createTools({ cwd, env: env as Record<string, string>, run: main, allowBuild }),
  });
  let id = 1;
  const send = async (method: string, params?: Msg) =>
    JSON.parse(
      (await s.handle(
        JSON.stringify({ jsonrpc: '2.0', id: id++, method, ...(params ? { params } : {}) }),
      )) as string,
    ) as Msg;
  const init = (await send('initialize', { protocolVersion: '2025-11-25', capabilities: {} }))
    .result as Msg;
  await s.handle('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  const call = async (name: string, args: Msg = {}) =>
    (await send('tools/call', { name, arguments: args })).result as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
  const tools = ((await send('tools/list')).result as { tools: Msg[] }).tools;
  return { init, call, tools };
}

function unbuilt(): string {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}x\\end{document}\n',
  );
  return dir;
}

describe('MCP without --allow-build', () => {
  it('says plainly that a person must build first, and has no build tool', async () => {
    const { init, tools, call } = await server(unbuilt(), false);
    expect(init.instructions).toContain('This server cannot build the document');
    expect(init.instructions).toContain('a person must build it first');
    expect(tools.map((t) => t.name)).not.toContain('build');
    expect(tools.find((t) => t.name === 'check')?.description).toContain(
      'a person must build the document first',
    );
    const res = await call('check', { offline: true });
    const report = JSON.parse(res.content[0]?.text as string) as {
      checks: { check: string; skippedReason?: string }[];
    };
    const reason = report.checks.find((c) => c.check === 'build')?.skippedReason ?? '';
    expect(reason).toContain('a person must build the document first (this server cannot build)');
    expect(reason).not.toContain('overfull build');
    const pages = await call('pages', { range: '1' });
    expect(pages.isError).toBe(true);
    expect(pages.content[0]?.text).toContain('Not built yet: a person must build');
    expect(pages.content[0]?.text).not.toMatch(/overfull build|--pdf/);
  });
});

describe('MCP with --allow-build', () => {
  it('lists build first and tells the client to call it', async () => {
    const { init, tools, call } = await server(unbuilt(), true);
    expect(init.instructions).toContain('Call `build` after changing the sources');
    expect(tools.map((t) => t.name)).toEqual([
      'build',
      'check',
      'cite',
      'explain',
      'pages',
      'doctor',
    ]);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    const res = await call('check', { offline: true });
    expect(res.content[0]?.text).toContain('call the build tool first');
    const bad = await call('build', { main: '../outside.tex' });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain('Unsafe main file');
  });

  it.skipIf(POSIX_ONLY)('build runs latexmk and returns the build report', async () => {
    const dir = unbuilt();
    const bin = tempDir();
    const pdf = fileURLToPath(new URL('./fixtures/project/thesis.pdf', import.meta.url));
    const script = join(bin, 'latexmk');
    writeFileSync(
      script,
      `#!/bin/sh\n/bin/cp '${pdf}' main.pdf\nprintf 'This is LuaHBTeX\\nOutput written on main.pdf (2 pages).\\n' > main.log\n`,
    );
    chmodSync(script, 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
    const { call } = await server(dir, true, { PATH: process.env.PATH });
    const res = await call('build', { force: true });
    expect(res.isError).toBeUndefined();
    const report = JSON.parse(res.content[0]?.text as string) as {
      target: string;
      checks: { check: string }[];
    };
    expect(report.target).toBe('main.pdf');
    expect(report.checks.map((c) => c.check)).toEqual(['build', 'output']);
  });
});

describe('forClient', () => {
  it('rewords CLI commands the client cannot run', () => {
    expect(forClient('No main.log — run `overfull build` first')).toBe(
      'No main.log — a person must build the document first (this server cannot build)',
    );
    expect(forClient('No main.log — run `overfull build` first', true)).toBe(
      'No main.log — call the build tool first',
    );
    expect(
      forClient('Say which is the main file: `overfull check --main a.tex`, or set `main: a.tex`.'),
    ).toBe('Say which is the main file: the `main` argument (a.tex), or set `main: a.tex`.');
    expect(forClient('Bad flag\nRun `overfull check --help` for usage.')).toBe('Bad flag');
  });
});
