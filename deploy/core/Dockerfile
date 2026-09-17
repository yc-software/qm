FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS wireproxy-build

RUN apk add --no-cache go \
  && CGO_ENABLED=0 GOBIN=/out go install github.com/windtf/wireproxy/cmd/wireproxy@v1.1.2

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS connector-sdk-build
WORKDIR /app
COPY deploy/connector-sdk ./deploy/connector-sdk
RUN npm ci --prefix deploy/connector-sdk --ignore-scripts --no-audit --no-fund \
  && node deploy/connector-sdk/build.mjs

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

RUN apk add --no-cache ca-certificates curl git git-daemon docker-cli

COPY --from=wireproxy-build /out/wireproxy /usr/local/bin/wireproxy

WORKDIR /app

COPY package.json package-lock.json ./
COPY .husky/install.mjs .husky/install.mjs
RUN npm ci --omit=dev && npm audit --omit=dev --audit-level=moderate \
  && rm -rf /root/.npm /tmp/node-compile-cache

COPY --from=connector-sdk-build /app/.generated/connector-sdk ./.generated/connector-sdk
COPY src ./src
COPY scripts/migrate-transcript-tape.ts ./scripts/migrate-transcript-tape.ts
COPY scripts/qualify-transcript-cutover.ts ./scripts/qualify-transcript-cutover.ts
COPY scripts/lib/transcript-tape-migration.ts ./scripts/lib/transcript-tape-migration.ts
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

RUN apk add --no-cache util-linux
USER node
CMD ["node", "src/index.ts"]
