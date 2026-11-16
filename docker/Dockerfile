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
#   texbase-full    TeX Live 2026, scheme-full (pinned digest)
#   texbase-slim    TeX Live 2026, scheme-basic + LuaTeX + the recommended LaTeX and font
#                   collections + what the templates use. Missing packages are installed
#                   from CTAN by `overfull build` (OVERFULL_TEX_INSTALL=1).
#   tex             texbase-$TEX_FLAVOR + fonts, poppler, qpdf, veraPDF
#   check           Debian slim + Node + veraPDF + poppler + git + CLI, no TeX Live
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
# TeX Live bases
# ---------------------------------------------------------------------------
# Pinned by digest (multi-arch index: linux/amd64, linux/arm64). Written inline, not as
# an ARG, so Dependabot can propose digest updates.
FROM texlive/texlive:latest@sha256:07e8062637249c4f780ca59f42cc2ed592bc2dc1db4320769406aee3f98aa70e AS texbase-full

FROM texlive/texlive:latest-basic@sha256:e930edb4e2ef4ed70de1374b262e0ae15fe55ae1e6a10ea7c52e82618f42ad77 AS texbase-slim
# scheme-basic plus what most papers use: LuaLaTeX (the templates' engine), the
# recommended LaTeX packages and fonts, biblatex with biber, and the packages the
# templates load. Everything else comes from CTAN when a document asks for it.
RUN set -eux; \
    tlmgr install \
      collection-luatex collection-latexrecommended collection-fontsrecommended \
      latexmk biblatex biblatex-ieee biber csquotes babel-english \
      pgf pgfplots siunitx cleveref tocloft lastpage fontsize setspace float \
      booktabs mathtools unicode-math fontspec microtype lm; \
    tlmgr path add; \
    rm -rf /usr/local/texlive/*/tlpkg/backups/* /usr/local/texlive/*/texmf-var/web2c/tlmgr.log
ENV OVERFULL_TEX_INSTALL=1

# ---------------------------------------------------------------------------
# tex: the LaTeX toolchain, fonts and PDF tools
# ---------------------------------------------------------------------------
FROM texbase-${TEX_FLAVOR} AS tex

ARG VERAPDF_VERSION=1.30.4
ARG VERAPDF_SHA256=04415ef3f149526a3048b9889723e81320ddf013bd891bcc7f0f297f3eadcc23

ENV DEBIAN_FRONTEND=noninteractive \
    DEBCONF_NONINTERACTIVE_SEEN=true \
    LANG=C.UTF-8

# Fonts (Times New Roman via ttf-mscorefonts-installer, FreeMono/FreeSerif) and PDF
# inspection tools; veraPDF (greenfield, CLI only) for PDF/UA. Java comes with the
# TeX Live base image. One layer, so nothing downloaded is kept.
COPY docker/verapdf-auto-install.xml /tmp/verapdf-auto-install.xml
RUN --mount=type=secret,id=build_ca,required=false \
    set -eux; \
    sed -i 's/^Components: main$/Components: main contrib non-free/' /etc/apt/sources.list.d/debian.sources; \
    echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections; \
    apt-get update; \
    apt-get install --no-install-recommends -y ca-certificates curl unzip; \
    if [ -s /run/secrets/build_ca ]; then cp /run/secrets/build_ca /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates >/dev/null; fi; \
    apt-get install --no-install-recommends -y \
      fontconfig ttf-mscorefonts-installer fonts-freefont-ttf poppler-utils qpdf; \
    test -f /usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf; \
    cd /tmp; \
    curl -fsSLo verapdf.zip "https://software.verapdf.org/releases/${VERAPDF_VERSION%.*}/verapdf-greenfield-${VERAPDF_VERSION}-installer.zip"; \
    echo "${VERAPDF_SHA256}  verapdf.zip" | sha256sum -c -; \
    unzip -q verapdf.zip; \
    java -jar "verapdf-greenfield-${VERAPDF_VERSION}/verapdf-izpack-installer-${VERAPDF_VERSION}.jar" /tmp/verapdf-auto-install.xml; \
    ln -s /opt/verapdf/verapdf /usr/local/bin/verapdf; \
    rm -rf /tmp/verapdf* /opt/verapdf/Uninstaller; \
    if [ -f /usr/local/share/ca-certificates/zz-build-ca.crt ]; then rm /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates --fresh >/dev/null; fi; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    fc-cache -f; \
    luaotfload-tool -q -u -f; \
    verapdf --version

WORKDIR /work
CMD ["bash"]

# ---------------------------------------------------------------------------
# check: CLI + veraPDF + poppler + git, no TeX Live (`--target check`)
# ---------------------------------------------------------------------------
# For checking a PDF that was built elsewhere. Placed before `overfull` so the full
# image stays the default (last) stage.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2 AS check

ARG VERSION=dev
ARG VERAPDF_VERSION=1.30.4
ARG VERAPDF_SHA256=04415ef3f149526a3048b9889723e81320ddf013bd891bcc7f0f297f3eadcc23

LABEL org.opencontainers.image.title="overfull (check only)" \
      org.opencontainers.image.description="The overfull CLI with veraPDF, poppler and git, without TeX Live: checks PDFs, logs and bibliographies built elsewhere" \
      org.opencontainers.image.source="https://github.com/amet13/overfull" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

ENV DEBIAN_FRONTEND=noninteractive \
    DEBCONF_NONINTERACTIVE_SEEN=true \
    LANG=C.UTF-8

COPY docker/verapdf-auto-install.xml /tmp/verapdf-auto-install.xml
RUN --mount=type=secret,id=build_ca,required=false \
    set -eux; \
    apt-get update; \
    apt-get install --no-install-recommends -y ca-certificates curl unzip; \
    if [ -s /run/secrets/build_ca ]; then cp /run/secrets/build_ca /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates >/dev/null; fi; \
    apt-get install --no-install-recommends -y default-jre-headless poppler-utils git libatomic1; \
    cd /tmp; \
    curl -fsSLo verapdf.zip "https://software.verapdf.org/releases/${VERAPDF_VERSION%.*}/verapdf-greenfield-${VERAPDF_VERSION}-installer.zip"; \
    echo "${VERAPDF_SHA256}  verapdf.zip" | sha256sum -c -; \
    unzip -q verapdf.zip; \
    java -jar "verapdf-greenfield-${VERAPDF_VERSION}/verapdf-izpack-installer-${VERAPDF_VERSION}.jar" /tmp/verapdf-auto-install.xml; \
    ln -s /opt/verapdf/verapdf /usr/local/bin/verapdf; \
    rm -rf /tmp/verapdf* /opt/verapdf/Uninstaller; \
    if [ -f /usr/local/share/ca-certificates/zz-build-ca.crt ]; then rm /usr/local/share/ca-certificates/zz-build-ca.crt && update-ca-certificates --fresh >/dev/null; fi; \
    apt-get purge -y --auto-remove curl unzip; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*; \
    verapdf --version; pdfinfo -v; git --version

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
