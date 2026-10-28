FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
WORKDIR /app
ARG WEB_UI_BASE=/
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci
COPY plugins/web-ui/index.html plugins/web-ui/shared.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/public ./public
COPY plugins/web-ui/src ./src
COPY plugins/chassis/src /chassis/src
COPY docs/images/slack-app-config-token-setup.gif /docs/images/slack-app-config-token-setup.gif
RUN npm run build

FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
WORKDIR /app
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci --omit=dev && rm package-lock.json \
  && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/web-ui/server ./server
COPY plugins/web-ui/src/app-edit.ts ./src/app-edit.ts
COPY plugins/admin/package.json plugins/admin/package-lock.json /admin/
RUN npm ci --prefix /admin --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/admin/src /admin/src
COPY plugins/admin/ui /admin/ui
COPY plugins/admin/public /admin/public
COPY plugins/chassis/src /chassis/src
COPY plugins/web-ui/src /web-ui/src
COPY --from=build /app/dist-web ./dist-web

ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
RUN apk add --no-cache util-linux
USER node
CMD ["node", "server/index.ts"]
