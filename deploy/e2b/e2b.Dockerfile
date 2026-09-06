# QM base template for the e2b sandbox backend.
# Mirrors the tool contract advertised in src/sandbox/e2b-sandbox.ts profile:
# git, curl, jq, tar, python3 + Node — on Ubuntu, home at /home/user.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl wget jq tar xz-utils unzip zip \
    python3 python3-pip python3-venv \
    openssh-client gnupg less vim-tiny \
  && rm -rf /var/lib/apt/lists/*

# Node 24 (matches the core's runtime major)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && node --version && npm --version

# e2b guest convention: user 'user', home /home/user (already present in
# their base images; create it for a stock ubuntu base).
RUN id user 2>/dev/null || useradd -m -u 1000 -s /bin/bash user || usermod -l user -d /home/user -m ubuntu
RUN mkdir -p /home/user/workspace && chown -R user:user /home/user
