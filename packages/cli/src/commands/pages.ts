import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { join, relative } from 'node:path';
import { int, parse, str } from '../args.js';
import { loadConfig, locateProject, requireMain } from '../config.js';
import { type Io, noteProject, UsageError } from '../io.js';
import { loadPdfjs } from '../pdf.js';
import { insideRoot, insideRootForWrite } from '../safety.js';
import { dockerAvailable, dockerRunArgs, run, which } from '../tools.js';

const pagesHelp = `Usage: overfull pages <range> [options]

Render PDF pages to PNG so you (or an agent) can look at them.
Range: "3", "2-5", "1,4,7", "8-" (to the end). Prints the written paths.

Options:
  --pdf file      PDF to render, inside the project (default <jobname>.pdf)
  --main file     Main .tex file, to find <jobname>.pdf (default from overfull.yml or detected)
  --out dir       Output directory inside the project (default .overfull/pages)
  --dpi n         Resolution, at most 600 (default 110)
  --json          Print {pages: [{page, file}]} (or {error}) as JSON
  --config file   Config file (default overfull.yml)
  -h, --help      Show this help
`;

/** Parses a page range into sorted unique page numbers, bounded by `max` when given. */
export function parseRange(spec: string, max?: number): number[] {
  const pages = new Set<number>();
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (!m || (!m[1] && !m[3]))
      throw new UsageError(`Bad page range "${part}". Use e.g. 3, 2-5, 1,4,7 or 8-`);
    const start = m[1] ? Number(m[1]) : 1;
    const end = m[2] ? (m[3] ? Number(m[3]) : (max ?? start)) : start;
    if (start < 1 || end < start)
      throw new UsageError(`Bad page range "${part}": pages start at 1 and ranges go up`);
    if (max !== undefined && end > max)
      throw new UsageError(
        `Page ${end} does not exist: the PDF has ${max} page${max === 1 ? '' : 's'}`,
      );
    for (let p = start; p <= end; p++) pages.add(p);
  }
  if (pages.size === 0) throw new UsageError('No pages given. Use e.g. `overfull pages 3`');
  return [...pages].sort((a, b) => a - b);
}

/** Highest `--dpi`: an A4 page is then about 5000 × 7000 pixels. */
export const MAX_DPI = 600;

/** Pixel size of a page rendered at `dpi`, from its crop box and rotation in points. */
export function expectedPixels(view: number[], rotate: number, dpi: number): [number, number] {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = view;
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  const [pw, ph] = rotate % 180 === 0 ? [w, h] : [h, w];
  return [Math.ceil((pw * dpi) / 72), Math.ceil((ph * dpi) / 72)];
}

/** Width and height from a PNG header, or undefined when the file is not a PNG. */
export function pngSize(file: string): [number, number] | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(24);
    if (readSync(fd, head, 0, 24, 0) < 24) return undefined;
    if (head.readUInt32BE(0) !== 0x89504e47 || head.subarray(12, 16).toString() !== 'IHDR')
      return undefined;
    return [head.readUInt32BE(16), head.readUInt32BE(20)];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The pages of `spec` that exist in the PDF, with the pixel size each should render at. */
async function plan(
  pdf: string,
  spec: string,
  dpi: number,
): Promise<{ page: number; size: [number, number] }[]> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(pdf)),
    verbosity: 0,
    isEvalSupported: false,
  });
  const doc = await task.promise;
  try {
    const pages = parseRange(spec, doc.numPages);
    const out: { page: number; size: [number, number] }[] = [];
    for (const page of pages) {
      const p = await doc.getPage(page);
      out.push({ page, size: expectedPixels(p.view, p.rotate ?? 0, dpi) });
    }
    return out;
  } finally {
    await (task.destroy ? task.destroy() : doc.destroy?.());
  }
}

/** Why a rendered PNG is not usable (missing, not a PNG, or far from the expected size), or undefined. */
export function badRender(file: string, expected: [number, number]): string | undefined {
  const size = pngSize(file);
  if (!size) return 'no PNG was written';
  const off = (got: number, want: number) => Math.abs(got - want) > Math.max(2, want * 0.05);
  if (off(size[0], expected[0]) || off(size[1], expected[1]))
    return `the image is ${size[0]}×${size[1]} pixels, expected about ${expected[0]}×${expected[1]}`;
  return undefined;
}

export async function pagesCommand(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(
    args,
    {
      pdf: { type: 'string' },
      main: { type: 'string' },
      out: { type: 'string' },
      dpi: { type: 'string' },
      json: { type: 'boolean' },
      config: { type: 'string' },
    },
    'pages',
  );
  if (values.help) {
    io.stdout(pagesHelp);
    return 0;
  }
  const spec = positionals.join(',');
  if (!spec) throw new UsageError('Give a page range: `overfull pages 3` or `overfull pages 2-5`');
  const dpi = int(values.dpi, 'dpi') ?? 110;
  if (dpi > MAX_DPI) throw new UsageError(`--dpi must be at most ${MAX_DPI}, got ${dpi}`);
  // Run from a subfolder, the project is the folder of the nearest overfull.yml above.
  const location = locateProject(io.cwd, str(values.config));
  noteProject(io, location);
  const mainArg = str(values.main);
  const config = loadConfig(location.root, str(values.config), io.env, {
    ...(mainArg ? { main: location.rebase(mainArg) } : {}),
  });
  const pdfArg = str(values.pdf);
  if (!pdfArg) requireMain(config);
  const pdfRel = pdfArg
    ? location.rebase(pdfArg)
    : join(config.build.outDir, `${config.jobname}.pdf`).split('\\').join('/');
  // Like `check --pdf`: only a PDF inside the project is read.
  const pdfAtRoot = insideRoot(config.root, pdfRel, 'PDF');
  if (!existsSync(pdfAtRoot))
    throw new UsageError(
      pdfArg
        ? `${pdfArg} not found.`
        : `${pdfRel} not found. Build first (\`overfull build\`) or pass --pdf.`,
    );
  const pages = await plan(pdfAtRoot, spec, dpi);
  const outArg = str(values.out);
  const outDir = insideRootForWrite(
    config.root,
    outArg ? location.rebase(outArg) : join('.overfull', 'pages'),
    'Output directory',
  );
  mkdirSync(outDir, { recursive: true });

  const local = Boolean(which('pdftoppm', io.env));
  if (!local && !(await dockerAvailable(io.env))) {
    throw new UsageError(
      'pdftoppm not found and Docker is not running. Install poppler (`brew install poppler` / `apt install poppler-utils`) or start Docker.',
    );
  }
  const written: { page: number; file: string }[] = [];
  for (const { page: p, size } of pages) {
    const prefix = join(outDir, `page-${p}`);
    let r: Awaited<ReturnType<typeof run>>;
    if (local) {
      r = await run('pdftoppm', [
        '-png',
        '-r',
        String(dpi),
        '-f',
        String(p),
        '-l',
        String(p),
        '-singlefile',
        pdfAtRoot,
        prefix,
      ]);
    } else {
      const inRoot = (abs: string) => relative(config.root, abs);
      if (inRoot(outDir).startsWith('..') || inRoot(pdfAtRoot).startsWith('..')) {
        throw new UsageError('With Docker, the PDF must be inside the project directory.');
      }
      const toPosix = (s: string) => s.split('\\').join('/');
      r = await run(
        'docker',
        dockerRunArgs(config.build.image, config.root, [
          'pdftoppm',
          '-png',
          '-r',
          String(dpi),
          '-f',
          String(p),
          '-l',
          String(p),
          '-singlefile',
          toPosix(inRoot(pdfAtRoot)),
          toPosix(inRoot(prefix)),
        ]),
      );
    }
    const bad = r.code === 0 ? badRender(`${prefix}.png`, size) : undefined;
    if (r.code !== 0 || bad) {
      const message = bad
        ? `Could not render page ${p}: ${bad}.`
        : `${(r.error ?? r.stderr).trim()}\nCould not render page ${p}.`;
      if (values.json)
        io.stdout(
          `${JSON.stringify({ error: { code: 'render-failed', message, page: p } }, null, 2)}\n`,
        );
      else io.stderr(`${message}\n`);
      return 1;
    }
    written.push({ page: p, file: relative(io.cwd, `${prefix}.png`) || `${prefix}.png` });
  }
  io.stdout(
    values.json
      ? `${JSON.stringify({ pages: written }, null, 2)}\n`
      : `${written.map((w) => w.file).join('\n')}\n`,
  );
  return 0;
}
