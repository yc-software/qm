FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl wget jq tar xz-utils unzip zip \
    python3 python3-pip python3-venv \
    openssh-client gnupg less vim-tiny \
  && rm -rf /var/lib/apt/lists/* \
  && node --version && npm --version

RUN npm install -g --allow-scripts=@anthropic-ai/claude-code \
      @anthropic-ai/claude-code@2.1.210 \
      @openai/codex@0.144.4 \
  && claude --version \
  && codex --version

ARG GH_VERSION=2.93.0
ARG GH_SHA256=02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0
RUN curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tgz \
  && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
  && tar xzf /tmp/gh.tgz -C /tmp \
  && install "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh* \
  && gh --version

ARG AWSCLI_VERSION=2.34.54
ARG AWSCLI_SHA256=de278754dec97e0f6e9b4e8167d4bd1a27004c3e56e9c2da10002597f76ca35a
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip" -o /tmp/awscliv2.zip \
  && echo "${AWSCLI_SHA256}  /tmp/awscliv2.zip" | sha256sum -c - \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip \
  && aws --version

RUN python3 -m venv /opt/agent-venv \
  && /opt/agent-venv/bin/pip install --no-cache-dir --upgrade pip
ENV PATH="/opt/agent-venv/bin:${PATH}"
ENV VIRTUAL_ENV=/opt/agent-venv

COPY fly/tools/x-api /usr/local/bin/x-api
RUN chmod +x /usr/local/bin/x-api

RUN id -u user >/dev/null 2>&1 || useradd --create-home --user-group --shell /bin/bash user
RUN chown -R user:user /opt/agent-venv \
  && mkdir -p /home/user/workspace /home/user/.config /home/user/.cache /home/user/.local/bin \
  && chown -R user:user /home/user
