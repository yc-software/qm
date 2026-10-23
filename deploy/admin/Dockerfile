FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app

COPY plugins/admin/package.json plugins/admin/package-lock.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache

COPY plugins/admin/src ./src
COPY plugins/admin/ui ./ui
COPY plugins/chassis/src /chassis/src
COPY plugins/web-ui/src /web-ui/src
COPY plugins/admin/public ./public
COPY plugins/admin/tsconfig.json ./

ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
