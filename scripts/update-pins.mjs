#!/usr/bin/env node
// Updates the pins Dependabot cannot: Node.js and veraPDF in docker/Dockerfile (version and
// SHA-256), the Debian snapshot the TeX images install from (DEBIAN_SNAPSHOT), and pnpm in
// package.json (packageManager) together with docker/pnpm.
//
//   node scripts/update-pins.mjs            write the changes, print what changed
//   node scripts/update-pins.mjs --check    print what would change, exit 1 if anything would
//
// Node.js stays on the major version already pinned (26) and takes its newest release;
// the hashes come from nodejs.org's SHASUMS256.txt. veraPDF takes the newest greenfield
// installer on software.verapdf.org; its hash is computed from the download, the same file
// the image build checks. pnpm takes the newest release of the pinned major from the npm
// registry that is older than pnpm-workspace.yaml's minimumReleaseAge. DEBIAN_SNAPSHOT follows the TeX Live base digests (which Dependabot moves): it
// becomes the newer of the two bases' own Debian snapshots, read from their image config on
// Docker Hub. Nothing is changed when a source cannot be read.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const changes = [];

async function get(url, as = 'text', headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'overfull-update-pins', ...headers } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return as === 'json'
    ? res.json()
    : as === 'bytes'
      ? new Uint8Array(await res.arrayBuffer())
      : res.text();
}

const cmpVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/** Sets every `ARG name=` line (a version can be declared in several stages). */
function setArg(text, name, value) {
  const re = new RegExp(`^(ARG ${name}=)(\\S+)$`, 'gm');
  if (!re.test(text)) throw new Error(`docker/Dockerfile: no ARG ${name}`);
  return text.replace(re, `$1${value}`);
}

const argOf = (text, name) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(text)?.[1];

async function node(docker) {
  const current = argOf(docker, 'NODE_VERSION');
  const major = current.split('.')[0];
  const index = await get('https://nodejs.org/dist/index.json', 'json');
  const latest = index
    .map((r) => r.version.replace(/^v/, ''))
    .filter((v) => v.split('.')[0] === major)
    .sort(cmpVersions)
    .at(-1);
  if (!latest || cmpVersions(latest, current) <= 0) return docker;
  const sums = await get(`https://nodejs.org/dist/v${latest}/SHASUMS256.txt`);
  const sumOf = (file) => {
    const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${file}`));
    if (!line) throw new Error(`SHASUMS256.txt for v${latest} has no ${file}`);
    return line.split(/\s+/)[0];
  };
  let out = setArg(docker, 'NODE_VERSION', latest);
  out = setArg(out, 'NODE_SHA256_AMD64', sumOf(`node-v${latest}-linux-x64.tar.xz`));
  out = setArg(out, 'NODE_SHA256_ARM64', sumOf(`node-v${latest}-linux-arm64.tar.xz`));
  changes.push(`Node.js ${current} → ${latest}`);
  return out;
}

async function verapdf(docker) {
  const current = argOf(docker, 'VERAPDF_VERSION');
  const base = 'https://software.verapdf.org/releases/';
  const lines = [...(await get(base)).matchAll(/href="(\d+\.\d+)\/"/g)].map((m) => m[1]);
  const line = lines.sort(cmpVersions).at(-1);
  if (!line) return docker;
  const files = await get(`${base}${line}/`);
  const latest = [...files.matchAll(/verapdf-greenfield-(\d+\.\d+\.\d+)-installer\.zip"/g)]
    .map((m) => m[1])
    .sort(cmpVersions)
    .at(-1);
  if (!latest || cmpVersions(latest, current) <= 0) return docker;
  const zip = await get(`${base}${line}/verapdf-greenfield-${latest}-installer.zip`, 'bytes');
  const sha = createHash('sha256').update(zip).digest('hex');
  changes.push(`veraPDF ${current} → ${latest}`);
  return setArg(setArg(docker, 'VERAPDF_VERSION', latest), 'VERAPDF_SHA256', sha);
}

/**
 * The Debian snapshot (YYYYMMDDTHHMMSSZ) a Debian-based image was built from, from its image
 * config: the official Debian images record `debian.sh ... '@<epoch>'` as their first step.
 */
export function snapshotOf(config) {
  const first = config?.history?.[0]?.created_by ?? '';
  const epoch = /debian\.sh .*'@(\d+)'/.exec(first)?.[1];
  if (!epoch) return undefined;
  return new Date(Number(epoch) * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/** The newest of the current snapshot and the bases' snapshots. */
export function newestSnapshot(current, stamps) {
  return [current, ...stamps.filter(Boolean)].sort().at(-1);
}

/** The amd64 image config of `repo@digest` on Docker Hub. */
async function hubConfig(repo, digest) {
  const { token } = await get(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
    'json',
  );
  const auth = { authorization: `Bearer ${token}` };
  const reg = `https://registry-1.docker.io/v2/${repo}`;
  const index = await get(`${reg}/manifests/${digest}`, 'json', {
    ...auth,
    accept: 'application/vnd.oci.image.index.v1+json',
  });
  const amd64 = index.manifests?.find((m) => m.platform?.architecture === 'amd64')?.digest;
  if (!amd64) throw new Error(`${repo}@${digest}: no amd64 image`);
  const manifest = await get(`${reg}/manifests/${amd64}`, 'json', {
    ...auth,
    accept: 'application/vnd.oci.image.manifest.v1+json',
  });
  return get(`${reg}/blobs/${manifest.config.digest}`, 'json', auth);
}

async function debianSnapshot(docker) {
  const current = argOf(docker, 'DEBIAN_SNAPSHOT');
  const bases = [...docker.matchAll(/^FROM texlive\/texlive:\S+@(sha256:[0-9a-f]{64})/gm)];
  if (!current || bases.length === 0) return docker;
  const stamps = [];
  for (const [, digest] of bases) {
    const stamp = snapshotOf(await hubConfig('texlive/texlive', digest));
    if (!stamp) throw new Error(`texlive/texlive@${digest}: no Debian snapshot in its history`);
    stamps.push(stamp);
  }
  const latest = newestSnapshot(current, stamps);
  if (latest === current) return docker;
  changes.push(`Debian snapshot ${current} → ${latest}`);
  return setArg(docker, 'DEBIAN_SNAPSHOT', latest);
}

/** pnpm-workspace.yaml's `minimumReleaseAge`, in minutes (0 when it has none). */
export function minimumReleaseAge(workspaceYaml) {
  return Number(/^minimumReleaseAge:\s*(\d+)\s*$/m.exec(workspaceYaml)?.[1] ?? 0);
}

/**
 * The newest release of `major` in a registry document that is at least `minAgeMinutes`
 * old. pnpm refuses to install itself at a younger version (minimumReleaseAge), so a
 * newer pin would break `pnpm install` for everyone until it matured.
 */
export function newestMature(meta, major, minAgeMinutes, now = Date.now()) {
  const cutoff = now - minAgeMinutes * 60_000;
  return Object.keys(meta.versions ?? {})
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v) && v.split('.')[0] === major)
    .filter((v) => {
      const published = Date.parse(meta.time?.[v] ?? '');
      return Number.isFinite(published) && published <= cutoff;
    })
    .sort(cmpVersions)
    .at(-1);
}

async function pnpm() {
  const pkgPath = join(root, 'package.json');
  const pkg = readFileSync(pkgPath, 'utf8');
  const current = /"packageManager":\s*"pnpm@([^"]+)"/.exec(pkg)?.[1];
  if (!current) return;
  const meta = await get('https://registry.npmjs.org/pnpm', 'json');
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const latest = newestMature(meta, current.split('.')[0], minimumReleaseAge(workspace));
  if (!latest || cmpVersions(latest, current) <= 0) return;
  changes.push(`pnpm ${current} → ${latest}`);
  if (check) return;
  writeFileSync(pkgPath, pkg.replace(`"pnpm@${current}"`, `"pnpm@${latest}"`));
  const dockerPkgPath = join(root, 'docker', 'pnpm', 'package.json');
  const dockerPkg = JSON.parse(readFileSync(dockerPkgPath, 'utf8'));
  dockerPkg.dependencies.pnpm = latest;
  writeFileSync(dockerPkgPath, `${JSON.stringify(dockerPkg, null, 2)}\n`);
  execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], {
    cwd: join(root, 'docker', 'pnpm'),
    stdio: 'inherit',
  });
}

async function main() {
  const dockerPath = join(root, 'docker', 'Dockerfile');
  const before = readFileSync(dockerPath, 'utf8');
  let after = before;
  for (const step of [node, verapdf, debianSnapshot]) {
    try {
      after = await step(after);
    } catch (err) {
      console.error(`warning: ${step.name}: ${err.message}; left as it is`);
    }
  }
  try {
    await pnpm();
  } catch (err) {
    console.error(`warning: pnpm: ${err.message}; left as it is`);
  }
  if (!check && after !== before) writeFileSync(dockerPath, after);
  console.log(changes.length ? changes.join('\n') : 'All pins are current.');
  if (check && changes.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
