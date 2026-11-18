# syntax=docker/dockerfile:1
#
# Overfull images. Build context is the REPOSITORY ROOT:
#   docker build -f docker/Dockerfile -t overfull:dev .                              # full (default)
#   docker build -f docker/Dockerfile --build-arg TEX_FLAVOR=slim -t overfull:slim .  # slim
#   docker build -f docker/Dockerfile --target check -t overfull:check .              # no TeX
#
# Stages:
#   node-dist       Node.js 26 LTS (official binary, checksum-verified), nothing else
#   builder         node-dist + pnpm: bundles the CLI into one file (overfull.cjs, ~3 MB,
#                   templates embedded, no node_modules). No TeX Live here, so a code
#                   change never rebuilds or re-downloads a TeX layer.
#   verapdf         veraPDF (CLI only), and for the check image a Java runtime cut down
#                   with jlink to the modules veraPDF uses
#   texbase-full    TeX Live 2026, scheme-full (pinned digest)
#   texbase-slim    TeX Live 2026, scheme-basic + LuaTeX, XeTeX, the recommended LaTeX and
#                   font collections, latexdiff, the venue classes and common packages.
#                   Missing packages are installed from CTAN by `overfull build`
#                   (OVERFULL_TEX_INSTALL=1), as any user.
#   tex             texbase-$TEX_FLAVOR + fonts, poppler, qpdf, veraPDF; Debian packages
#                   come from snapshot.debian.org at DEBIAN_SNAPSHOT
#   check           Debian slim + Node + veraPDF (jlink'd Java) + poppler + git + CLI,
#                   no TeX Live
#   overfull        tex + Node + CLI (default target)
#
# Behind a TLS-intercepting proxy, pass its CA as an optional build secret; it is
# trusted only while a download step runs and never stored in a layer:
#   docker build --secret id=build_ca,src=/path/to/proxy-ca.crt -f docker/Dockerfile .

ARG TEX_FLAVOR=full

# ---------------------------------------------------------------------------
# node-dist: the Node.js binary, shared by every image
# ---------------------------------------------------------------------------
# Pinned by digest (multi-arch index: linux/amd64, linux/arm64).
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS node-dist

ARG NODE_VERSION=26.13.0
ARG NODE_SHA256_AMD64=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG NODE_SHA256_ARM64=406fe3fbde1c054adff8b297c16fdb5af6659db327c1ac8acd46b56ef1af9a92
ARG TARGETARCH

RUN --mount=type=secret,id=build_ca,required=false \
    set -eux; \
    apt-get update; \
    # libatomic1: Node.js 26 links against it (the builder stage runs node here).
    apt-get install --no-install-recommends -y ca-certificates curl xz-utils libatomic1; \
    if [ -s /run/secrets/build_ca ]; then cp /run/secrets/build_ca /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates >/dev/null; fi; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) node_arch=x64;   sum="${NODE_SHA256_AMD64}" ;; \
      arm64) node_arch=arm64; sum="${NODE_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    echo "${sum}  /tmp/node.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 --no-same-owner \
      --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/include' --exclude='*/share'; \
    rm /tmp/node.tar.xz; \
    rm -rf /var/lib/apt/lists/*; \
    /opt/node/bin/node --version

# ---------------------------------------------------------------------------
# builder: the CLI as one self-contained file
# ---------------------------------------------------------------------------
FROM node-dist AS builder
ENV PATH=/opt/node/bin:$PATH

# pnpm comes from docker/pnpm/package-lock.json: `npm ci` checks every package against
# its integrity hash.
COPY docker/pnpm/package.json docker/pnpm/package-lock.json /opt/pnpm/
RUN --mount=type=secret,id=build_ca,required=false \
    NODE_EXTRA_CA_CERTS=/run/secrets/build_ca npm ci --prefix /opt/pnpm --no-audit --no-fund \
 && ln -s /opt/pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm

WORKDIR /src
# Manifests first: the dependency layer is reused until a lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
RUN --mount=type=cache,id=pnpm-store,target=/root/.cache/pnpm-store \
    --mount=type=secret,id=build_ca,required=false \
    export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca \
 && pnpm config set store-dir /root/.cache/pnpm-store \
 && pnpm install --frozen-lockfile --filter overfull-monorepo --filter overfull...

COPY packages/core packages/core
COPY packages/cli packages/cli
COPY templates templates
COPY scripts/build-standalone.mjs scripts/
RUN node scripts/build-standalone.mjs \
 && mkdir -p /opt/overfull \
 && cp dist-standalone/overfull.cjs /opt/overfull/overfull.cjs \
 && node /opt/overfull/overfull.cjs --version

# ---------------------------------------------------------------------------
# verapdf: veraPDF, installed once for every image, and a small Java runtime
# ---------------------------------------------------------------------------
# The TeX images run veraPDF with the Java of the TeX Live base (Debian testing,
# OpenJDK 25). The check image gets the same Java version, cut down with jlink to the
# modules veraPDF needs: about 90 MB on disk instead of a 200 MB JRE. The module list
# is what `jdeps` finds in veraPDF's jar, plus java.naming, jdk.unsupported and
# jdk.charsets, which its XML binding and PDF parser load by name. Check a new
# veraPDF version with PDFs that pass and fail (see docker/README.md).
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS verapdf

ARG VERAPDF_VERSION=1.30.4
ARG VERAPDF_SHA256=04415ef3f149526a3048b9889723e81320ddf013bd891bcc7f0f297f3eadcc23

COPY docker/verapdf-auto-install.xml /tmp/verapdf-auto-install.xml
RUN --mount=type=secret,id=build_ca,required=false \
    set -eux; \
    apt-get update; \
    # binutils: jlink strips the native libraries with objcopy.
    apt-get install --no-install-recommends -y ca-certificates curl unzip binutils openjdk-25-jdk-headless; \
    if [ -s /run/secrets/build_ca ]; then cp /run/secrets/build_ca /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates >/dev/null; fi; \
    cd /tmp; \
    curl -fsSLo verapdf.zip "https://software.verapdf.org/releases/${VERAPDF_VERSION%.*}/verapdf-greenfield-${VERAPDF_VERSION}-installer.zip"; \
    echo "${VERAPDF_SHA256}  verapdf.zip" | sha256sum -c -; \
    unzip -q verapdf.zip; \
    java -jar "verapdf-greenfield-${VERAPDF_VERSION}/verapdf-izpack-installer-${VERAPDF_VERSION}.jar" /tmp/verapdf-auto-install.xml; \
    # The CLI jar has everything the command line needs; the GUI is not used.
    rm -rf /opt/verapdf/Uninstaller /opt/verapdf/verapdf-gui /opt/verapdf/bin/gui-*.jar; \
    jlink --output /opt/java --no-header-files --no-man-pages --strip-debug \
      --add-modules java.base,java.compiler,java.datatransfer,java.desktop,java.logging,java.management,java.naming,java.sql,java.xml,jdk.charsets,jdk.unsupported; \
    # Debian's JDK keeps the native debug symbols in separate files; the runtime needs none.
    find /opt/java -name '*.debuginfo' -delete; \
    JAVA_HOME=/opt/java /opt/verapdf/verapdf --version

# ---------------------------------------------------------------------------
# TeX Live bases
# ---------------------------------------------------------------------------
# Pinned by digest (multi-arch index: linux/amd64, linux/arm64). Written inline, not as
# an ARG, so Dependabot can propose digest updates.
FROM texlive/texlive:latest@sha256:07e8062637249c4f780ca59f42cc2ed592bc2dc1db4320769406aee3f98aa70e AS texbase-full

FROM texlive/texlive:latest-basic@sha256:e930edb4e2ef4ed70de1374b262e0ae15fe55ae1e6a10ea7c52e82618f42ad77 AS texbase-slim
# scheme-basic plus what most papers use: LuaLaTeX (the templates' engine) and XeLaTeX,
# the recommended LaTeX packages and fonts, biblatex with biber, latexdiff (for
# `overfull diff`), the classes of the venue profiles in venues/ with what they load,
# common packages, the Fira and Inconsolata fonts, and the packages the templates load.
# Everything else comes from CTAN when a document asks for it
# (docker/smoke/slim.sh checks the list offline).
# mirror.ctan.org sends each request to a random mirror, and one that is down or
# mid-sync fails the build, so try it a few times, then two fixed mirrors, and leave
# the redirector as the repository for on-demand installs.
# The TeX Live tree is then made writable for every user, in the same layer (a later
# chmod would copy the whole tree into a new layer): containers usually run with the
# host user's uid (`--user`), and on-demand installs must work for any of them.
RUN --mount=type=secret,id=build_ca,required=false \
    set -eux; \
    if [ -s /run/secrets/build_ca ]; then cp /run/secrets/build_ca /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates >/dev/null; fi; \
    pkgs="collection-luatex collection-latexrecommended collection-fontsrecommended \
      latexmk biblatex biblatex-ieee biber csquotes babel-english \
      pgf pgfplots siunitx cleveref tocloft lastpage fontsize setspace float \
      booktabs mathtools unicode-math fontspec microtype lm \
      xetex xetexconfig latexdiff ulem \
      ieeetran acmart llncs elsarticle revtex \
      xstring totpages hyperxmp ifoddpage ncctools relsize comment upquote preprint \
      aliascnt fontaxes libertine libertinus-fonts \
      enumitem multirow titlesec xurl algorithm2e algorithmicx algorithms tcolorbox \
      tikz-cd threeparttable makecell adjustbox newtx glossaries lipsum fontawesome5 \
      fira firamath inconsolata"; \
    ctan=https://mirror.ctan.org/systems/texlive/tlnet; \
    ok=; \
    for repo in "$ctan" "$ctan" "$ctan" \
        https://mirrors.mit.edu/CTAN/systems/texlive/tlnet \
        https://ftp.fau.de/ctan/systems/texlive/tlnet; do \
      if tlmgr --repository "$repo" install $pkgs; then ok=1; break; fi; \
      sleep 5; \
    done; \
    test -n "$ok"; \
    tlmgr option repository "$ctan"; \
    tlmgr path add; \
    rm -rf /usr/local/texlive/*/tlpkg/backups/* /usr/local/texlive/*/texmf-var/web2c/tlmgr*.log; \
    if [ -f /usr/local/share/ca-certificates/zz-build-ca.crt ]; then rm /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates --fresh >/dev/null; fi; \
    chmod -R a+rwX /usr/local/texlive
ENV OVERFULL_TEX_INSTALL=1

# ---------------------------------------------------------------------------
# tex: the LaTeX toolchain, fonts and PDF tools
# ---------------------------------------------------------------------------
FROM texbase-${TEX_FLAVOR} AS tex

# Debian packages come from snapshot.debian.org at this time, not from the moving
# testing suite, so a rebuild installs the same versions. It is at least as new as both
# TeX Live bases (they are built from different testing snapshots); were a base newer,
# that base's own snapshot is used. scripts/update-pins.mjs moves it after Dependabot
# moves the base digests.
ARG DEBIAN_SNAPSHOT=20261104T212339Z

ENV DEBIAN_FRONTEND=noninteractive \
    DEBCONF_NONINTERACTIVE_SEEN=true \
    LANG=C.UTF-8

# The Microsoft core fonts (Times New Roman and others) are not in Debian:
# ttf-mscorefonts-installer downloads them from SourceForge. They are fetched here
# instead, each checked against its SHA-256 (the hashes the package itself checks), so
# a SourceForge outage or a changed file fails the build at this step, with the file's
# name. The installer then takes them from that directory.
COPY <<'EOF' /tmp/mscorefonts.sha256
0524fe42951adc3a7eb870e32f0920313c71f170c859b5f770d82b4ee111e970  andale32.exe
85297a4d146e9c87ac6f74822734bdee5f4b2a722d7eaa584b7f2cbf76f478f6  arial32.exe
a425f0ffb6a1a5ede5b979ed6177f4f4f4fdef6ae7c302a7b7720ef332fec0a8  arialb32.exe
9c6df3feefde26d4e41d4a4fe5db2a89f9123a772594d7f59afd062625cd204e  comic32.exe
bb511d861655dde879ae552eb86b134d6fae67cb58502e6ff73ec5d9151f3384  courie32.exe
2c2c7dcda6606ea5cf08918fb7cd3f3359e9e84338dc690013f20cd42e930301  georgi32.exe
6061ef3b7401d9642f5dfdb5f2b376aa14663f6275e60a51207ad4facf2fccfb  impact32.exe
db56595ec6ef5d3de5c24994f001f03b2a13e37cee27bc25c58f6f43e8f807ab  times32.exe
5a690d9bb8510be1b8b4fe49f1f2319651fe51bbe54775ddddd8ef0bd07fdac9  trebuc32.exe
c1cb61255e363166794e47664e2f21af8e3a26cb6346eb8d2ae2fa85dd5aad96  verdan32.exe
64595b5abc1080fba8610c5c34fab5863408e806aafe84653ca8575bed17d75a  webdin32.exe
EOF
# Fonts (the Microsoft core fonts, FreeMono/FreeSerif) and PDF inspection tools. Java
# comes with the TeX Live base image. One layer, so nothing downloaded is kept. The
# original apt sources are put back at the end, so `apt-get install` in a container
# uses the live suite.
RUN --mount=type=secret,id=build_ca,required=false \
    set -eux; \
    src=/etc/apt/sources.list.d/debian.sources; \
    cp "$src" /tmp/debian.sources.orig; \
    base_snapshot="$(sed -n 's|^# http://snapshot.debian.org/archive/debian/\([0-9]\{8\}T[0-9]\{6\}Z\)$|\1|p' "$src" | head -n 1)"; \
    snapshot="$(printf '%s\n' "$DEBIAN_SNAPSHOT" "$base_snapshot" | sort | tail -n 1)"; \
    sed -i \
      -e "s|^URIs: http://deb.debian.org/debian-security\$|URIs: http://snapshot.debian.org/archive/debian-security/$snapshot|" \
      -e "s|^URIs: http://deb.debian.org/debian\$|URIs: http://snapshot.debian.org/archive/debian/$snapshot|" \
      -e 's/^Components: main$/Components: main contrib non-free/' "$src"; \
    ! grep -q '^URIs: http://deb.debian.org' "$src"; \
    # A snapshot's Release files are past their Valid-Until date; the signatures are
    # still checked. snapshot.debian.org can be slow, so retry.
    apt-get -o Acquire::Check-Valid-Until=false -o Acquire::Retries=5 update; \
    apt-get -o Acquire::Retries=5 install --no-install-recommends -y ca-certificates curl cabextract; \
    if [ -s /run/secrets/build_ca ]; then cp /run/secrets/build_ca /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates >/dev/null; fi; \
    mkdir /tmp/mscorefonts; \
    for f in $(awk '{print $2}' /tmp/mscorefonts.sha256); do \
      for root in https://downloads.sourceforge.net/corefonts \
          https://netcologne.dl.sourceforge.net/sourceforge/corefonts \
          https://jaist.dl.sourceforge.net/sourceforge/corefonts; do \
        curl -fsSL --retry 3 -o "/tmp/mscorefonts/$f" "$root/$f" && break; \
      done; \
    done; \
    (cd /tmp/mscorefonts && sha256sum -c /tmp/mscorefonts.sha256); \
    printf '%s\n' \
      'ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true' \
      'ttf-mscorefonts-installer msttcorefonts/dldir string /tmp/mscorefonts' | debconf-set-selections; \
    apt-get -o Acquire::Retries=5 install --no-install-recommends -y \
      fontconfig ttf-mscorefonts-installer fonts-freefont-ttf poppler-utils qpdf; \
    test -f /usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf; \
    rm -rf /tmp/mscorefonts /tmp/mscorefonts.sha256; \
    echo 'ttf-mscorefonts-installer msttcorefonts/dldir string' | debconf-set-selections; \
    if [ -f /usr/local/share/ca-certificates/zz-build-ca.crt ]; then rm /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates --fresh >/dev/null; fi; \
    mv /tmp/debian.sources.orig "$src"; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fc-cache -f; \
    # LuaLaTeX's font list (luaotfload) and the caches of the common fonts, built once
    # into TEXMFSYSVAR and writable for every user. luaotfload reads its list only from
    # the first writable cache directory; were that the user's own (empty) directory, as
    # for any non-root user, each container would rebuild the list (about a minute
    # with all of TeX Live).
    sysvar="$(kpsewhich -var-value TEXMFSYSVAR)"; \
    TEXMFVAR="$sysvar" luaotfload-tool -q -u -f; \
    mkdir /tmp/warm; \
    printf '%s\n' '\documentclass{article}\usepackage{unicode-math}' \
      '\begin{document}Text \textbf{bold} \emph{it} \texttt{mono} $x+1$\end{document}' > /tmp/warm/warm.tex; \
    (cd /tmp/warm && TEXMFVAR="$sysvar" lualatex -interaction=nonstopmode warm.tex >/dev/null); \
    rm -rf /tmp/warm; \
    chmod a+rwx "$sysvar"; \
    chmod -R a+rwX "$sysvar/luatex-cache"

# veraPDF (greenfield, CLI only) for PDF/UA, run with the base image's Java. After the
# fonts, so a veraPDF update reuses the layer above.
COPY --from=verapdf /opt/verapdf /opt/verapdf
RUN ln -s /opt/verapdf/verapdf /usr/local/bin/verapdf && verapdf --version

WORKDIR /work
CMD ["bash"]

# ---------------------------------------------------------------------------
# check: CLI + veraPDF + poppler + git, no TeX Live (`--target check`)
# ---------------------------------------------------------------------------
# For checking a PDF that was built elsewhere. Placed before `overfull` so the full
# image stays the default (last) stage.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS check

ENV DEBIAN_FRONTEND=noninteractive \
    DEBCONF_NONINTERACTIVE_SEEN=true \
    LANG=C.UTF-8 \
    JAVA_HOME=/opt/java

RUN set -eux; \
    apt-get update; \
    apt-get install --no-install-recommends -y ca-certificates poppler-utils git libatomic1; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    pdfinfo -v; git --version
# veraPDF with the jlink'd Java runtime (see the verapdf stage).
COPY --from=verapdf /opt/java /opt/java
COPY --from=verapdf /opt/verapdf /opt/verapdf
RUN ln -s /opt/verapdf/verapdf /usr/local/bin/verapdf && verapdf --version

# The version and labels come after the heavy layer above, so a release reuses it.
ARG VERSION=dev
LABEL org.opencontainers.image.title="overfull (check only)" \
      org.opencontainers.image.description="The overfull CLI with veraPDF, poppler and git, without TeX Live: checks PDFs, logs and bibliographies built elsewhere" \
      org.opencontainers.image.source="https://github.com/amet13/overfull" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

COPY --from=node-dist /opt/node/bin/node /usr/local/bin/node
COPY --from=builder /opt/overfull/overfull.cjs /opt/overfull/overfull.cjs
COPY docker/overfull /usr/local/bin/overfull
RUN overfull --version && git config --system --add safe.directory /work

WORKDIR /work
CMD ["overfull", "--help"]

# ---------------------------------------------------------------------------
# overfull: TeX Live + tools + CLI (default target)
# ---------------------------------------------------------------------------
FROM tex AS overfull

ARG VERSION=dev
LABEL org.opencontainers.image.title="overfull" \
      org.opencontainers.image.description="Preflight kit for LaTeX papers and theses: TeX Live 2026, veraPDF, poppler, latexdiff and the overfull CLI" \
      org.opencontainers.image.source="https://github.com/amet13/overfull" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

# Node.js and the CLI last: they change most often and are a few MB, so an update
# reuses every TeX layer above.
COPY --from=node-dist /opt/node/bin/node /usr/local/bin/node
COPY --from=builder /opt/overfull/overfull.cjs /opt/overfull/overfull.cjs
COPY docker/overfull /usr/local/bin/overfull
# git (already in the base image) is needed by `overfull diff`. Only the repository
# mounted at /work is marked safe (the container runs as root by default and the
# mount is owned by the host user); never '*'.
RUN overfull --version && git config --system --add safe.directory /work

WORKDIR /work
CMD ["overfull", "--help"]
