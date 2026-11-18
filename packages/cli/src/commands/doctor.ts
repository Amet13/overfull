import { relative } from 'node:path';
import { parse, str } from '../args.js';
import { DEFAULT_IMAGE, loadConfig, locateProject } from '../config.js';
import type { Io } from '../io.js';
import {
  dockerAvailable,
  dockerDisabled,
  dockerImageStatus,
  imageUnavailableMessage,
  run,
  which,
} from '../tools.js';
import { VERSION } from '../version.js';

const doctorHelp = `Usage: overfull doctor [--json]

Show which tools Overfull can use on this machine and whether the project
config is valid. Exits 1 when nothing can build the document (no local
TeX Live and no usable Docker image), or when the config file is invalid or the
--config file is missing; other missing tools only limit what can run.

Options:
  --json          Print the results as JSON
  --config file   Config file (default overfull.yml)
  -h, --help      Show this help
`;

interface Item {
  name: string;
  ok: boolean;
  detail: string;
  /** HTTP status of a network probe; only shown in the JSON output. */
  status?: number;
  /** What the missing tool is needed for. */
  needFor?: string;
  /** A problem to fix, not a missing tool (shown as ✕, exit 1): an invalid or missing config file. */
  error?: boolean;
}

async function versionOf(cmd: string, args: string[], pattern: RegExp): Promise<string> {
  const r = await run(cmd, args, { timeoutMs: 15000 });
  const text = `${r.stdout}\n${r.stderr}`;
  return pattern.exec(text)?.[1] ?? (text.trim().split('\n')[0] ?? '').slice(0, 60);
}

async function tool(
  name: string,
  cmd: string,
  args: string[],
  pattern: RegExp,
  needFor: string,
  env: Io['env'],
): Promise<Item> {
  const path = which(cmd, env);
  if (!path) return { name, ok: false, detail: 'not found', needFor };
  return { name, ok: true, detail: await versionOf(cmd, args, pattern) };
}

async function reachable(url: string, f: typeof fetch): Promise<Item> {
  try {
    // GET, not HEAD: on 2026-11-10 api.crossref.org/works?rows=0 answered GET with 200 and HEAD with 405.
    const res = await f(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
    await res.body?.cancel().catch(() => {});
    // Any HTTP response means the host is reachable; the status is kept for --json only.
    return {
      name: 'api.crossref.org',
      ok: res.status < 500,
      detail: res.status < 500 ? 'reachable' : `reachable, but it answered HTTP ${res.status}`,
      status: res.status,
    };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError' ? 'timed out after 2s' : 'unreachable';
    return {
      name: 'api.crossref.org',
      ok: false,
      detail: reason,
      needFor: 'reference checks (use --offline without network)',
    };
  }
}

/** The oldest Node.js major version Overfull supports (`engines.node` in package.json). */
export const MIN_NODE_MAJOR = 22;

export async function doctorCommand(args: string[], io: Io): Promise<number> {
  const { values } = parse(
    args,
    { json: { type: 'boolean' }, config: { type: 'string' } },
    'doctor',
  );
  if (values.help) {
    io.stdout(doctorHelp);
    return 0;
  }
  const env = io.env;
  const items: Item[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  const nodeOk = major >= MIN_NODE_MAJOR;
  items.push({
    name: 'node',
    ok: nodeOk,
    detail: `v${process.versions.node}${nodeOk ? '' : ` (need ${MIN_NODE_MAJOR} or newer)`}`,
  });
  items.push({ name: 'overfull', ok: true, detail: VERSION });

  let image = DEFAULT_IMAGE;
  let configItem: Item;
  try {
    // Run from a subfolder, the project is the folder of the nearest overfull.yml above.
    const location = locateProject(io.cwd, str(values.config));
    const config = loadConfig(location.root, str(values.config), env);
    image = config.build.image;
    const shown = config.file ? relative(io.cwd, config.file).split('\\').join('/') : '';
    configItem = {
      name: 'overfull.yml',
      ok: true,
      detail: config.file
        ? `valid${shown === 'overfull.yml' ? '' : ` (${shown})`} (main ${config.main}, profile ${config.profile.id})`
        : `none, using defaults (main ${config.main})`,
    };
  } catch (err) {
    configItem = {
      name: 'overfull.yml',
      ok: false,
      error: true,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const checks = await Promise.all([
    tool(
      'latexmk',
      'latexmk',
      ['-v'],
      /Version\s+(\S+)/,
      'local builds (otherwise Docker is used)',
      env,
    ),
    tool(
      'lualatex',
      'lualatex',
      ['--version'],
      /(LuaH?B?TeX[^\n]*?)(?:\s*\(|$)/m,
      'local builds',
      env,
    ),
    tool(
      'biber',
      'biber',
      ['--version'],
      /version:?\s*(\S+)/i,
      'biblatex bibliographies in local builds',
      env,
    ),
    tool(
      'pdftoppm',
      'pdftoppm',
      ['-v'],
      /version\s+(\S+)/i,
      '`overfull pages` without Docker',
      env,
    ),
    tool('pdffonts', 'pdffonts', ['-v'], /version\s+(\S+)/i, 'font-embedding checks', env),
    tool('verapdf', 'verapdf', ['--version'], /veraPDF\s+(\S+)/, 'full PDF/UA validation', env),
    tool(
      'latexdiff',
      'latexdiff-vc',
      ['--version'],
      /(\d+\.\d+(?:\.\d+)?)/,
      '`overfull diff` without Docker',
      env,
    ),
    tool('git', 'git', ['--version'], /version\s+(\S+)/, '`overfull diff`', env),
  ]);
  items.push(...checks);
  const docker = await dockerAvailable(env);
  items.push(
    dockerDisabled(env)
      ? {
          name: 'docker',
          ok: false,
          detail: 'not used (OVERFULL_NO_DOCKER=1)',
          needFor: 'builds without TeX Live',
        }
      : which('docker', env)
        ? {
            name: 'docker',
            ok: docker,
            detail: docker ? 'running' : 'installed but not running',
            needFor: 'builds without TeX Live',
          }
        : { name: 'docker', ok: false, detail: 'not found', needFor: 'builds without TeX Live' },
  );
  let imageOk = false;
  if (docker) {
    const status = await dockerImageStatus(image);
    imageOk = status === 'local' || status === 'remote';
    items.push({
      name: 'image',
      ok: imageOk,
      detail:
        status === 'local'
          ? image
          : status === 'remote'
            ? `${image} not pulled yet (first build pulls it)`
            : status === 'unavailable'
              ? imageUnavailableMessage(image)
              : `${image} not present locally, and the registry did not answer`,
      needFor: 'Docker builds',
    });
  }
  items.push(await reachable('https://api.crossref.org/works?rows=0', io.fetch ?? fetch));
  items.push(configItem);

  const localBuild = items.some((i) => i.name === 'latexmk' && i.ok);
  const canBuild = localBuild || (docker && imageOk);
  const configOk = configItem.ok;
  const configVerdict = configOk
    ? ''
    : ' The config file has an error (see overfull.yml below); commands that read it stop until it is fixed.';
  const verdict = `${
    canBuild
      ? 'Ready to build.'
      : docker
        ? `Cannot build: no local TeX Live, and the Docker image is not available. ${imageUnavailableMessage(image)}`
        : 'Cannot build: neither TeX Live (latexmk) nor Docker is available. Install Docker (recommended) or TeX Live.'
  }${configVerdict}`;
  const code = canBuild && configOk ? 0 : 1;
  if (values.json) {
    io.stdout(
      `${JSON.stringify({ canBuild, configValid: configOk, message: verdict, items }, null, 2)}\n`,
    );
    return code;
  }
  const w = Math.max(...items.map((i) => i.name.length)) + 2;
  // Multi-line details (a YAML error with its code frame) line up under the first line.
  const indent = (t: string, n: number) =>
    t
      .split('\n')
      .map((l, k) => (k === 0 || !l ? l : `${' '.repeat(n)}${l}`))
      .join('\n');
  const lines = items.map(
    (i) =>
      `  ${i.ok ? '✓' : i.error ? '✕' : '–'} ${i.name.padEnd(w)}${indent(i.detail, w + 4)}${!i.ok && i.needFor ? ` (needed for ${i.needFor})` : ''}`,
  );
  // A machine that cannot build at all, or a broken config, is named first, and exits 1.
  io.stdout(
    code === 0 ? `${lines.join('\n')}\n\n${verdict}\n` : `${verdict}\n\n${lines.join('\n')}\n`,
  );
  return code;
}
