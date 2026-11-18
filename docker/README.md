# Overfull Docker images

Three images, each multi-arch (linux/amd64, linux/arm64) with a build provenance
attestation (`gh attestation verify oci://ghcr.io/amet13/overfull:3-slim --repo amet13/overfull`).
Tags follow the release: the major (`3`), the minor (`3.1`) and the full version
(`3.1.<patch>`), plus `edge` (main) and `sha-<commit>`, each with the image's suffix.
`-slim` tags exist from 3.1.2 on.

| Image | What it has | Download |
| --- | --- | --- |
| `ghcr.io/amet13/overfull:3-slim` | TeX Live's basic scheme + LuaLaTeX and XeLaTeX, the recommended LaTeX packages and fonts, biblatex/biber, latexdiff, the venue classes and common packages; installs any other package from CTAN on demand | about 0.7 GB |
| `ghcr.io/amet13/overfull:3` | all of TeX Live 2026 (scheme-full) | about 3 GB |
| `ghcr.io/amet13/overfull:3-check` | no TeX Live: checks a PDF, log and bibliography built elsewhere | about 0.25 GB |

All three have the `overfull` CLI (one bundled file run by Node.js 26), veraPDF
(command line only), poppler and git. The TeX images add fonts (Microsoft core fonts,
GNU FreeFont, TeX Gyre), qpdf, latexmk, biber and latexdiff.

`docker run --rm ghcr.io/amet13/overfull:3-slim overfull --version` prints the CLI
version, which matches the tag. The working directory is `/work`, marked as a safe
git directory for `overfull diff`.

## Which one

- **Slim** first: for most papers and theses, and in CI. It is the default of
  `overfull build --engine docker` (`build.image` in `overfull.yml`, `--image` or
  `OVERFULL_IMAGE` change that) and what the templates' workflows use. Beyond the
  basics it has the classes of the built-in venue profiles (IEEEtran, acmart, llncs,
  elsarticle, REVTeX) with what they load, enumitem, multirow, titlesec, xurl,
  algorithm2e, algorithmicx, tcolorbox, tikz-cd, threeparttable, makecell, adjustbox,
  newtx, glossaries, lipsum, fontawesome5, and the Fira, Fira Math, Inconsolata and
  Libertine fonts. When `overfull build` finds a missing package (`File 'x.sty' not
  found`) or biblatex style (`Style 'x' not found`), it looks it up with `tlmgr`,
  installs it and builds again, as any user: the TeX Live tree is writable for
  everyone. It does this inside the image and also from the host with
  `--engine docker`, where the package lives in a container kept for that one build.
  Only `overfull build` installs; plain `latexmk` does not. After the yearly TeX Live
  release, or when tlmgr must update itself first, it switches to the frozen
  repository of TeX Live 2026 or runs `tlmgr update --self`.
- **Full** when a document uses many packages outside the slim set, or must build
  without network access.
- **Check** when the PDF is built elsewhere and you only want the checks, veraPDF
  included.

`:3-medium`, the image slim replaced, is another name for slim. It is kept for
3.x and removed in 4.0: use `:3-slim`.

## Run it as yourself

Run the images with your own user, so the files they write belong to you, and give
that user a writable home:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/work" -w /work ghcr.io/amet13/overfull:3-slim overfull build
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD:/work" -w /work ghcr.io/amet13/overfull:3-check overfull check
```

This is what the CLI (`build --engine docker`, `diff`, `pages`) and the template
Makefiles do. LaTeX starts as fast for any user as for root: LuaLaTeX's font list
is built into the image and readable by everyone. A read-only root filesystem works
too (`--read-only --tmpfs /tmp`); LuaLaTeX then rebuilds its font list once per
container, a few seconds in slim and about a minute in the full image.

The images have no non-root `USER` and run as root when you pass no `--user`:
GitHub Actions jobs that run in a container (`container:`, as the templates'
workflows do) need root to write to the checked-out workspace.

## How the templates use it

The template `Makefile`s run `overfull` when it is installed and otherwise the image
pinned in `overfull.yml`. The template CI workflow (`.github/workflows/paper.yml`)
runs its job inside the slim image, and `.devcontainer/devcontainer.json` opens VS
Code in the full one.

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
`.dockerignore` is an allow-list: a new `COPY` needs a line there.

`docker/smoke/slim.sh` checks the slim image's promises offline (each venue class,
the common packages, XeLaTeX, the fonts, latexdiff):

```sh
docker run --rm --network none -u 1000:1000 -e HOME=/tmp \
  -v "$PWD/docker/smoke:/smoke:ro" overfull:slim sh /smoke/slim.sh
```

Behind a TLS-intercepting proxy, pass its CA certificate as a build secret; it is
trusted only during download steps and never stored in the image:

```sh
docker build --secret id=build_ca,src=/path/to/ca.crt -f docker/Dockerfile .
```

Template Makefiles accept another image: `make build IMAGE=overfull:slim`.
