FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

RUN apk add --no-cache ca-certificates curl git git-daemon docker-cli

ARG GROK_VERSION=1.0.13
ARG GROK_LICENSE_REV=bb7f39d5858cbf5e00de639367f59debbdcb0138
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) GROK_ARCH=x86_64; GROK_NPM_ARCH=x64; GROK_SHA256=edf79521581bb5e6b95abef848491a6a742e860da3e237ebe86a280d30dce4c1; GROK_NOTICE_TARBALL_SHA256=27279bca974ef4cd2b1695ab8bb43be1a0e0c95d9bed9e4f19be064221546ef3 ;; \
      arm64) GROK_ARCH=aarch64; GROK_NPM_ARCH=arm64; GROK_SHA256=b926fc5308374396e260e7efbd6107231a8dae13c084ddaf0fe89b7ebb3edd25; GROK_NOTICE_TARBALL_SHA256=d7b66d698b8ae78c31eaaa344acfe47092023fad0966b3474eb9a032da322527 ;; \
      *) echo "unsupported Grok architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "https://x.ai/cli/grok-${GROK_VERSION}-linux-${GROK_ARCH}" -o /tmp/grok \
  && echo "${GROK_SHA256}  /tmp/grok" | sha256sum -c - \
  && install -m 0755 /tmp/grok /usr/local/bin/grok \
  && mkdir -p /usr/share/licenses/grok-build \
  && curl -fsSL "https://raw.githubusercontent.com/xai-org/grok-build/${GROK_LICENSE_REV}/LICENSE" -o /usr/share/licenses/grok-build/LICENSE \
  && echo "116f7778b9802e569b7fa3a532b17bd80eb13c67837def01eed093d4ea472f28  /usr/share/licenses/grok-build/LICENSE" | sha256sum -c - \
  && curl -fsSL "https://registry.npmjs.org/@xai-official/grok-linux-${GROK_NPM_ARCH}/-/grok-linux-${GROK_NPM_ARCH}-${GROK_VERSION}.tgz" -o /tmp/grok-platform.tgz \
  && echo "${GROK_NOTICE_TARBALL_SHA256}  /tmp/grok-platform.tgz" | sha256sum -c - \
  && tar -xOzf /tmp/grok-platform.tgz package/THIRD_PARTY_NOTICES.md > /tmp/THIRD-PARTY-NOTICES \
  && echo "e8785a6098a7ee780cd2db35745b8e53061cfb1b6da19147a308579466ea4e50  /tmp/THIRD-PARTY-NOTICES" | sha256sum -c - \
  && install -m 0644 /tmp/THIRD-PARTY-NOTICES /usr/share/licenses/grok-build/THIRD-PARTY-NOTICES \
  && rm /tmp/grok /tmp/grok-platform.tgz /tmp/THIRD-PARTY-NOTICES \
  && test ! -e /root/.grok

COPY deploy/core/grok-requirements.toml /etc/grok/requirements.toml
RUN chown root:root /etc/grok/requirements.toml \
  && chmod 0644 /etc/grok/requirements.toml

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm audit --omit=dev --audit-level=moderate \
  && rm -rf /root/.npm /tmp/node-compile-cache

COPY src ./src
COPY cli/templates/slack-manifest.json ./cli/templates/slack-manifest.json
COPY skills-seed ./skills-seed
COPY plugins/onboarding ./plugins/onboarding
COPY plugins/chassis ./plugins/chassis
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV DATA_DIR=/data
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080

USER node
CMD ["node", "src/index.ts"]
