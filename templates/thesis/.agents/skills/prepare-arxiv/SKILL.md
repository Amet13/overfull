---
name: prepare-arxiv
description: Prepare the LaTeX source for an arXiv submission and verify it with the Overfull arxiv profile, covering the bibliography (.bib or a matching .bbl), relative paths, file name case, .eps with pdfLaTeX, shell-escape and minted, and optional comment removal with arxiv_latex_cleaner. Use when the author wants to post a preprint to arXiv or the arxiv profile reports problems.
---

# Prepare an arXiv submission

arXiv compiles your source on its own TeX installation
(<https://info.arxiv.org/help/submit_tex.html>). It does not allow
shell-escape, file names are case-sensitive, and only some engines are
supported. Its rules change; check the help pages before each submission.

## Steps

1. Build and check with the arXiv profile:

   ```sh
   overfull build
   overfull check --json --profile arxiv
   ```

   In the paper template, also build the way arXiv does and check that build.
   The `.eps` rule reads the log it is given:

   ```sh
   make arxiv     # latexmk -pdf -jobname=paper-arxiv
   overfull check --json --profile arxiv --checks build,output,venue \
     --log paper-arxiv.log --pdf paper-arxiv.pdf --aux paper-arxiv.aux
   ```

2. Fix each venue problem as below. Rebuild and recheck.
3. Ask the author whether to strip comments (see below).
4. Package the source for the author to upload. The author submits.

## Rules and fixes

- **Bibliography**: since 2025 arXiv runs Biber itself when biblatex selects it
  (BibTeX otherwise). Its default is TeX Live 2025, which reads biblatex `.bbl`
  format 3.3; there is no TeX Live 2026 on arXiv yet. Upload the `.bib` files
  and no `.bbl`, and let arXiv build the bibliography. Ship a `.bbl` (named like
  the main file, `main.bbl`) only when it was made with the same TeX Live
  version as arXiv's: `arxiv-bbl-version` warns when its format does not match.
  If a `.bbl` is present arXiv uses it instead of the `.bib`.
- **Paths**: no absolute paths (`/home/…`, `C:\…`) in `\input`,
  `\includegraphics` or `\addbibresource`. Use paths relative to the main file.
- **File names**: no spaces in file names.
- **File name case**: `Figures/Plot.PDF` and `figures/plot.pdf` are different
  files on arXiv. Make every reference match the file name exactly.
- **Images**: pdfLaTeX cannot include `.eps`. Convert to PDF and update the
  `\includegraphics` path (keep the original if the author wants it).
- **Shell-escape**: `minted`, `\write18`, `svg` and `gnuplot` calls need
  shell-escape, which arXiv does not allow. Replace `minted` with `listings` if
  the author agrees, or pre-render the output and include the result.
- **Engine**: the templates use LuaLaTeX. arXiv offers pdfLaTeX, LaTeX and
  XeLaTeX, but not LuaLaTeX (<https://info.arxiv.org/help/faq/texlive.html>;
  check the current list). The paper template has the documented arXiv path:
  `make arxiv`, which runs `latexmk -pdf -jobname=paper-arxiv` and writes
  `paper-arxiv.pdf` next to `paper.pdf`. Use it, and do not change the engine
  in any other way. Never run a bare `latexmk -pdf`: it overwrites `paper.pdf`.
  The thesis and slides templates have no pdfLaTeX build: explain the options
  to the author (adapt the source for pdfLaTeX or XeLaTeX, where fonts,
  packages and tagging support differ, or skip arXiv for this version). arXiv
  refuses PDFs produced from TeX source, so uploading the PDF is not an
  option.
- **Extra files**: remove build output and unused files. Do not upload the PDF
  as the source when you have the LaTeX.

## Removing comments (optional)

LaTeX comments are visible to anyone who downloads the source. Notes to
co-authors and old text often live there. Ask the author first, then:

```sh
pip install arxiv-latex-cleaner
arxiv_latex_cleaner "$(pwd)"
```

It writes a cleaned copy to a sibling folder ending in `_arXiv`. Build that copy
and run `overfull check --profile arxiv` inside it before upload.

## Done

- The pdfLaTeX build (`make arxiv`) succeeded, and
  `overfull check --profile arxiv --log <arxiv log>` on that build reports no
  errors. Run against the default LuaLaTeX build, the arXiv profile always
  reports `arxiv-unsupported-engine`; that is expected and not a reason to
  change the template.
- The package contains the `.tex` files, figures, the `.bib` files (or a `.bbl`
  that `arxiv-bbl-version` accepts), and nothing private (no `notes/`, no agent
  files).
- The author has been told what was changed and that they must upload it
  themselves.

## Pitfalls

- Do not edit `overfull.yml` to switch the default profile to `arxiv`; pass
  `--profile arxiv` on the command line.
- Metadata on the arXiv form (title, authors, abstract) is separate from the
  PDF. Remind the author to match it.
