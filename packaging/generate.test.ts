import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  flake,
  formula,
  MCP_NAME,
  parseSums,
  repoFiles,
  scoop,
  serverJson,
  sri,
} from './generate.mjs';

const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

const files = [
  'overfull-darwin-arm64',
  'overfull-darwin-x64',
  'overfull-linux-arm64',
  'overfull-linux-x64',
  'overfull-win-x64.exe',
  'overfull.cjs',
];
const sums = files.map((f, i) => `${String(i).repeat(64)}  ${f}`).join('\n');

describe('packaging', () => {
  it('parses SHA256SUMS and rejects other lines', () => {
    expect(parseSums(`${sums}\n`).get('overfull-linux-x64')).toBe('3'.repeat(64));
    expect(() => parseSums('not a sum')).toThrow(/SHA256SUMS/);
  });

  it('writes a formula with one url and sha256 per platform', () => {
    const rb = formula('3.1.0', parseSums(sums));
    for (const [i, f] of files.slice(0, 4).entries()) {
      expect(rb).toContain(`/releases/download/v3.1.0/${f}"`);
      expect(rb).toContain(`sha256 "${String(i).repeat(64)}"`);
    }
    expect(rb).toContain('bin.install');
    expect(() => formula('3.1', parseSums(sums))).toThrow(/version/);
  });

  it('writes a Scoop manifest for the Windows build', () => {
    const m = JSON.parse(scoop('3.1.0', parseSums(sums)));
    expect(m.version).toBe('3.1.0');
    expect(m.architecture['64bit'].hash).toBe('4'.repeat(64));
    expect(m.architecture['64bit'].url).toMatch(/v3\.1\.0\/overfull-win-x64\.exe#\/overfull\.exe$/);
    expect(m.bin).toBe('overfull.exe');
  });

  it('fails when a build is missing from SHA256SUMS', () => {
    expect(() => formula('3.1.0', parseSums(sums.split('\n').slice(1).join('\n')))).toThrow(
      /overfull-darwin-arm64/,
    );
  });

  it('writes a flake that downloads the gzip copy when the release has one', () => {
    const gz = [...files.slice(0, 4).map((f) => `${f}.gz`)];
    const withGz = `${sums}\n${gz.map((f, i) => `${String(i + 6).repeat(64)}  ${f}`).join('\n')}`;
    const nix = flake('3.1.0', parseSums(withGz));
    expect(nix).toContain('version = "3.1.0";');
    expect(nix).toContain('file = "overfull-darwin-arm64.gz";');
    expect(nix).toContain(`hash = "${sri('6'.repeat(64))}";`);
    expect(nix).toContain('dontStrip = true;');
    expect(nix).toContain('autoPatchelfHook');
    // Without gzip copies (releases before 3.1.1), the plain executables.
    const plain = flake('3.1.0', parseSums(sums));
    expect(plain).toContain('file = "overfull-linux-x64";');
    expect(plain).toContain(`hash = "${sri('3'.repeat(64))}";`);
    expect(() => flake('v3', parseSums(sums))).toThrow(/version/);
  });

  it('turns a hex SHA-256 into the SRI form Nix uses', () => {
    expect(sri('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(
      'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    );
  });

  it('writes an MCP Registry entry for the check image of that version', () => {
    const s = JSON.parse(serverJson('3.1.0'));
    expect(s.name).toBe(MCP_NAME);
    expect(s.name).toMatch(/^io\.github\.Amet13\/[a-z]+$/);
    expect(s.version).toBe('3.1.0');
    expect(s.description.length).toBeLessThanOrEqual(100);
    const [pkg] = s.packages;
    expect(pkg).toMatchObject({
      registryType: 'oci',
      identifier: 'ghcr.io/amet13/overfull:3.1.0-check',
      transport: { type: 'stdio' },
    });
    // The registry refuses OCI packages with these fields.
    for (const k of ['version', 'fileSha256', 'registryBaseUrl']) expect(pkg[k]).toBeUndefined();
    expect(pkg.packageArguments.map((a: { value: string }) => a.value)).toEqual([
      'overfull',
      'mcp',
    ]);
    expect(pkg.runtimeArguments[0].value).toContain('dst=/work');
  });

  it('the Dockerfile labels the check image with the same MCP name', () => {
    const dockerfile = read('docker/Dockerfile');
    const check = dockerfile.slice(
      dockerfile.indexOf(' AS check'),
      dockerfile.indexOf(' AS overfull'),
    );
    expect(check).toContain(`io.modelcontextprotocol.server.name="${MCP_NAME}"`);
  });

  it('the files in the repository are what the generator writes for one version', () => {
    const committed = read('Formula/overfull.rb');
    const version = /version "(\d+\.\d+\.\d+)"/.exec(committed)?.[1] as string;
    // SHA256SUMS rebuilt from the committed formula, Scoop manifest and flake.
    const lines: string[] = [];
    for (const m of committed.matchAll(/download\/v[\d.]+\/(\S+)"\n\s+sha256 "([0-9a-f]{64})"/g))
      lines.push(`${m[2]}  ${m[1]}`);
    const bucket = JSON.parse(read('bucket/overfull.json'));
    lines.push(`${bucket.architecture['64bit'].hash}  overfull-win-x64.exe`);
    for (const m of read('flake.nix').matchAll(/file = "(\S+)";\n\s+hash = "sha256-(\S+)";/g))
      lines.push(`${Buffer.from(m[2] as string, 'base64').toString('hex')}  ${m[1]}`);
    const want = repoFiles(version, parseSums(lines.join('\n')));
    for (const [path, content] of Object.entries(want)) expect(read(path), path).toBe(content);
  });
});
