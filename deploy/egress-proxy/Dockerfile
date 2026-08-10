FROM envoyproxy/envoy:v1.31.5@sha256:2ef22f7a72d3008d68bd4912f52b9a3d466d00db31a567dffa1b103e42eb9198 AS envoy

FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
COPY --from=envoy /usr/local/bin/envoy /usr/local/bin/envoy

RUN apt-get update && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./
COPY deploy/egress-proxy/envoy.yaml deploy/egress-proxy/start.sh ./
RUN chmod +x start.sh
# A rejected config is a fleet-wide outage: start.sh kills the container when Envoy dies, so an
# invalid envoy.yaml has to fail the build, not the deploy.
RUN envoy --mode validate -c /app/envoy.yaml

ENV NODE_ENV=production
EXPOSE 48080

CMD ["/app/start.sh"]
