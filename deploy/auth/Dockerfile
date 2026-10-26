FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

WORKDIR /app

COPY plugins/auth/package.json plugins/auth/package-lock.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache

COPY plugins/auth/src ./src
COPY plugins/chassis/src /chassis/src
COPY plugins/auth/tsconfig.json ./

ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
