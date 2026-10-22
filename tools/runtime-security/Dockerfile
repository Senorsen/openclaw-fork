# Patch only the runtime of an already-built Claw image: /app stays unchanged.
ARG NODE_IMAGE=node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG BASE_IMAGE
FROM ${NODE_IMAGE} AS patched-node
FROM ${BASE_IMAGE}
USER root
COPY --from=patched-node /usr/local/bin/node /usr/local/bin/node
COPY --from=patched-node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
# Preserve the parent's corepack/pnpm and all Claw/native-addon files.
# Only update the installed Python, TLS/CA and HTTP-client distribution packages.
RUN apt-get update && \
    packages="$(dpkg-query -W -f='${binary:Package} ${db:Status-Status}\n' | awk '$2 == "installed" && $1 ~ /^(python3|libpython3|ca-certificates|openssl|libssl3|curl|libcurl|libgnutls|libnss3)/ {print $1}')" && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --only-upgrade $packages && \
    update-ca-certificates && \
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge '20250419~deb12u2' && \
    test "$(node -v)" = 'v24.22.1' && \
    apt-get clean
COPY verify.mjs /opt/runtime-security-20261022/verify.mjs
RUN node /opt/runtime-security-20261022/verify.mjs
USER node
