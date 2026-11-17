#!/bin/sh
# Tests install.sh against a local fake release served over HTTP.
# Cases: a good download installs a working file; a tampered one installs nothing; a
# release with gzip copies installs from the .gz; a tampered .gz installs nothing;
# with gh logged in, a passing attestation installs and a failing one installs nothing.
# A fake gh comes first on PATH, so a real, logged-in gh never runs here.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
pid=""
cleanup() {
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64) asset=overfull-linux-x64 ;;
  Linux-aarch64 | Linux-arm64) asset=overfull-linux-arm64 ;;
  Darwin-arm64) asset=overfull-darwin-arm64 ;;
  Darwin-x86_64) asset=overfull-darwin-x64 ;;
  *) echo "test-install: unsupported platform, skipped"; exit 0 ;;
esac

if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d ' ' -f 1; }
else sum() { shasum -a 256 "$1" | cut -d ' ' -f 1; }; fi

# Fake gh: FAKE_GH=out (not logged in, the default), ok (attestation passes) or fail.
mkdir -p "$work/fakebin"
cat > "$work/fakebin/gh" <<'GH'
#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_GH_LOG"
case "$1" in
  auth) [ "${FAKE_GH:-out}" != out ] ;;
  attestation) [ "$3" = --help ] || [ "${FAKE_GH:-out}" = ok ] ;;
  *) exit 1 ;;
esac
GH
chmod +x "$work/fakebin/gh"
PATH="$work/fakebin:$PATH"
FAKE_GH_LOG="$work/gh.log"
export PATH FAKE_GH_LOG

good="$work/good"
bad="$work/bad"
mkdir -p "$good" "$bad"
printf '#!/bin/sh\necho "overfull 0.0.0-test"\n' > "$good/$asset"
printf '%s  %s\n' "$(sum "$good/$asset")" "$asset" > "$good/SHA256SUMS"
# The tampered release has the genuine checksum for different file content.
cp "$good/SHA256SUMS" "$bad/SHA256SUMS"
printf '#!/bin/sh\necho tampered\n' > "$bad/$asset"

serve() { # serve <dir> <port>
  (cd "$1" && exec python3 -m http.server "$2" --bind 127.0.0.1 >/dev/null 2>&1) &
  pid=$!
  i=0
  while ! python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$2/SHA256SUMS')" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 50 ] || { echo "test-install: server did not start" >&2; exit 1; }
    sleep 0.2
  done
}
stop() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; pid=""; }

port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"

echo "case 1: good download installs a working file"
serve "$good" "$port"
OVERFULL_BASE_URL="http://127.0.0.1:$port" OVERFULL_INSTALL_DIR="$work/out1/bin" sh "$root/install.sh"
out="$("$work/out1/bin/overfull" --version)"
[ "$out" = "overfull 0.0.0-test" ] || { echo "FAIL: unexpected version output: $out" >&2; exit 1; }
stop

echo "case 2: tampered download fails and installs nothing"
serve "$bad" "$port"
if OVERFULL_BASE_URL="http://127.0.0.1:$port" OVERFULL_INSTALL_DIR="$work/out2/bin" sh "$root/install.sh"; then
  echo "FAIL: install.sh succeeded on a tampered download" >&2
  exit 1
fi
[ ! -e "$work/out2/bin/overfull" ] || { echo "FAIL: a file was installed" >&2; exit 1; }
stop

echo "case 3: a release with a .gz copy installs from it"
gz="$work/gz"
mkdir -p "$gz"
printf '#!/bin/sh\necho "overfull 0.0.0-gz"\n' > "$gz/$asset"
gzip -9 -c "$gz/$asset" > "$gz/$asset.gz"
printf '%s  %s\n%s  %s\n' "$(sum "$gz/$asset")" "$asset" "$(sum "$gz/$asset.gz")" "$asset.gz" > "$gz/SHA256SUMS"
mv "$gz/$asset" "$work/plain-not-served"
serve "$gz" "$port"
OVERFULL_BASE_URL="http://127.0.0.1:$port" OVERFULL_INSTALL_DIR="$work/out3/bin" sh "$root/install.sh"
out="$("$work/out3/bin/overfull" --version)"
[ "$out" = "overfull 0.0.0-gz" ] || { echo "FAIL: unexpected version output: $out" >&2; exit 1; }
stop

echo "case 4: a .gz that does not match its checksum installs nothing"
gzip -9 -c "$bad/$asset" > "$gz/$asset.gz"
serve "$gz" "$port"
if OVERFULL_BASE_URL="http://127.0.0.1:$port" OVERFULL_INSTALL_DIR="$work/out4/bin" sh "$root/install.sh"; then
  echo "FAIL: install.sh succeeded on a tampered .gz" >&2
  exit 1
fi
[ ! -e "$work/out4/bin/overfull" ] || { echo "FAIL: a file was installed" >&2; exit 1; }
stop

echo "case 5: gh logged in and the attestation verifies: installs"
serve "$good" "$port"
: > "$FAKE_GH_LOG"
FAKE_GH=ok OVERFULL_BASE_URL="http://127.0.0.1:$port" OVERFULL_INSTALL_DIR="$work/out5/bin" sh "$root/install.sh"
[ -x "$work/out5/bin/overfull" ] || { echo "FAIL: nothing installed" >&2; exit 1; }
grep -q "^attestation verify .*/$asset --repo amet13/overfull\$" "$FAKE_GH_LOG" ||
  { echo "FAIL: gh attestation verify was not run on the download" >&2; cat "$FAKE_GH_LOG" >&2; exit 1; }
stop

echo "case 6: gh logged in and the attestation fails: installs nothing"
serve "$good" "$port"
if FAKE_GH=fail OVERFULL_BASE_URL="http://127.0.0.1:$port" OVERFULL_INSTALL_DIR="$work/out6/bin" sh "$root/install.sh"; then
  echo "FAIL: install.sh succeeded although the attestation failed" >&2
  exit 1
fi
[ ! -e "$work/out6/bin/overfull" ] || { echo "FAIL: a file was installed" >&2; exit 1; }
stop

echo "case 7: gh not logged in: the checksum alone installs"
serve "$good" "$port"
: > "$FAKE_GH_LOG"
OVERFULL_BASE_URL="http://127.0.0.1:$port" OVERFULL_INSTALL_DIR="$work/out7/bin" sh "$root/install.sh"
[ -x "$work/out7/bin/overfull" ] || { echo "FAIL: nothing installed" >&2; exit 1; }
if grep -q "^attestation verify .*$asset" "$FAKE_GH_LOG"; then
  echo "FAIL: gh attestation verify ran without a login" >&2
  exit 1
fi
stop

echo "test-install: ok"
