# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project follows [Semantic Versioning](https://semver.org/) for template releases.

## [Unreleased]

### Added

- `overfull check --project-cache` and `OVERFULL_REFS_CACHE=project` keep the reference cache in `.overfull/cache/`
- References: `overfull init` offers to set `references.mailto` from your git
  e-mail (only after you answer yes), for CrossRef's polite pool.
- References: when doi.org or arXiv cannot answer, OpenAlex is asked for the
  record of that one DOI or arXiv id (no search budget used).
- References: a retraction check that fails part way keeps what it found and
  says so (`reference-retraction-unchecked`, info).
- Slim image: latexdiff (`overfull diff`), XeLaTeX, the venue classes (IEEEtran, acmart, llncs, elsarticle, REVTeX), common packages (enumitem, multirow, titlesec, algorithm2e, tcolorbox, newtx, glossaries and more) and the Fira, Inconsolata and Libertine fonts
- `overfull build --engine docker` installs missing packages on demand with the slim image too
- CI: time a non-root LaTeX start, check the slim image offline, and run `overfull diff` in it
- Commands run from a subfolder use the nearest `overfull.yml` above (up to the Git root) and say `Using ../overfull.yml.`
- `overfull mcp --allow-build` adds a `build` tool (only for projects you trust: `latexmk` runs the project's `.latexmkrc`).
- `overfull init --yes` asks nothing and takes the defaults.
- Venue: new rule `arxiv-bbl-version` warns when a shipped biblatex `.bbl` has a
  format arXiv's TeX Live cannot read (TeX Live 2025, the default, reads 3.3).
- Venue profiles: `anonymizedByClass` names a class that prints "Anonymous" itself
  in review mode (NeurIPS, ICML, ICLR, AAAI, CVPR, ECCV, AISTATS, ACL/ARR, EMNLP, acmart).
- Corpus cases for no-line-to-end, hyperref-error, command-already-defined,
  unknown-package-option, bibliography-stale, float-too-large and font-feature-missing.
- Paper template: `\PaperAnonymoustrue` in `metadata.tex` hides authors, affiliations, e-mail, the PDF author and the acknowledgments for double-blind review; `\PaperCameraReadytrue` for the final version; Limitations and Acknowledgments sections; theorem, proof and algorithm examples that pass veraPDF.
- Thesis template: front matter with roman page numbers (declaration of originality, acknowledgments, AI-use statement, contents, lists of figures and tables), and `\appendixsection{Title}`, which letters itself.
- Slides template: references (biblatex, `make cite`) and the basic accessibility rules (title, language, alt text) as warnings.
- Templates: `make cite ARGS=...`, `make explain RULE=...`, `make doctor` and `make check ARGS=...`, so an agent with only Docker can follow the loop; a `.pre-commit-config.yaml` with the `overfull guard --staged` hook.
- `start-paper` skill: the venue ids and how to move to a venue's style kit (official class unchanged, paper size, and building without tagging for IEEEtran and llncs).
- A root `AGENTS.md` for agents working on this repository.

### Changed

- References: requests to CrossRef are spaced (one at a time, about 1.1 s apart
  without `mailto`; three at a time, about 0.35 s apart with it).
- References: the title-search cache key includes the first author sent to
  CrossRef, so entries with the same title and other authors no longer share an
  answer.
- The default Docker image is `ghcr.io/amet13/overfull:3-slim` (the full image is `:3`); `build.image` still overrides it
- veraPDF in the images is the command line only (no GUI), and the check image reuses its heavy layer across releases
- Images: `edge` and `sha-*` are published only once CI passed on that commit
- Images: the full, slim and check images each have their own title and description, the authors label is no longer the TeX Live base image's, and release images carry their version
- CI: the watchdog also checks the runs the automation starts itself (hourly) and restarts runs stuck in the queue; automation pull requests behind `main` are brought up to date before they merge
- `overfull init` and `adopt` ask only when stdin and stdout are both terminals; the end of input counts as no, and a run that asks nothing says what it wrote.
- `overfull diff` exits 1 for an incomplete diff PDF with or without `--json`; in a repository with one commit it compares uncommitted changes with `HEAD`.
- `overfull doctor` marks an invalid config, or a missing `--config` file, with ✕ and exits 1; `--json` adds `configValid`.
- `overfull pages --dpi` is at most 600, `--pdf` must be inside the project, and the default PDF is read from `build.outDir`.
- MCP: without `--allow-build`, the instructions, the `check` description and skip reasons say that a person must build first; tool errors no longer ask the client to run CLI commands.
- Venue: `arxiv-missing-bbl` no longer says arXiv does not run Biber; it warns only when
  neither the `.bib` files nor `<main>.bbl` are in the project. `arxiv-unsupported-engine`
  says arXiv compiles with pdfLaTeX or XeLaTeX.
- Reports: every format lists problems in one order, and Markdown renders `code` in
  messages like HTML (only matched backtick pairs).
- Guard hook: removing whole `.bib` entries is allowed (adding or changing one is still blocked), and the hook does nothing outside a project with `overfull.yml`. Without `overfull` on `PATH`, the hook and the git pre-commit hook say that they could not check.
- Templates use `ghcr.io/amet13/overfull:3-slim` (the image their CI uses) in `overfull.yml`, the Makefile and the Dev Container; `make build` runs `overfull build`.
- Template workflow renamed to `.github/workflows/preflight.yml` (also what `init --here --ci` writes): the preflight runs before the arXiv build, the arXiv build is checked with `--profile arxiv`, and the PR diff also runs after a failed check.
- arXiv guidance in the templates and skills: arXiv runs Biber itself on the uploaded `.bib` (TeX Live 2025, no TeX Live 2026 yet); ship a `.bbl` only when `arxiv-bbl-version` accepts it; `make arxiv` keeps `paper.pdf`.
- Agent instructions: `--engine docker` only for a missing package, `\DocumentMetadata` before `\documentclass`, the PDF standard stays, and the Beamer exception is written down.

### Fixed

- Releases: the images are tagged before the GitHub release and `v3` are created, so a release can no longer come out without its images
- References: titles in Cyrillic, Chinese, Arabic and other non-Latin scripts
  were always reported as not found; a title without letters or digits is now
  "could not be checked", never "not found".
- References: DOIs and eprints with TeX escapes (`\_`) were reported as
  non-existent.
- References: when doi.org failed, a wrong DOI could come out verified through
  the title search.
- References: an out-of-range numeric entity in an index answer, or any other
  unexpected exception in one entry, stopped the whole check; it now affects
  only that entry.
- References: an index answer of an unexpected shape is reported as "returned
  unexpected data" instead of a JavaScript TypeError.
- References: the arXiv batch now also covers ids whose cached answer is empty
  or too old.
- Docker images: LaTeX starts as fast for a non-root user as for root (it took about a minute in the full image)
- Slim image: on-demand installs work for any user, survive a critical tlmgr update, and fall back to the frozen repository after the yearly TeX Live release
- `overfull check --watch` keeps each reference's last answer when only the log, PDF or `.aux` changed; before, re-runs went offline and verified entries became "not checked" errors.
- `overfull init --here` exited 0 with nothing written when stdout was a terminal but stdin was not.
- `overfull init papr` created a thesis in `papr/`; a near miss of a template name now says "Did you mean `paper`?", and extra arguments are refused.
- `overfull pages` reported success for a broken render (a 1×1 PNG); each image is now checked against the page size.
- `overfull build` suggested a made-up `thesis.tex` when the main file was missing; it now names the real cause.
- `overfull diff --engine` accepted any value.
- An invalid `overfull.yml` showed a YAML error cut off after "column 5:"; the whole message, with the line it points at, is shown.
- `overfull check --watch` also watches a build folder whose name starts with a dot, no longer adds an abort listener on every tick, and names `--html` in its refusal.
- Documented `status: "skipped"` (nothing checked, exit 1) in the JSON report schema and exit codes.
- Venue: `anonymity-author-named` no longer fails a submission whose venue class hides the
  authors in review mode, and it expands `\author{\PaperAuthors}` macros from the sources.
- Log: a missing `.bbl` in a natbib or BibTeX project says BibTeX (not Biber) and uses the
  real job name.
- Log: undefined references are folded into "rerun LaTeX" only when labels changed, not for
  rerunfilecheck or longtable reruns.
- Log: parsing a log with many unmatched `(` is linear again (a 1 MB log took 26 s).
- Log: `.bbl` error attribution is linear, and only moves errors at or after the
  bibliography.
- Log: overfull boxes "at lines 13--1" are dropped when an error sits in their paragraph;
  "overfull boxs" is "overfull boxes".
- Log: an error raised inside a TeX Live package while it loads points at the project file
  that loaded it, not at the package's line.
- Templates' `.gitignore` ignored PDF figures (`*.pdf`); it now ignores only PDFs in the project folder, and `notes/reviews.md`.
- `sync-templates` deletes the template copies of files removed from `shared/agents/`.

### Security

- `overfull cite` keeps only an allowlist of TeX commands (accents, formatting, text and math symbols) in publisher BibTeX; every other command is printed, not run, so a crafted DOI record cannot embed local files in the PDF
- Automation: a pull request from a fork whose branch is named `automation/...` is no longer retitled and labelled as the automation PR
- `check --write` and the Action's `sarif` input refuse a report file that is a symlink or leaves the project through one; relative `--write` paths must stay inside the project
- Tools (`docker`, `pdffonts`, `verapdf`, `latexmk`, `git`…) run from their absolute path on PATH, never by bare name, so on Windows a file in the project named like the tool cannot run; relative PATH entries are skipped
- Supply chain: Dependabot waits 7 days before proposing a new version (30 for an npm major), pnpm installs nothing published less than 7 days ago, and the release job runs in a `release` environment that can require the maintainer's approval
- The installers also run `gh attestation verify` on the download when the GitHub CLI is installed and logged in (skipped without it)
- A project's own `overfull.yml` can no longer turn on its in-repository reference cache (`references.cache: project` is ignored with a notice), so a planted cache cannot mark made-up references as verified

## [v3.1.2] - 2026-11-16

Changes merged since v3.1.1, each after the full test suite and the template
builds passed. Released automatically by autorelease.yml.

### Changed

- Automation PRs merge themselves when CI passes
- CI: no duplicate runs on automation PRs; re-run jobs that never got a runner
- CI: catch failures before main; stop timing tests failing on slow runners
- Slim image and on-demand installs: retry when a CTAN mirror fails
- Docs: on-demand installs cover missing biblatex styles
- Install biblatex-ieee in the slim image; install missing biblatex styles on demand
- Test: check for script and img tags in any letter case (CodeQL js/bad-tag-filter)
- Docker: install libatomic1 where Node.js runs in the builder
- Website: real CLI output on the home page, tool-first check page, report download; docs
- Docker and CI: slim image, CLI layer apart from TeX, parallel image jobs, release by retag
- CLI: faster start, one check with many report files, HTML report, batched arXiv, TeX packages on demand
- Bump the npm group across 1 directory with 3 updates (#96)

Faster everywhere: a slim image, parallel CI, releases that retag instead of
rebuilding, and a quicker CLI.

### Added

- `ghcr.io/amet13/overfull:3-slim`: TeX Live's basic scheme plus LuaLaTeX, the
  recommended LaTeX packages and fonts, and what the templates use, about a fifth
  of the full image. `overfull build` installs any other package from CTAN on
  demand, including a missing biblatex style, and builds again
  (`OVERFULL_TEX_INSTALL=1`). The template workflows use
  it. It replaces the medium image; the `-medium` tags now point to it.
- `overfull check --write format=file` (repeatable) writes json, markdown,
  annotations, sarif or html from one run; `overfull check --html` prints a
  self-contained, printable HTML report. The browser check can download the same
  page.
- The home page shows what `overfull check` prints for a draft, from the CLI's own
  formatter.

### Changed

- The CLI starts in about half the time: commands load only when used and Node's
  compile cache is on.
- The arXiv ids of a bibliography are fetched in one request instead of one
  every three seconds.
- Images: the CLI is one bundled file added last, built without TeX Live, so a
  code change never rebuilds a TeX layer; the check image no longer builds on
  TeX Live.
- CI builds the full, slim and check images in parallel and the templates once;
  a release retags the images already built on `main`.
- The template workflows build with `overfull build` and run `overfull check`
  once (annotations, job summary and an HTML report).
- The scheduled upkeep is one `maintenance.yml` workflow.

### Fixed

- The pin updater updated only the first copy of a pinned version, so the check
  image kept an old veraPDF.

## [v3.1.1] - 2026-11-11

Changes merged since v3.1.0, each after the full test suite and the template
builds passed. Released automatically by autorelease.yml.

### Changed

- Fix the slow trailing-punctuation regex in parseDoi (CodeQL js/polynomial-redos)
- Cleanup: remove the plan, unexport 32 more declarations, share the identifier checks
- Automation runs without API keys or repository secrets
- Format log/paths.ts
- Drop npm publishing: Overfull ships only through GitHub
- Revert "npm: publish the single-file CLI as `overfull` when an NPM_TOKEN secret exists"
- Rebuild the bundled Action
- Changelog for the next release; plan status
- npm: publish the single-file CLI as `overfull` when an NPM_TOKEN secret exists
- Venue profiles: ECCV 2026 and AISTATS 2027, from the official pages and kits
- Remove an unused log helper; format
- Export only what other modules use (55 declarations were exported for nothing)
- Skills: trim add-citation, fix outdated sources and rules
- Keep outside data current: source health, recording refresh, venue kits and page changes
- Rewrite ARCHITECTURE.md from the code as it is; --profile help names venue ids
- Smaller downloads, one name per command, declared dependencies
- CI survives mirror outages; tests for bibliography attribution, Semantic Scholar, MCP framing
- cite: write the published version when arXiv names one; never write collection
- Reports: nothing checked is not a pass; one finding per missing key; clearer summaries
- References: call an invented title not found when CrossRef and one more index agree
- Plan: keep outside data current (source health, recordings, venue kits and pages)
- Add an improvement plan from a fresh audit of 3.1.0
- Fix the open CodeQL findings

### Changed

- **References: "not found" no longer needs dblp.** An invented title is reported
  as not found when CrossRef and one more general index (OpenAlex, Semantic
  Scholar or dblp) answered and none knows it. dblp now answers automated
  requests with a bot check, so in 3.1 nearly every invented title ended as
  "could not be checked". A title that other works share is "could not tell",
  never "not found". On the recorded responses, 17 of 17 fabricated entries are
  detected (was 13) and no real one is called not found. The browser check also
  asks OpenAlex.
- **Nothing checked is not a pass.** When every check is skipped (no log, PDF or
  `.bib` found), the status is `skipped` ("NOTHING CHECKED"), the report says
  why, and `overfull check` and the Action fail unless `--fail-on never`. With
  no main file and no PDF, the venue check is skipped too.
- A cited key with no `.bib` entry is reported once (`citation-key-missing`), not
  also as `undefined-citation`.
- Offline, problems found without the network decide the references status and
  lead its summary. Counts are pluralised; page limits read "The main text is 10
  pages; the limit is 9".
- `overfull cite` writes the published version when the arXiv record names its
  DOI, keeping the arXiv id; it never writes the non-standard `collection` field.
- `overfull --help` lists `init --here` (`adopt` stays an alias).
- Many lookup failures caused by a bot wall fold into one warning.

### Added

- Venue profiles: ECCV 2026 and AISTATS 2027.
- Releases ship a gzip copy of each executable (about 50 MB instead of 150 MB);
  the installers use it and check both files.
- Automation: a weekly health check of every reference source, a monthly refresh
  of the recorded answers the tests replay, style-file hashes that follow each
  venue's official kit (new `kit` field), and venue-page change diffs in the
  monthly venue issue (`node scripts/venues-watch.mjs --accept <id>`).

### Fixed

- CI no longer depends on Ubuntu's package mirrors for the website tests, and
  every install step has a time limit.
- Tests for the bibliography error attribution, the Semantic Scholar source and
  the MCP framing; coverage floors are enforced in CI.
- Cleanup: 87 declarations that only their own file used are no longer
  exported, two dead functions and the improvement plan are removed, and the
  DOI and arXiv checks share their assessment and failure handling.

## [v3.1.0] - Any project first

Overfull now starts from the paper you already have: one command checks any
LaTeX project, and templates become one way in among several.

### Added

- `overfull init --here` (alias `overfull adopt`) adds Overfull to an existing
  project: it detects the main file, engine, bibliography and backend, and the
  venue style file, and writes a commented `overfull.yml`. `--agents`, `--ci`,
  `--make`, `--hooks` (or `--all`) add agent files, a workflow, a Makefile and
  a git pre-commit hook. It never touches `.tex` or `.bib` files.
- `overfull guard`: `--staged` refuses commits that add bibliography entries
  that neither came from `overfull cite`, carry an author note, nor verify;
  `--hook` blocks direct `.bib` edits by Claude Code, Codex CLI and Gemini CLI.
  `.pre-commit-hooks.yaml` for the pre-commit framework.
- `overfull mcp`: a dependency-free Model Context Protocol server (stdio) with
  `check`, `cite`, `explain`, `pages` and `doctor`.
- Claude Code plugin and marketplace manifests: skills, the guard hook and the
  MCP server in one install. Gemini CLI extension (`gemini-extension.json`):
  skills and the MCP server.
- Venue profiles as data (`venues/*.yml`, each with its sources and check
  date): NeurIPS 2026, ICLR 2027, ICML 2026, CVPR 2027, AAAI-27, ACL Rolling
  Review, EMNLP 2026, Springer LNCS, IEEE conferences (IEEEtran) and ACM
  conferences (acmart sigconf). New rules `style-file-modified`,
  `layout-tampering`, `anonymity-link`, `venue-profile-stale`, and
  `text-outside-block` (text in the margin, measured on the PDF against the
  style file's text block).
- Reference sources: Semantic Scholar, ACL Anthology (ids and URLs), Europe
  PMC (PMID, PMCID), keyless OpenAlex when DBLP cannot be reached. New rules
  `reference-retracted`, `reference-published-version`, `reference-duplicate`,
  and `reference-uncited` (off by default, `references.reportUncited`).
- `overfull check` takes files as arguments, finds the main file without
  `overfull.yml`, says what it assumed, shows progress on a terminal, and has
  `--main`, `--refresh` and `--sarif`.
- Action: `sarif` input and output.
- `ghcr.io/amet13/overfull:<version>-check`: the CLI, veraPDF and poppler
  without TeX Live. `ghcr.io/amet13/overfull:<version>-medium`: TeX Live's
  medium scheme plus the collections the templates need; CI builds the
  templates in it.
- `overfull check --watch` checks again whenever the log, PDF, `.aux` or a
  `.bib` file changes.
- A native build for Intel Macs (`overfull-darwin-x64`). Each release
  attaches a Homebrew formula and a Scoop manifest generated from its
  checksums (`packaging/`).
- References: an entry that links to its OpenReview page and that no index
  has yet is "could not be checked", not "not found".
- Guide pages: How it compares (other reference checkers, from their own
  pages), How accurate is the reference check, Does it help agents; the last
  two render measured results once they are committed.
- A test checks that every `overfull` command quoted in the docs exists and
  uses real flags.
- `install.sh` and `install.ps1`, served from the website; they verify the
  download against `SHA256SUMS` and need no administrator rights.
- The browser check accepts a project `.zip` (such as Overleaf's source
  download) or a folder.
- `bench/refs/`: a reference-check benchmark (124 real, 90 fabricated
  entries), run monthly. `evals/`: 13 agent tasks with three variants. No
  measured results are published yet.

### Changed

- A reference source that times out or fails twice is skipped for the rest of
  the run; sources for one entry are asked at the same time. Cached records
  last 30 days, "not found" 1 day.
- Reference messages: wrong-work identifiers are counted separately; "could
  not be checked" is one sentence with one line per source.
- `page-limit-label-missing` is reported only when pages were counted.
- `overfull doctor` reports the CrossRef API as reachable instead of showing
  an HTTP status.
- `AGENTS.md` no longer assumes the template layout, and is shorter (1,477 to
  842 words) with every rule kept.
- Guide: existing project, CI and Overleaf come first; new pages on existing
  projects, MCP, accuracy and evals.

## [v3.0.0] - Overfull

tex-thesis becomes **Overfull**, a preflight kit for LaTeX papers and theses
that works with AI coding agents and by hand. The version continues the
tex-thesis numbering (last release v2.4.1) because the thesis template lives on
as `templates/thesis`.

### Added

- `overfull` CLI: `init`, `build`, `check`, `cite`, `pages`, `diff`,
  `explain`, `doctor`, all with `--json` for agents.
- Five checks in `@overfull/core` (browser-safe):
  - **build**: TeX errors grouped by root cause with plain-language fixes,
    proven by a 49-case corpus recompiled on TeX Live 2026.
  - **output**: `??`, `[?]`, stale bibliography, overfull boxes, floats past
    the main text.
  - **references**: verification against CrossRef, doi.org, DBLP, arXiv and
    OpenAlex. Outcomes are verified, mismatch, not found, unverifiable or
    lookup failed, never "fake".
  - **accessibility**: tagging, alt text (also from the source, for
    `\includegraphics` and `tikzpicture`), language, title, fonts, veraPDF
    PDF/UA.
  - **venue**: page limits, paper size, double-blind anonymity, AI-use
    disclosure (including placeholders), arXiv rules.
- `overfull cite` adds only real references; ambiguous titles list candidates
  instead of guessing; entries carry a tamper-evident `x-overfull` marker, and
  `references.requireCite` makes unproven references errors.
- GitHub Action (`uses: amet13/overfull@v3`) with annotations, job summary,
  outputs and workflow-command injection protection.
- Templates `thesis`, `paper` and `slides`: thesis and paper are tagged
  PDF/UA-2 and pass veraPDF; every template builds with zero warnings and
  ships `AGENTS.md`, ten Agent Skills, pointers for Claude Code, Codex,
  Cursor, Copilot and Gemini CLI, a Dev Container and a CI workflow.
- Docker image `ghcr.io/amet13/overfull:3` for linux/amd64 and linux/arm64
  (TeX Live 2026, poppler, veraPDF, latexdiff, Node 26, the CLI), with build
  provenance.
- Standalone CLI on every GitHub release: `overfull.cjs` (Node 26+) and native
  executables for Linux (x64, arm64), macOS (arm64) and Windows (x64), with
  checksums and provenance. Overfull is not published to npm.
- Website with docs, a rule reference built from the corpus, and a
  browser-only check.
- Evals harness that scores agents with and without the kit.

### Changed

- Licenses: code is MIT; templates, skills and agent instructions are MIT-0
  (previously GPL-3.0 and CC BY-SA 4.0).
- The thesis template moved to `templates/thesis` and was rebuilt for PDF
  tagging (kernel sectioning, table headers, MathML), with consistent sample
  data.

### Removed

- The old single-template build, root `.vscode` settings and the deleted
  `.devcontainer` references.

## [v2.4.1] - 2026-04-12

### Changed

- Update all GitHub Actions to Node.js 24-compatible versions (`actions/cache` v4.3.0, `actions/attest-build-provenance` v2.4.0, `softprops/action-gh-release` v2.6.2, `github/codeql-action` v3.35.1, `docker/build-push-action` v7.1.0, `actions/upload-artifact` v7.0.1, `ossf/scorecard-action` v2.4.3)
- Pin pre-commit pip dependencies by SHA256 hash via `.devcontainer/requirements.txt` to satisfy OpenSSF Scorecard Pinned-Dependencies check
- Cross-platform `make open` / `make open-slides` support for Windows (Git Bash / MSYS2 / Cygwin)
- Graceful color output degradation in Makefile for environments without `tput`
- Use portable `awk` instead of `sed` append in `make release` target for macOS compatibility
- Fix trailing newline in `LICENSE-CC-BY-SA` for `end-of-file-fixer` pre-commit hook

### Security

- Enable branch protection ruleset on `main` with required PRs and status checks
- Enable GitHub secret scanning and push protection
- Enable Dependabot vulnerability alerts and automated security fixes
- Enable private vulnerability reporting

## [v2.4.0] - 2026-04-12

### Added
- README redesign with PDF screenshots, badge rows, comparison table, "Who is this for?" section, and star history graph
- `SECURITY.md` with vulnerability reporting policy and supply-chain hardening documentation
- Dual licensing: `LICENSE` pointer file, `LICENSE-GPL` (GPLv3), `LICENSE-CC-BY-SA` (CC BY-SA 4.0)
- `CITATION.cff` for GitHub "Cite this repository" button
- `.github/release.yml` for auto-categorized release notes
- `.github/workflows/scorecard.yml` for weekly OpenSSF Scorecard security analysis
- `scripts/validate-pdf.sh` for PDF structural validation in CI
- PDF validation test job in CI pipeline with build summary
- OIDC build attestation for release artifacts via Sigstore
- `make check` meta-target combining lint and format check
- `make release VERSION=x.y.z` for automated version bumping across `CITATION.cff` and `CHANGELOG.md`
- `SOURCE_DATE_EPOCH` support for reproducible PDF builds

### Changed
- Consolidated two Dockerfiles into single multi-stage Dockerfile (base, devcontainer, lint, builder, scratch)
- Updated `.devcontainer/devcontainer.json` to reference root Dockerfile with `target: devcontainer`
- Pinned pre-commit and all pip dependencies by SHA256 hash in `.devcontainer/requirements.txt`
- Parallelized pre-commit and lint CI jobs for faster pipeline
- Added apt package caching in CI with `actions/cache`
- Updated all GitHub Actions to latest Node.js 24-compatible versions
- Cross-platform `make open` / `make open-slides` support (macOS, Linux, Windows Git Bash)
- Graceful color output degradation in Makefile for environments without `tput`
- Updated `CONTRIBUTING.md` with dual license references

### Removed
- Separate `.devcontainer/Dockerfile` (consolidated into root Dockerfile)

## [v2.3.0] - 2026-03-04

### Added
- `latexindent` support via `.latexindent.yaml` and pre-commit hook
- New `make` targets: `build-thesis`, `build-slides`, `watch-thesis`, `watch-slides`, `fmt`, `fmt-check`
- New cleanup target: `clean-all` (includes Docker artifact cleanup)
- Governance update: `.github/CODEOWNERS`
- Enhanced issue/PR templates for reproducible reports and reviews

### Changed
- Pinned Docker base image by digest in project and devcontainer Dockerfiles
- Pinned GitHub Actions workflow dependencies to commit SHAs
- Expanded Dependabot config to update pinned Docker/Actions/pre-commit refs
- CI hardened with explicit permissions, concurrency cancellation, and job timeouts
- Build and lint output made quieter while preserving failure visibility
- Font/math setup and slide metadata hardened for portability and reduced warning noise
- README and contributor docs refreshed and simplified

## [v2.2.0] - 2026-02-21

### Added
- Modernized LaTeX template and open-source project tooling baseline.

### Changed
- Optimized CI lint job to run natively instead of through Docker.
- Refreshed README and release-facing project documentation.

## [v2.1.0] - 2026-02-07

### Added
- Direct links to build artifacts for easier template consumption.

### Changed
- Migrated template workflow to LuaLaTeX.
- Clarified README content and linked to the legacy template line.
- Removed duplicated template/documentation content.

## [v2.0.0] - 2026-02-07

### Changed
- Introduced the v2 template refresh and structure improvements.
- Translated and reworked README content.
- Switched release workflow to use the default GitHub token.
- Stopped tracking generated PDFs in the repository.

## [1.1.1] - 2024-09-24

### Changed
- Updated font-related links and documentation references.
- Bumped release tooling and maintenance automation.

## [1.0.3] - 2022-05-25

### Added
- Buildx setup and multi-architecture build pipeline groundwork.

### Changed
- Iterated CI workflow structure and environment variable handling.
- Updated GitHub Actions runtime baseline to Ubuntu 22.04.
- Removed package publishing step constrained by GitHub limits.
- Fixed Docker mountpoint path handling.

## [1.0.2] - 2022-02-22

### Changed
- Switched release references from commit SHA pins to tags.
- Applied additional small release fixes.

## [1.0.1] - 2022-02-22

### Changed
- Aligned release naming with the tag name.

## [1.0.0] - 2022-02-22

### Added
- Initial public release of the thesis template repository.
- Core thesis structure, chapter scaffolding, and appendix baseline.

### Changed
- Iterative content, wording, and formatting refinements from initial development.
