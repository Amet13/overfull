#!/usr/bin/env bash
# Times LuaLaTeX on a tiny document in an image, run as a non-root user the way the CLI
# and the template Makefiles run it, and fails above a limit. A font list that is not
# readable for that user makes every start rebuild it (about a minute in the full image).
# Usage: docker/smoke/start-time.sh <image> [limit-seconds] [--read-only]
set -euo pipefail

image="${1:?usage: start-time.sh <image> [limit-seconds] [--read-only]}"
limit="${2:-20}"
extra=()
if [ "${3:-}" = --read-only ]; then extra=(--read-only --tmpfs /tmp); fi

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
chmod 777 "$dir"
printf '%s\n' '\documentclass{article}\usepackage{fontspec}' \
  '\begin{document}Hello.\end{document}' > "$dir/t.tex"

start=$(date +%s%N)
docker run --rm "${extra[@]}" --user 1000:1000 -e HOME=/tmp -v "$dir:/work" -w /work \
  "$image" lualatex -interaction=nonstopmode -halt-on-error t.tex > "$dir/out.txt" 2>&1 \
  || { tail -20 "$dir/out.txt"; exit 1; }
ms=$(( ($(date +%s%N) - start) / 1000000 ))
echo "lualatex as uid 1000 ${extra[*]}: ${ms} ms (limit ${limit} s)"
test "$ms" -le $(( limit * 1000 ))
