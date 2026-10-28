FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
RUN apk add --no-cache bash ca-certificates curl git python3 py3-pip make g++ util-linux tini \
  && addgroup -g 10001 -S app \
  && adduser -S -D -u 10001 -G app -h /home/app app
RUN ARCH="$(uname -m)" && case "$ARCH" in \
      x86_64) LS_ARCH=amd64; LS_SHA=eb75a3de5cab03875cdae9f5f539e6aedadd66607003d9b1e7a9077948818ba0 ;; \
      aarch64) LS_ARCH=arm64; LS_SHA=9585f5a508516bd66af2b2376bab4de256a5ef8e2b73ec760559e679628f2d59 ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; esac \
  && curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-${LS_ARCH}.tar.gz" -o /tmp/litestream.tgz \
  && echo "${LS_SHA}  /tmp/litestream.tgz" | sha256sum -c - \
  && tar -xzf /tmp/litestream.tgz -C /usr/local/bin litestream \
  && rm /tmp/litestream.tgz \
  && litestream version
COPY start.mjs sqlite.mjs /opt/qm/
WORKDIR /app
RUN chown -R app:app /app
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/opt/qm/start.mjs"]
