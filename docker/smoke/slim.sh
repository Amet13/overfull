#!/bin/sh
# Offline check of what the slim image promises: every venue class the repository's
# venue profiles name, the common packages, xelatex, the Fira and Inconsolata fonts,
# and latexdiff. Run it inside the image, without network, as any user:
#   docker run --rm --network none -u 1000:1000 -e HOME=/tmp \
#     -v "$PWD/docker/smoke:/smoke:ro" overfull:slim sh /smoke/slim.sh
# A package missing from the image fails the compile (no on-demand install here).
set -eu

dir=$(mktemp -d)
cd "$dir"
failed=

doc() { # doc <name> <engine> <body...>: write <name>.tex and compile it
  name=$1
  engine=$2
  shift 2
  printf '%s\n' "$@" > "$name.tex"
  if "$engine" -interaction=nonstopmode -halt-on-error "$name.tex" > "$name.console" 2>&1; then
    # A class that falls back to other fonts still compiles: catch that too.
    if grep -q 'You do not have the .* package installed' "$name.log"; then
      echo "FAIL $name ($engine): font fallback"
      grep -A1 'You do not have the' "$name.log"
      failed="$failed $name"
      return
    fi
    echo "ok   $name ($engine)"
  else
    echo "FAIL $name ($engine)"
    grep -E '^!|not found|cannot be found' "$name.log" 2>/dev/null | head -5 || tail -5 "$name.console"
    failed="$failed $name"
  fi
}

doc class-ieeetran pdflatex '\documentclass[conference]{IEEEtran}' \
  '\begin{document}\title{T}\author{\IEEEauthorblockN{A}}\maketitle Text.\end{document}'
doc class-acmart pdflatex '\documentclass[sigconf]{acmart}' \
  '\begin{document}\title{T}\author{A}\affiliation{\institution{I}\country{C}}\maketitle Text.\end{document}'
doc class-acmart-lua lualatex '\documentclass[sigconf]{acmart}' \
  '\begin{document}\title{T}\author{A}\affiliation{\institution{I}\country{C}}\maketitle Text.\end{document}'
doc class-llncs pdflatex '\documentclass{llncs}' \
  '\begin{document}\title{T}\author{A}\institute{I}\maketitle Text.\end{document}'
doc class-elsarticle pdflatex '\documentclass{elsarticle}' \
  '\begin{document}\begin{frontmatter}\title{T}\author{A}\end{frontmatter}Text.\end{document}'
doc class-revtex pdflatex '\documentclass[aps,prl,nofootinbib]{revtex4-2}' \
  '\begin{document}\title{T}\author{A}\maketitle Text.\end{document}'

doc packages pdflatex '\documentclass{article}' \
  '\usepackage{enumitem,multirow,titlesec,xurl,tcolorbox,tikz-cd,threeparttable,makecell,adjustbox}' \
  '\usepackage{newtxtext,newtxmath,glossaries,lipsum,fontawesome5,FiraSans,zi4}' \
  '\usepackage[ruled]{algorithm2e}' \
  '\begin{document}\lipsum[1]\faGithub\ \texttt{mono}' \
  '\begin{algorithm}\caption{A}x\;\end{algorithm}\end{document}'
doc algorithmicx pdflatex '\documentclass{article}\usepackage{algorithm,algpseudocode}' \
  '\begin{document}\begin{algorithm}\begin{algorithmic}\State x\end{algorithmic}\end{algorithm}\end{document}'
doc fonts lualatex '\documentclass{article}\usepackage{unicode-math}' \
  '\setmainfont{Fira Sans}\setmathfont{Fira Math}\setmonofont{Inconsolatazi4-Regular.otf}' \
  '\begin{document}Fira $x^2$ \texttt{mono}\end{document}'
doc xetex xelatex '\documentclass{article}\usepackage{fontspec}\setmainfont{FiraSans-Regular.otf}' \
  '\begin{document}Text.\end{document}'

printf '%s\n' '\documentclass{article}' '\begin{document}One two.\end{document}' > old.tex
printf '%s\n' '\documentclass{article}' '\begin{document}One three.\end{document}' > new.tex
if latexdiff old.tex new.tex > diff.tex 2> diff.err; then
  doc diff pdflatex "$(cat diff.tex)"
else
  echo "FAIL latexdiff"
  cat diff.err
  failed="$failed latexdiff"
fi

cd /
rm -rf "$dir"
if [ -n "$failed" ]; then
  echo "Failed:$failed"
  exit 1
fi
