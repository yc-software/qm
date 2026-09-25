FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl wget jq tar xz-utils unzip zip \
    python3 python3-pip python3-venv \
    openssh-client gnupg less vim-tiny \
  && rm -rf /var/lib/apt/lists/* \
  && node --version && npm --version

RUN id -u user >/dev/null 2>&1 || useradd --create-home --user-group --shell /bin/bash user
RUN mkdir -p /home/user/workspace && chown -R user:user /home/user
