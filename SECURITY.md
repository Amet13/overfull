# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 3.x | Yes |
| Older | No |

## Reporting a vulnerability

Please do not open a public issue. Use
[private vulnerability reporting](https://github.com/amet13/overfull/security/advisories/new).
You will get an acknowledgment within 72 hours and a resolution target of 30 days.

## Scope

- The `overfull` CLI and `@overfull/core`: they read local files (logs, PDFs,
  BibTeX) that may come from untrusted sources, and send reference identifiers,
  titles, first authors and years to public indexes. The full list of services
  and what each receives is in
  [What leaves your machine](docs/guide/references.md#what-leaves-your-machine).
- The browser check on the website: files are processed in the browser and are
  never uploaded.
- The Docker image and the GitHub Action.
- CI/CD workflows (injection, token permissions).
- LaTeX shell escape: templates never enable it and `overfull build` never
  passes `-shell-escape`.

## Building untrusted projects is not safe

Only run `overfull build`, `overfull diff`, `make build` or `latexmk` on
projects you trust. A LaTeX project is code: its `.latexmkrc` is a Perl
script that latexmk runs, and TeX itself can read and write files. Running
the build in the Docker image limits what it can reach, but it still writes
to the mounted project directory and has network access.

`overfull check` on outputs (log, PDF, `.aux`, `.bib`) produced elsewhere is
the safe operation. It never runs code from the project: no LaTeX, latexmk,
Perl or project scripts, and nothing the project's `overfull.yml` chooses. The
only programs it may start are veraPDF and pdffonts, either installed locally
or in a Docker image chosen by `--image`, `$OVERFULL_IMAGE` or the default
(`build.image` in `overfull.yml` is ignored by `check`). In Docker they run with
no network, the project mounted read-only, an unprivileged user, all
capabilities dropped and a fixed entrypoint. `check` also:

- reads only regular files inside the project directory (after resolving
  symlinks); a `.bib` named in the source outside the project is skipped with
  a warning;
- keeps its reference cache outside the project. A cache inside the project
  (`.overfull/cache/refs.json`) is used only when the person running Overfull
  asks for it (`--project-cache` or `OVERFULL_REFS_CACHE=project`), never because
  the project's own `overfull.yml` says so; even then it is never read in CI
  (any common CI provider, with or without `.git`) or through a symlink;
- starts veraPDF, pdffonts and Docker from the absolute path found on `PATH`,
  never by bare name, so on Windows a file in the project named like the tool
  (`pdffonts.exe`, `docker.exe`) does not run; relative `PATH` entries such as
  `.` are ignored;
- in GitHub Actions, neutralizes workflow commands in everything it prints
  (log excerpts, titles, file names, error messages) and prints human output
  inside `::stop-commands::` with a random token.

The GitHub Action only runs `check`.

Commands that write (`cite --bib`, `diff --out`, `pages --out`, `init`) refuse
targets that leave the project directory through a symlink, and dangling
symlinks. Report files (`check --write`, the Action's `sarif` input) inside the
project must not be symlinks and must not go through one; an absolute path
outside the project, such as `$GITHUB_STEP_SUMMARY`, is the caller's choice.
`overfull cite` validates `--key` and generated keys. Publisher-supplied BibTeX
(DOI metadata is free text, so anyone can register a record) keeps only an
allowlist of TeX commands: accents, special letters, font and formatting
commands, text symbols and, inside `$…$`, math symbols. Every other command
(`\input`, `\pdfextension`, `\directlua`, `\csname`…) and `^^` escape is
printed as text, never run.

## Supply chain

- Docker base image pinned by `sha256` digest; Node.js and veraPDF downloads
  in the image are checked against pinned SHA-256 sums.
- GitHub Actions pinned to commit SHAs, with read-only default token
  permissions and `persist-credentials: false`.
- Dependencies locked with `pnpm-lock.yaml` and installed with
  `--frozen-lockfile`; only esbuild may run an install script. pnpm installs
  no version published less than 7 days ago (`minimumReleaseAge`), and
  Dependabot waits 7 days before proposing a new version (30 for an npm major;
  security updates are not delayed).
- The release job that creates the tag and moves `v3` runs in the `release`
  environment, so the maintainer can require an approval for every publish
  (MAINTAINING.md).
- Overfull is not published to npm. Release downloads and the Docker image
  carry GitHub build provenance attestations:
  `gh attestation verify overfull-linux-x64 --repo amet13/overfull` or
  `gh attestation verify oci://ghcr.io/amet13/overfull:3 --repo amet13/overfull`.
  Each release also lists `SHA256SUMS`. The installers check `SHA256SUMS`
  always, and the attestation too when the GitHub CLI is installed and logged in.
- Dependabot updates Actions (including the template workflows), Docker and
  npm dependencies weekly; OpenSSF Scorecard runs weekly.
