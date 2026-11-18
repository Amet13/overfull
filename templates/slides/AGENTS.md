# AGENTS.md

This is a LaTeX paper or thesis checked with
[Overfull](https://github.com/amet13/overfull): build, PDF, references,
accessibility and venue rules.

You help the author; you do not write their research. The author signs for every
sentence and reference. Keep the document building, correct and verifiable, and
make changes the author can review.

Read `overfull.yml` first: main file, output name, bibliography, venue profile
and rules. Text is usually in `chapters/` or `sections/`, the author's notes in
`notes/` (the source of truth for content), figures in `figures/`, title and
authors in `metadata.tex` in Overfull templates. Your task instructions are in
`.agents/skills/` (also `.claude/skills/`).

## The loop

After every change:

1. `overfull build` (local `latexmk`, else the Overfull Docker image; it skips
   the build when no source changed, `--force` rebuilds).
2. `overfull check --json`.
3. Fix every `error`. Fix each `warning` or tell the author why it stays.
4. Repeat until there are no errors.

**Done means `overfull check` reports no errors** and you have told the author
about remaining warnings. Exit code 0 is pass (warnings allowed), 1 fail, 2 usage
or internal error; with `--json`, errors are also JSON on stdout
(`{"error": {"code", "message"}}`).

The report has `checks[]` (`build`, `output`, `references`, `accessibility`,
`venue`; status `pass`, `warn`, `fail` or `skipped`) with `problems[]`: `rule`,
`severity`, `message`, `location` (`file`, `line`, `page`), `fix`, `data`.
`overfull explain <rule>` explains a rule; `--checks build,output` runs a subset.

**When `overfull` is not on PATH** (only Docker is installed), use the
Makefile, which runs the same commands in the Overfull image: `make build`,
`make check ARGS=--json`, `make cite ARGS=<doi>`, `make explain RULE=<rule>`,
`make doctor`, `make pages PAGES=3-5`, `make diff`. Wherever a skill says
`overfull <command> <options>`, run `make <command> ARGS="<options>"`. The
`.bib` guard cannot run without `overfull` on PATH (the hook says so); its
rules still apply.

Build and tools:

- Do not pass `--image`, and pass `--engine` only in one case: a package or
  font is missing from the local TeX installation, then use
  `overfull build --engine docker` (the image installs what it lacks). `check`
  never runs `build.image` from `overfull.yml`.
- Never install TeX packages or fonts globally. If a package is missing in
  Docker too, tell the author.
- Do not change the TeX engine or document class to silence an error. Two
  exceptions, both on the author's request: the arXiv build with pdfLaTeX
  (`make arxiv`, see `prepare-arxiv`), and switching to a venue's official
  class or style file (see "Use the venue kit" in `start-paper`).
- `overfull doctor` shows what is installed; exit 1 means nothing can build: tell
  the author.

## Hard rules

References:

- Add references only with `overfull cite <doi | arXiv:id | ACL id | PMID | "title">`.
  Never write or edit BibTeX from memory. A guard blocks edits that add or
  change `.bib` entries (agent hook) and commits of hand-written entries (the
  pre-commit hook in `.pre-commit-config.yaml`, once the author ran
  `pre-commit install`); if it blocks you, use `overfull cite`. Do not work
  around it. Deleting a whole entry the author asked you to remove is allowed.
- Cite only keys you added with `overfull cite` or the author provided. Never
  cite a key reported as `reference-not-found` or `citation-key-missing`.
- If `cite` finds no confident match, stop and tell the author what you searched
  for. If it lists several candidates, do not pick one: use a DOI, rerun with
  `--author` and `--year`, or ask. Never guess a DOI, title, year or author.
- Never write or edit `x-overfull`, and never add `note = {overfull: skip}` or
  `note = {overfull: author-provided}`: only `cite` writes provenance, and only
  the author opts an entry out or vouches for it.
- `reference-unproven` (with `references.requireCite`): ask the author for a DOI
  or arXiv id. `reference-doi-wrong-work` and `reference-arxiv-wrong-work`: the
  identifier belongs to another paper. `reference-metadata-mismatch`: show the
  author the entry and the record and let them decide; `cite` never overwrites
  an entry. `reference-retracted`: tell the author.
- Files you write (`cite --bib`, `pages --out`, `diff --out`) stay inside the
  project.

Content:

- Never invent data, results, numbers, quotes, participants or experiments.
- Claims come from `notes/` or the author. If the source is missing, leave
  `% TODO(author): …`, list it for the author, and do not fill the gap.
- Do not reflow, rephrase or "improve" the author's text unless asked. Keep
  diffs small.

Rules and checks:

- Do not edit the `venue:` section, change `profile`, remove `checks` or add
  `references.ignore` entries to make a check pass. Change `overfull.yml` only
  when the author tells you what the venue requires.
- Double-blind review: in the paper template, `\PaperAnonymoustrue` in
  `metadata.tex` hides names, affiliations, e-mail, PDF author and
  acknowledgments. Never put names back while `venue.anonymous` is true.
- Do not hack spacing, fonts, margins or float parameters to meet a page limit.

Figures and accessibility:

- Keep figures reproducible: data plus pgfplots code or a script.
- Every figure needs alt text that says what it shows, not "Figure 3".
- Keep `\DocumentMetadata` before `\documentclass` (the paper template wraps
  it in an `\ifdefined` test that picks the math setting per engine; keep
  that), and keep `tagging=on`, `pdfstandard`, the document language and the
  title. Do not change the PDF standard settings.
- Exceptions: Beamer slides cannot take `\DocumentMetadata` and are not tagged
  (the slides template says so); a venue class that is incompatible with
  tagging (IEEEtran, llncs) builds without it, and you tell the author the PDF
  is no longer tagged.

LaTeX source:

- Write raw LaTeX, never HTML-escaped. Escape `\&`, `\%`, `\_`, `\#`, `\$`,
  `\{`, `\}`.
- Use `\cref{}` and prefixed labels (`fig:`, `tab:`, `sec:`, `eq:`).
- New text may be one sentence per line; do not reformat existing text.

## Looking at the PDF

When layout matters, render pages and look at them if you can read images:
`overfull pages 3-5` (add `--dpi 150` for detail).

## Working with the author

- One logical change per commit, with a message that says what changed in the
  content.
- Work on a branch and open a pull request; `overfull diff --base main` gives a
  PDF with your changes highlighted. The template workflow
  (`.github/workflows/preflight.yml`) puts the check report in the job summary. In the description, list what changed, what
  you could not verify and the remaining warnings.
- If the venue asks for an AI-use statement (`venue.disclosure: required`),
  draft it with `write-disclosure` from what was actually done. The author
  approves it. Never state that no AI was used.

## Skills

Read the matching `SKILL.md` in `.agents/skills/` before a task: `start-paper`,
`add-citation`, `fix-build`, `add-figure`, `make-accessible`, `fit-page-limit`,
`prepare-arxiv`, `write-disclosure`, `review-changes`, `respond-to-reviewers`.
