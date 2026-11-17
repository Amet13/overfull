import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { parse, str } from '../args.js';
import { locateProject } from '../config.js';
import { type Io, UsageError } from '../io.js';
import { createMcpServer, mcpInstructions } from '../mcp/protocol.js';
import { serveStream } from '../mcp/stdio.js';
import { createTools, type Runner } from '../mcp/tools.js';
import { VERSION } from '../version.js';

const mcpHelp = `Usage: overfull mcp [--cwd dir] [--allow-build]

Run Overfull as a Model Context Protocol (MCP) server on stdin/stdout, for AI
tools that have no shell (desktop apps, cloud editors). An MCP client starts it;
you do not run it by hand.

Tools: check, cite, explain, pages, doctor (and build with --allow-build). They
work on the project in the folder the server was started in (or --cwd, or the
nearest folder above with overfull.yml), and write only inside it (\`cite\`
appends to the bibliography; \`pages\` writes PNGs to .overfull/pages). The
client cannot choose another folder or an output path.

Without --allow-build the server cannot build: a person builds the document
(\`overfull build\` or the editor) before the client calls check.

Options:
  --cwd dir       Project folder (default: the current directory)
  --allow-build   Add a build tool that runs \`overfull build\`. Only for projects
                  you trust: latexmk runs the project's .latexmkrc (Perl code),
                  and build.image in overfull.yml chooses the Docker image.
  -h, --help      Show this help

Configure an MCP client (the usual JSON form; the file name differs per client):

  {
    "mcpServers": {
      "overfull": {
        "command": "overfull",
        "args": ["mcp"]
      }
    }
  }

To pin the project, add "--cwd", "/path/to/project" to args. Clients that start
servers from another folder (most desktop apps) need --cwd.

Protocol: MCP 2026-07-28, and the 2025-11-25 and earlier initialize handshake.
Messages are newline-delimited JSON-RPC; logs go to stderr, never stdout.
`;

export async function mcpCommand(
  args: string[],
  io: Io,
  run: Runner,
  input: Readable = process.stdin,
): Promise<number> {
  const { values, positionals } = parse(
    args,
    { cwd: { type: 'string' }, 'allow-build': { type: 'boolean' } },
    'mcp',
  );
  if (values.help) {
    io.stdout(mcpHelp);
    return 0;
  }
  if (positionals.length) {
    throw new UsageError(`Unexpected argument "${positionals[0]}". Run \`overfull mcp --help\`.`);
  }
  const dir = resolve(io.cwd, str(values.cwd) ?? '.');
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new UsageError(`--cwd "${str(values.cwd)}" is not a directory.`);
  }
  // Started in a subfolder, the project is the folder of the nearest overfull.yml above.
  const { root: cwd, above } = locateProject(dir);
  if (above) io.stderr(`overfull mcp: using ${above}\n`);
  const allowBuild = values['allow-build'] === true;
  const server = createMcpServer({
    version: VERSION,
    instructions: mcpInstructions(allowBuild),
    tools: createTools({
      cwd,
      env: io.env,
      ...(io.fetch ? { fetch: io.fetch } : {}),
      run,
      allowBuild,
    }),
    log: (m) => io.stderr(`overfull mcp: ${m.replace(/\r?\n/g, ' ')}\n`),
  });
  if ((input as { isTTY?: boolean }).isTTY) {
    io.stderr(
      'overfull mcp: speaks MCP over stdin/stdout and is started by an MCP client. Press Ctrl-D to stop; see `overfull mcp --help`.\n',
    );
  }
  await serveStream(input, (line) => io.stdout(`${line}\n`), server.handle);
  return 0;
}
