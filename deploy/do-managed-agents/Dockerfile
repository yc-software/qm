FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl wget jq tar xz-utils unzip zip ripgrep \
    python3 python3-pip python3-venv \
    openssh-client gnupg less vim-tiny procps \
  && rm -rf /var/lib/apt/lists/* \
  && node --version && npm --version

ENV HOME=/workspace/home
ENTRYPOINT ["sleep", "infinity"]
CMD []
