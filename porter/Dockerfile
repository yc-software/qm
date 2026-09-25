FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS node-runtime

FROM debian:12-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk \
      git curl wget jq unzip \
      python3 python3-venv python3-pip \
      ca-certificates gnupg \
  && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/ /usr/local/

ARG TARGETARCH
ARG GH_VERSION=2.93.0
RUN case "$TARGETARCH" in \
      amd64) GH_SHA=02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0 ;; \
      arm64) GH_SHA=c55feb33684abba57e9909737340d5b39282257c0363e1edde6785ac4a413be7 ;; \
      *) exit 1 ;; \
    esac \
  && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" -o /tmp/gh.tgz \
  && echo "$GH_SHA  /tmp/gh.tgz" | sha256sum -c - \
  && tar xzf /tmp/gh.tgz -C /tmp \
  && install "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
  && rm -rf /tmp/gh* \
  && gh --version \
  && rm -rf /root/.local/state/gh

ARG AWSCLI_VERSION=2.34.54
RUN case "$TARGETARCH" in \
      amd64) AWS_ARCH=x86_64; AWS_SHA=de278754dec97e0f6e9b4e8167d4bd1a27004c3e56e9c2da10002597f76ca35a ;; \
      arm64) AWS_ARCH=aarch64; AWS_SHA=f381be152a868ccfdd0cb7cb235916b1dd8024e388bdeef0c385fb33af131a60 ;; \
      *) exit 1 ;; \
    esac \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}-${AWSCLI_VERSION}.zip" -o /tmp/awscliv2.zip \
  && echo "$AWS_SHA  /tmp/awscliv2.zip" | sha256sum -c - \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip \
  && aws --version

RUN python3 -m venv /opt/agent-venv \
  && /opt/agent-venv/bin/pip install --no-cache-dir --upgrade pip
ENV PATH="/opt/agent-venv/bin:${PATH}"
ENV VIRTUAL_ENV=/opt/agent-venv

RUN timeout -k 1 5 true && setsid true && node --version && python3 --version

WORKDIR /root

CMD ["sleep", "infinity"]
