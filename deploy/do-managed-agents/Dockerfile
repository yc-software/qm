FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

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
