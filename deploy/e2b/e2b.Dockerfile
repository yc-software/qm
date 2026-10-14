FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl wget jq tar xz-utils unzip zip \
    python3 python3-pip python3-venv \
    openssh-client gnupg less vim-tiny \
  && rm -rf /var/lib/apt/lists/* \
  && node --version && npm --version

ARG AWSCLI_VERSION=2.34.54
ARG AWSCLI_SHA256=de278754dec97e0f6e9b4e8167d4bd1a27004c3e56e9c2da10002597f76ca35a
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip" -o /tmp/awscliv2.zip \
  && echo "${AWSCLI_SHA256}  /tmp/awscliv2.zip" | sha256sum -c - \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip \
  && aws --version

RUN id -u user >/dev/null 2>&1 || useradd --create-home --user-group --shell /bin/bash user
RUN mkdir -p /home/user/workspace && chown -R user:user /home/user
