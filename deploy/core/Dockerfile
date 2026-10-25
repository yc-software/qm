FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS wireproxy-build

RUN apk add --no-cache go \
  && CGO_ENABLED=0 GOBIN=/out go install github.com/windtf/wireproxy/cmd/wireproxy@v1.1.2

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS connector-sdk-build
WORKDIR /app
COPY deploy/connector-sdk ./deploy/connector-sdk
RUN npm ci --prefix deploy/connector-sdk --ignore-scripts --no-audit --no-fund \
  && node deploy/connector-sdk/build.mjs

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

RUN apk add --no-cache 'ca-certificates>=20261020-r0' curl git git-daemon docker-cli

COPY --from=wireproxy-build /out/wireproxy /usr/local/bin/wireproxy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm run audit:prod \
  && rm -rf /root/.npm /tmp/node-compile-cache

COPY --from=connector-sdk-build /app/.generated/connector-sdk ./.generated/connector-sdk
COPY src ./src
COPY cli/src/canonical-json.ts cli/src/credential-paths.ts cli/src/scope-storage-key.ts cli/src/tool-descriptor.ts ./cli/src/
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
