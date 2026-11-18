# Packaging

This repository is its own Homebrew tap, Scoop bucket and Nix flake, and holds its
MCP Registry entry. `packaging/generate.mjs` writes all of them for one release
from that release's `SHA256SUMS`:

| File | For |
| --- | --- |
| `Formula/overfull.rb` | Homebrew (macOS arm64 and x64, Linux x64 and arm64) |
| `bucket/overfull.json` | Scoop (Windows x64) |
| `flake.nix` | Nix (`x86_64-linux`, `aarch64-linux`, `x86_64-darwin`, `aarch64-darwin`) |
| `server.json` | The official MCP Registry: the `:<version>-check` image running `overfull mcp` |

```bash
brew tap amet13/overfull https://github.com/Amet13/overfull
brew install amet13/overfull/overfull
scoop bucket add overfull https://github.com/Amet13/overfull
scoop install overfull/overfull
nix run github:Amet13/overfull -- --version
```

After a release is published, the `package-manifests` job of `release.yml`
downloads its `SHA256SUMS`, runs the generator and opens an automation pull
request (`automation/packaging`), which ci merges when it passes. Do not edit the
files by hand; a test checks that they are exactly what the generator writes.

Every release also attaches `overfull.rb` and `overfull.json` as release files.

The MCP Registry entry is published only by hand, with the `mcp-registry`
workflow (see MAINTAINING.md).

Generate them by hand:

```bash
node packaging/generate.mjs --version 3.1.2 --sums SHA256SUMS --repo .   # repository files
node packaging/generate.mjs --version 3.1.2 --sums SHA256SUMS --out dist # release files
```

What was tested: the flake builds and runs on `x86_64-linux` (`nix run`, with
`autoPatchelfHook`). The Homebrew formula and the Scoop manifest follow the
documented formats; they were not installed by an automated test.
