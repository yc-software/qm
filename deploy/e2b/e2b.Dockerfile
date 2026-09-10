# QM base template for the e2b sandbox backend.
# Mirrors the tool contract advertised in src/sandbox/e2b-sandbox.ts profile:
# git, curl, jq, tar, python3 + Node — on Ubuntu, home at /home/user.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl wget jq tar xz-utils unzip zip \
    python3 python3-pip python3-venv \
    openssh-client gnupg less vim-tiny libatomic1 \
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

ARG TARGETARCH
ARG ASIDE_CLI_VERSION=1.26.906.1630
RUN case "$TARGETARCH" in \
      amd64) ASIDE_ARCH=x64; ASIDE_SHA=092751c803a3a1c393af5a15b275f07b8663c53eb15851645d80521b170dacf8 ;; \
      arm64) ASIDE_ARCH=arm64; ASIDE_SHA=0c70914864b8811154d021087419b718a39bee52a7cf948fc73e6f5087f0adf5 ;; \
      *) exit 1 ;; \
    esac \
  && curl -fsSL "https://releases.aside.com/cli/AsideCLI-linux-${ASIDE_ARCH}-${ASIDE_CLI_VERSION}.tar.gz" -o /tmp/aside.tgz \
  && echo "$ASIDE_SHA  /tmp/aside.tgz" | sha256sum -c - \
  && tar xzf /tmp/aside.tgz -C /tmp \
  && install /tmp/aside /usr/local/bin/aside \
  && rm -f /tmp/aside /tmp/aside.tgz \
  && aside --version
