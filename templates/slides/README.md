# Defense slides

A Beamer deck (16:9, LuaLaTeX) for a thesis defense, made from the
[Overfull](https://github.com/amet13/overfull) slides template. The look is
defined in the local theme `beamerthemeThesisSlides.sty`; title and author
come from `metadata.tex`; frames live in `sections/slides.tex`.

**Accessibility:** Beamer slides cannot be tagged yet (no PDF/UA). The
accessibility check still runs the basic rules (title, language, alt text on
every image) as warnings, and reports `pdf-not-tagged`, which is expected for
Beamer. Share the thesis PDF (PDF/UA-2) together with the slides; for a fully
tagged deck look at the `ltx-talk` class.

**References:** biblatex with short author-year citations (`\parencite{key}`);
the cited works are listed on the last frame. Add entries with
`make cite ARGS=<doi>` (or `overfull cite`), not by hand.

## Two ways to work

**With an AI agent.** `AGENTS.md` and `.agents/skills/` tell the agent how
to build and check the deck. Keep your speaker notes and numbers in `notes/`.

**By hand.** Edit the `.tex` files and run:

```sh
make build    # slides.pdf
make watch    # rebuild on every save
make check    # checks: build log, PDF, references, basic accessibility
make pages PAGES=1-4   # render slides to PNG
make diff     # PDF showing changes against origin/main
make cite ARGS=10.1145/2890784   # add a verified reference
make explain RULE=overfull-box  # what a check rule means
make doctor   # what is installed
make clean    # remove build files (keeps the PDF)
make help     # all targets
```

Only Docker is required; a local TeX Live 2026 works too.

**New to Docker?** Install Docker Desktop (macOS, Windows) or Docker Engine
(Linux) and start it. The first build downloads the slim image (under
1 GB, about 3 GB on disk), so allow a few minutes. After that, builds take
seconds. A package the image lacks is installed on the first build that needs it.

Licensed MIT-0: use it without attribution.
