import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, win32 } from 'node:path';

/**
 * Absolute path of an executable on PATH, or undefined. On Windows only files
 * `spawn` can start without a shell (.exe, .com) count, unless `allowBatch`:
 * a `.bat`/`.cmd` wrapper needs cmd.exe, which re-parses its arguments.
 * Relative PATH entries (`.`, `bin`) are skipped: they name the current
 * directory, which is often a project that may not be trusted.
 */
export function which(
  cmd: string,
  env: Record<string, string | undefined> = process.env,
  opts: { platform?: NodeJS.Platform; allowBatch?: boolean } = {},
): string | undefined {
  const win = (opts.platform ?? process.platform) === 'win32';
  const exts = win
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter((e) => e && (opts.allowBatch || !/^\.(bat|cmd)$/i.test(e)))
    : [''];
  const sepChar = win ? ';' : delimiter;
  for (const dir of (env.PATH ?? env.Path ?? '').split(sepChar)) {
    if (!dir || !(win ? win32.isAbsolute(dir) : isAbsolute(dir))) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      try {
        accessSync(p, win ? constants.F_OK : constants.X_OK);
        return p;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/** On Windows: `cmd` exists only as a .bat/.cmd wrapper (which `which` does not return). */
export function batchOnly(
  cmd: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== 'win32' || which(cmd, env, { platform })) return undefined;
  const found = which(cmd, env, { platform, allowBatch: true });
  return found && /\.(bat|cmd)$/i.test(found) ? found : undefined;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the command could not be started (ENOENT…). */
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Called with each output line (stdout and stderr) as it arrives. */
  onLine?: (line: string) => void;
  /**
   * Run through the platform shell. Only for known Windows batch wrappers
   * (`verapdf.bat`) with fixed, quoted arguments; never for user input.
   */
  shell?: boolean;
}

/**
 * The program `run` starts for `cmd`: a path stays as given; a bare name becomes
 * its absolute path on PATH (`which`), or undefined when it is not there. Never
 * a bare name: on Windows, starting one searches the current directory first, so
 * a file in the project named `docker.exe`, `pdffonts.exe` or `latexmk.exe`
 * would run instead of the installed tool.
 */
export function resolveCommand(
  cmd: string,
  env: Record<string, string | undefined> = process.env,
  opts: { platform?: NodeJS.Platform; allowBatch?: boolean } = {},
): string | undefined {
  if (/[\\/]/.test(cmd)) return cmd;
  return which(cmd, env, opts);
}

/**
 * Runs a command without a shell, capturing output. Never throws. A bare `cmd`
 * runs from its absolute path on PATH (see `resolveCommand`); when it is not on
 * PATH nothing starts and the result has code 127. With `shell` (Windows batch
 * wrappers only) the program path is quoted for cmd.exe.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const lookupEnv = opts.env && (opts.env.PATH ?? opts.env.Path) ? opts.env : process.env;
  const program = resolveCommand(cmd, lookupEnv, { allowBatch: opts.shell === true });
  if (!program) {
    return Promise.resolve({
      code: 127,
      stdout: '',
      stderr: '',
      error: `${cmd} was not found on PATH`,
    });
  }
  let file = program;
  if (opts.shell && process.platform === 'win32') {
    try {
      file = quoteWindowsArg(program);
    } catch (err) {
      return Promise.resolve({ code: 127, stdout: '', stderr: '', error: String(err) });
    }
  }
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let pending = '';
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv | undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: opts.shell === true,
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
      : undefined;
    const feed = (chunk: string) => {
      if (!opts.onLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const l of lines) opts.onLine(l);
    };
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      feed(d);
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
      feed(d);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: 127, stdout, stderr, error: err.message });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (pending && opts.onLine) opts.onLine(pending);
      resolvePromise({ code: code ?? (signal ? 124 : 1), stdout, stderr });
    });
  });
}

/** True when the Docker daemon answers. */
export async function dockerAvailable(env?: Record<string, string | undefined>): Promise<boolean> {
  // OVERFULL_NO_DOCKER=1: act as if Docker were absent (no image checks, no fallbacks).
  if (dockerDisabled(env)) return false;
  const docker = which('docker', env);
  if (!docker) return false;
  const r = await run(docker, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 8000 });
  return r.code === 0;
}

/** True when `OVERFULL_NO_DOCKER=1` tells Overfull never to use Docker. */
export function dockerDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OVERFULL_NO_DOCKER === '1';
}

/** Quotes an argument for cmd.exe (used only with `shell: true` on Windows). */
export function quoteWindowsArg(arg: string): string {
  if (/["%!^&|<>\r\n]/.test(arg)) throw new Error(`Unsupported character in argument: ${arg}`);
  return /[\s]/.test(arg) || arg === '' ? `"${arg}"` : arg;
}

/** True when docker's stderr says the image cannot be pulled (not published, no access). */
export function imageUnavailable(stderr: string): boolean {
  return /manifest unknown|not found|denied|pull access|repository does not exist|unauthorized/i.test(
    stderr,
  );
}

export function imageUnavailableMessage(image: string): string {
  return (
    `The image ${image} is not available. Build it locally with ` +
    '`docker build -f docker/Dockerfile -t overfull:dev .` from the Overfull repo and set ' +
    'OVERFULL_IMAGE=overfull:dev, or pass --image.'
  );
}

/** Whether an image is present locally, pullable (registry answers), or unavailable. */
export async function dockerImageStatus(
  image: string,
): Promise<'local' | 'remote' | 'unavailable' | 'unknown'> {
  if (await dockerImagePresent(image)) return 'local';
  const r = await run('docker', ['manifest', 'inspect', image], { timeoutMs: 5000 });
  if (r.code === 0) return 'remote';
  if (r.code === 124 || r.error) return 'unknown';
  return imageUnavailable(r.stderr) ? 'unavailable' : 'unknown';
}

export async function dockerImagePresent(image: string): Promise<boolean> {
  const r = await run('docker', ['image', 'inspect', image], { timeoutMs: 8000 });
  return r.code === 0;
}

/** The `--user` for containers: the current user, else nobody (Windows has no uid). */
function dockerUser(): string[] {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function'
    ? ['--user', `${process.getuid()}:${process.getgid()}`]
    : ['--user', '65534:65534'];
}

/**
 * A `--mount` bind of `dir` at /work. Unlike `-v src:dst`, a path containing
 * `:` (a Windows drive, `C:\\paper`) is unambiguous; a field with `,` or `"`
 * is CSV-quoted as docker's parser expects.
 */
export function bindMount(dir: string, readonly = false): string[] {
  const field = `source=${dir}`;
  const source = /[",]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
  return ['--mount', `type=bind,${source},target=/work${readonly ? ',readonly' : ''}`];
}

/**
 * Arguments for `docker run` that mount `dir` at /work and run as the current
 * user (so outputs are not root-owned). `subdir` sets the working directory below /work.
 */
export function dockerRunArgs(
  image: string,
  dir: string,
  command: string[],
  opts: { subdir?: string; env?: Record<string, string> } = {},
): string[] {
  const user =
    typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? ['--user', `${process.getuid()}:${process.getgid()}`]
      : [];
  const env = Object.entries({ HOME: '/tmp', ...opts.env }).flatMap(([k, v]) => [
    '-e',
    `${k}=${v}`,
  ]);
  const workdir =
    opts.subdir && opts.subdir !== '.' ? `/work/${opts.subdir.split('\\').join('/')}` : '/work';
  return ['run', '--rm', ...user, ...env, ...bindMount(dir), '-w', workdir, image, ...command];
}

/**
 * `docker run` arguments for a read-only tool (veraPDF, pdffonts) used by
 * `overfull check`: no network, the project mounted read-only, an unprivileged
 * user, and the tool as the entrypoint, so the image's own entrypoint and the
 * project cannot change what runs.
 */
export function dockerToolArgs(image: string, dir: string, tool: string, args: string[]): string[] {
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    ...dockerUser(),
    '-e',
    'HOME=/tmp',
    ...bindMount(dir, true),
    '-w',
    '/work',
    '--entrypoint',
    tool,
    image,
    ...args,
  ];
}
