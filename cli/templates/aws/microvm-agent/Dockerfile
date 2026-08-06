FROM public.ecr.aws/lambda/microvms:al2023-minimal@sha256:05cb9b38d841e7ff1b693dc9e894909612f340bf99ec97d426e8000a5bbe96c3

RUN dnf install -y \
      curl-minimal findutils tar git wget jq unzip \
      python3 python3-pip nodejs24 nodejs24-npm \
  && dnf clean all \
  && rpm -q openssl-snapsafe-libs \
  && curl --version \
  && node --version \
  && npm --version \
  && npx --version \
  && setsid --version \
  && seq 1 1

RUN curl -fsSL https://cli.github.com/packages/rpm/gh-cli.repo \
       -o /etc/yum.repos.d/gh-cli.repo \
  && dnf install -y gh-2.97.0-1 \
  && dnf clean all \
  && gh --version

RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-2.36.5.zip" -o /tmp/awscliv2.zip \
  && echo "2662774cf3e70e2203ca1e6b85b84ff8438f6638523ea9d474f9731472740d85  /tmp/awscliv2.zip" | sha256sum -c - \
  && unzip -q /tmp/awscliv2.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscliv2.zip \
  && aws --version

RUN ARCH="$(uname -m)" && case "$ARCH" in \
      x86_64) LS_ARCH=amd64; LS_SHA=eb75a3de5cab03875cdae9f5f539e6aedadd66607003d9b1e7a9077948818ba0 ;; \
      aarch64) LS_ARCH=arm64; LS_SHA=9585f5a508516bd66af2b2376bab4de256a5ef8e2b73ec760559e679628f2d59 ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; esac \
  && curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-${LS_ARCH}.tar.gz" -o /tmp/litestream.tgz \
  && echo "${LS_SHA}  /tmp/litestream.tgz" | sha256sum -c - \
  && tar -xzf /tmp/litestream.tgz -C /usr/local/bin litestream \
  && rm /tmp/litestream.tgz \
  && litestream version

RUN python3 -m venv /opt/agent-venv \
  && /opt/agent-venv/bin/pip install --no-cache-dir --upgrade pip
ENV PATH="/opt/agent-venv/bin:${PATH}"
ENV VIRTUAL_ENV=/opt/agent-venv

COPY agent.mjs /opt/microvm-agent/agent.mjs

ENV HOME=/root
WORKDIR /root

CMD ["node", "/opt/microvm-agent/agent.mjs"]
