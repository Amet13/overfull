# Overfull Docker images

Three images, each multi-arch (linux/amd64, linux/arm64) with a build provenance
attestation (`gh attestation verify oci://ghcr.io/amet13/overfull:3 --repo amet13/overfull`).
Tags follow the release: `3`, `3.1`, `3.1.1`, plus `edge` (main) and `sha-<commit>`,
each with the image's suffix.

| Image | What it has | Download |
| --- | --- | --- |
| `ghcr.io/amet13/overfull:3-slim` | TeX Live's basic scheme + LuaLaTeX, the recommended LaTeX packages and fonts, biblatex/biber, and what the templates use; installs any other package from CTAN on demand | about a fifth of the full image |
| `ghcr.io/amet13/overfull:3` | all of TeX Live 2026 (scheme-full) | about 3 GB |
| `ghcr.io/amet13/overfull:3-check` | no TeX Live: checks a PDF, log and bibliography built elsewhere | about 0.25 GB |

All three have the `overfull` CLI (one bundled file run by Node.js 26), veraPDF,
poppler and git. The TeX images add fonts (Microsoft core fonts, GNU FreeFont, TeX
Gyre), qpdf, latexmk and biber; the full one also latexdiff and every package and
font collection.

`docker run --rm ghcr.io/amet13/overfull:3-slim overfull --version` prints the CLI
version, which matches the tag. The working directory is `/work`, marked as a safe
git directory for `overfull diff`.

## Which one

- **Slim** for most papers and theses, and in CI: it is what the templates'
  workflows use. When `overfull build` finds a missing package (`File 'x.sty' not
  found`), it looks it up with `tlmgr`, installs it and builds again
  (`OVERFULL_TEX_INSTALL=1` turns this on; only `overfull build` does it, plain
  `latexmk` does not). In a long-lived container the package stays installed.
- **Full** when a document uses many packages outside the slim set, or must build
  without network access. `overfull build --engine docker` uses it by default
  (`build.image` in `overfull.yml` changes that).
- **Check** when the PDF is built elsewhere and you only want the checks, veraPDF
  included.

`:3-medium`, the image slim replaced, is now another name for slim.

```sh
docker run --rm -v "$PWD:/work" -w /work ghcr.io/amet13/overfull:3-slim overfull build
docker run --rm -v "$PWD:/work" -w /work ghcr.io/amet13/overfull:3-check overfull check
```

## How the templates use it

The template `Makefile`s run `overfull` when it is installed and otherwise the full
image. The template CI workflow (`.github/workflows/paper.yml`) runs its job inside
the slim image, and `.devcontainer/devcontainer.json` opens VS Code in the full one.

## Build it

The build context is the repository root:

```sh
docker build -f docker/Dockerfile -t overfull:dev .                              # full
docker build -f docker/Dockerfile --build-arg TEX_FLAVOR=slim -t overfull:slim .  # slim
docker build -f docker/Dockerfile --target check -t overfull:check .              # no TeX
```

Stages: `node-dist` (the Node.js binary), `builder` (bundles the CLI into one file;
no TeX Live, so a code change never rebuilds a TeX layer), `texbase-full` /
`texbase-slim`, `tex` (+ fonts, poppler, qpdf, veraPDF), `check`, and `overfull`
(the default target). The CLI and Node.js are the last, small layers.

Behind a TLS-intercepting proxy, pass its CA certificate as a build secret; it is
trusted only during download steps and never stored in the image:

```sh
docker build --secret id=build_ca,src=/path/to/ca.crt -f docker/Dockerfile .
```

Template Makefiles accept another image: `make build IMAGE=overfull:slim`.
