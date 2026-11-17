#!/usr/bin/env bash
# Prints the OCI labels that tell the three images apart, one key=value per line, for
# docker/metadata-action (image.yml) and for the release retag (release.yml). Without
# them every image gets the repository's name and description, and the TeX Live base
# image's own authors label ("Island of TeX") shows through.
#
#   .github/scripts/image-labels.sh full|slim|check [version]
set -euo pipefail
case "${1:-}" in
  full | overfull)
    title="overfull"
    description="Preflight kit for LaTeX papers and theses: full TeX Live, veraPDF, poppler, latexdiff and the overfull CLI" ;;
  slim)
    title="overfull (slim)"
    description="Preflight kit for LaTeX papers and theses: TeX Live's basic scheme plus what most papers use (other packages install on demand), veraPDF, poppler, latexdiff and the overfull CLI" ;;
  check)
    title="overfull (check only)"
    description="The overfull CLI with veraPDF, poppler and git, without TeX Live: checks PDFs, logs and bibliographies built elsewhere" ;;
  *) echo "usage: image-labels.sh full|slim|check [version]" >&2; exit 2 ;;
esac
echo "org.opencontainers.image.title=$title"
echo "org.opencontainers.image.description=$description"
echo "org.opencontainers.image.authors=Overfull contributors"
if [ -n "${2:-}" ]; then echo "org.opencontainers.image.version=$2"; fi
