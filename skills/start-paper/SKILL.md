---
name: start-paper
description: Set up a new paper or thesis from a fresh Overfull template, filling metadata.tex, outlining sections or chapters from the author's notes, choosing the profile and venue rules in overfull.yml with the author, switching to a venue's official style kit when the venue requires one, and running the first build and check. Use when the repository was just created from a template, metadata still holds placeholders, the author names a target venue, or the author says they are starting a new document.
---

# Start a paper

## Steps

1. Read `overfull.yml`, `main.tex`, `metadata.tex` and everything in `notes/`.
2. Ask the author for anything that is not in `notes/`:
   - title, authors, affiliations, ORCID, contact email, keywords;
   - document type and venue (thesis, conference, journal, arXiv only);
   - the venue's page limit, anonymity (double-blind or not) and AI-disclosure
     requirement, with a link to the call for papers or style guide;
   - the document language.
3. Fill `metadata.tex` with what the author gave you. Leave a
   `% TODO(author):` comment for anything missing. Never make up names,
   affiliations or emails.
4. Set the language in `\DocumentMetadata` if it is not English. For a
   double-blind venue, turn on anonymous mode in the paper template:
   `\PaperAnonymoustrue` in `metadata.tex` (it hides authors, affiliations,
   e-mail, the PDF author and the acknowledgments). Keep the real names in
   `metadata.tex`; `\PaperCameraReadytrue` brings them back after acceptance.
5. Set up `overfull.yml` with the author's answers. This is the one time you
   edit it, and only with their confirmation:

   ```yaml
   profile: paper            # a built-in profile or a venue id, see below
   references:
     mailto: author@example.org
   venue:
     pageLimit: { max: 9, endLabel: overfull:main-end }
     anonymous: true
     disclosure: required
   ```

   For a page limit with `endLabel`, make sure `\label{overfull:main-end}` sits
   where the venue's counted main text ends (usually just before the
   references).

   Profiles: the built-in `generic`, `thesis`, `paper`, `arxiv`,
   `double-blind`, and the venue profiles `aaai-2027`, `acl-rolling-review`,
   `acm-sigconf`, `aistats-2027`, `cvpr-2027`, `eccv-2026`, `emnlp-2026`,
   `iclr-2027`, `icml-2026`, `ieee-conference`, `neurips-2026`,
   `springer-lncs` (the Venues page of the Overfull docs has the current
   list). A venue profile already sets the page limit, paper size and
   anonymity from the official call; add only what the author confirms is
   different. A profile
   for a past year may be out of date: check the dates on the call for papers.
6. Outline: create one file per section or chapter from the structure in
   `notes/` (or the author's outline), each with a `\section` heading (the
   thesis template uses the `article` class, so a chapter is a `\section` on a
   new page; there is no `\chapter`), a `sec:` label, and a comment listing the
   notes it should draw on.
   Do not write body text unless the author asks, and then only from `notes/`.
7. Remove the template's sample content the author does not want. Ask before
   deleting sample figures or references.
8. First build and check:

   ```sh
   overfull build
   overfull check --json
   ```

   Without `overfull` on PATH use `make build` and `make check ARGS=--json`.
   Fix errors (see `fix-build`). Placeholder references from the template may be
   flagged (`reference-not-found`); ask the author before removing them. When
   they agree, delete the whole entries (the guard allows that) and their
   `\cite`s.
9. Commit: "Set up metadata, outline and venue configuration".

## Use the venue kit

Most venues require their own class or style file. The template's generic
layout (A4, the article class) is fine for drafts, but submit with the kit.
Do this only when the author asks, with the official kit they point you to.

1. Set `profile: <venue-id>` in `overfull.yml` (list above). The venue check
   then knows the style files, page limit, paper size and anonymity rules.
2. Copy the official `.sty`/`.cls`/`.bst` files into the project root
   unchanged. Never edit them: the venue check compares them with the
   official files, and a changed style file is a desk-rejection reason.
3. Switch `main.tex` to the kit: its `\documentclass` (or `\usepackage` of
   the style file) and its options, as in the venue's own example. Drop what
   the kit sets itself: `geometry`, the paper size option (most venues use US
   letter, not A4), fonts and title layout. Keep `metadata.tex` and the
   sections. Use the kit's review or anonymous option for double-blind review
   (then `\PaperAnonymoustrue` is not needed); the venue check knows which
   classes print "Anonymous" themselves.
4. Tagging: keep `\DocumentMetadata` when the class works with it. Classes
   that are incompatible with tagging (IEEEtran and llncs today; see the LaTeX
   tagging status page for others) must build without it: remove
   `\DocumentMetadata` and tell the author the PDF is no longer tagged or
   PDF/UA. Only for this case may the accessibility check be removed from
   `checks`, and only with the author's agreement.
5. Many kits expect pdfLaTeX: build with the engine the kit's instructions
   name (`.latexmkrc`: `$pdf_mode = 1`), and say so in the commit.
6. `overfull build`, `overfull check --json`; fix what the venue check
   reports. Commit: "Switch to the <venue> style kit".

## Done

- `metadata.tex` holds real data or clear TODO markers.
- `overfull.yml` matches the venue as the author described it.
- The outline builds and `overfull check` reports no errors.
- You gave the author a list of open TODOs and the venue link you used.

## Pitfalls

- Do not copy text from the venue's call for papers or another paper into the
  document.
- Do not guess the page limit or anonymity rules from memory. Ask for the
  official link.
- For double-blind venues, keep author names out of the PDF and its metadata:
  anonymous mode in the paper template, or the kit's review option.
