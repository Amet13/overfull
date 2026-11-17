#!/usr/bin/env node
// Builds the standalone `overfull` CLI that GitHub Releases ship (no npm needed):
//
//   node scripts/build-standalone.mjs            → dist-standalone/overfull.cjs (runs with Node ≥ 26)
//   node scripts/build-standalone.mjs --sea      → also dist-standalone/overfull[.exe], a single
//                                                   executable for the current OS/arch (Node SEA,
//                                                   embeds the Node.js that runs this script)
//
// Needs Node.js 26 or newer.
//
// The bundle embeds the templates, so `overfull init` works offline from the single file.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, 'dist-standalone');
const sea = process.argv.includes('--sea');
const { version } = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));

/** Every template file as { "<template>/<path>": base64 }, symlinks as { link: target }. */
function embedTemplates() {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(join(root, 'templates'), full).split(sep).join('/');
      if (entry.isSymbolicLink()) files[rel] = { link: readlinkSync(full) };
      else if (entry.isDirectory()) walk(full);
      else files[rel] = readFileSync(full).toString('base64');
    }
  };
  walk(join(root, 'templates'));
  return files;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const bundle = join(out, 'overfull.cjs');

const importMetaBanner =
  "const __overfullImportMetaUrl = require('node:url').pathToFileURL(__filename).href;";

/**
 * pdf.js (about two thirds of the bundle) as one CommonJS script in a string. Node
 * parses a string literal at almost no cost, so `--version`, `--help` and commands that
 * never read a PDF start without parsing pdf.js; it is compiled on first use. The
 * output stays one file, which the Node single executable needs.
 */
async function pdfjsSource() {
  const result = await build({
    stdin: {
      contents:
        "export * as pdf from 'pdfjs-dist/legacy/build/pdf.mjs';\n" +
        "export * as worker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';\n",
      resolveDir: join(root, 'packages/cli'),
      loader: 'js',
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node26',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    define: { 'import.meta.url': '__overfullImportMetaUrl' },
    external: ['@napi-rs/canvas'],
    banner: { js: importMetaBanner },
  });
  return result.outputFiles[0].text;
}

/** Resolves the two pdf.js entry points to lazy modules that compile the embedded string. */
const lazyPdfjs = (source) => ({
  name: 'lazy-pdfjs',
  setup(b) {
    b.onResolve({ filter: /^pdfjs-dist\/legacy\/build\/pdf(\.worker)?\.mjs$/ }, (args) => ({
      path: args.path.includes('worker') ? 'worker' : 'pdf',
      namespace: 'lazy-pdfjs',
    }));
    b.onResolve({ filter: /^lazy-pdfjs:bundle$/ }, () => ({
      path: 'bundle',
      namespace: 'lazy-pdfjs',
    }));
    b.onLoad({ filter: /.*/, namespace: 'lazy-pdfjs' }, (args) => ({
      loader: 'js',
      contents:
        args.path === 'bundle'
          ? 'const m = { exports: {} };\n' +
            `require('node:vm').runInThisContext(${JSON.stringify(`(function (module, exports, require, __filename) {${source}\n})`)}, { filename: 'pdfjs.cjs' })(m, m.exports, require, __filename);\n` +
            'module.exports = m.exports;\n'
          : `module.exports = require('lazy-pdfjs:bundle').${args.path};\n`,
    }));
  },
});

await build({
  entryPoints: [join(root, 'packages/cli/src/bin.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  // CommonJS: Node single executable applications load a CommonJS entry.
  format: 'cjs',
  target: 'node26',
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
  alias: {
    overfull: join(root, 'packages/cli/src/index.ts'),
    '@overfull/core/text': join(root, 'packages/core/src/report/shared.ts'),
    '@overfull/core': join(root, 'packages/core/src/index.ts'),
  },
  define: {
    __OVERFULL_VERSION__: JSON.stringify(version),
    __OVERFULL_TEMPLATES__: JSON.stringify(embedTemplates()),
    'import.meta.url': '__overfullImportMetaUrl',
  },
  // pdf.js loads @napi-rs/canvas only for rendering, which Overfull does not use.
  external: ['@napi-rs/canvas'],
  plugins: [lazyPdfjs(await pdfjsSource())],
  banner: {
    js: [
      importMetaBanner,
      '{ const warn = console.warn; console.warn = (...a) => { if (typeof a[0] === "string" && /^Warning: Cannot (load \\"@napi-rs|polyfill)/.test(a[0])) return; warn(...a); }; }',
    ].join('\n'),
  },
});
console.log(`${relative(root, bundle)} (${version})`);

if (sea) {
  const exe = join(out, process.platform === 'win32' ? 'overfull.exe' : 'overfull');
  const config = join(out, 'sea-config.json');
  const seaOptions = { main: bundle, disableExperimentalSEAWarning: true };
  // Node 26 builds the executable in one step, with no external injector.
  writeFileSync(config, JSON.stringify({ ...seaOptions, output: exe }));
  execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' });
  // macOS refuses to run a modified binary without a (here ad-hoc) signature.
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
  }
  rmSync(config);
  console.log(relative(root, exe));
}
