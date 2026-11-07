#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
run="${GITHUB_RUN_ID:-$$}"
image="qm-core:front-door-smoke"
network="qm-core-smoke-$run"
database="qm-core-smoke-pg-$run"
container="qm-core-smoke-$run"

cleanup() {
  status=$?
  trap - EXIT
  if [[ "$status" != 0 ]]; then docker logs "$container" >&2 || true; fi
  docker rm -f "$container" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker build -f "$root/deploy/core/Dockerfile" -t "$image" "$root"
docker network create "$network" >/dev/null
docker run -d --name "$database" --network "$network" -e POSTGRES_PASSWORD=smoke postgres:16-alpine >/dev/null
for _ in {1..30}; do
  docker exec "$database" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

secret() { node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"; }
signing_jwk="$(node -e "const {generateKeyPairSync}=require('node:crypto');process.stdout.write(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))")"
client_secret="$(secret)"
docker run -d --name "$container" --network "$network" -p 127.0.0.1::8000 \
  -e DATABASE_URL="postgres://postgres:smoke@$database:5432/postgres" \
  -e ORG_ID=acme \
  -e SANDBOX_BACKEND=local \
  -e PUBLIC_PORT=8000 \
  -e PUBLIC_WEB_URL=https://portal.example.com \
  -e CONNECTOR_SECRET_KEY="$(secret)" \
  -e CORE_SIGNING_SECRET="$(secret)" \
  -e CAPABILITY_SECRET="$(secret)" \
  -e SKILL_SIGNING_SECRET="$(secret)" \
  -e PORTAL_IDENTITY_SECRET="$(secret)" \
  -e PORTAL_SESSION_SECRET="$(secret)" \
  -e AUTH_EMBEDDED=1 \
  -e AUTH_BROKER_UPSTREAM=http://127.0.0.1:8099 \
  -e AUTH_BROKER_PREFIX=/idp \
  -e AUTH_ISSUER=https://portal.example.com/idp \
  -e AUTH_REDIRECT_URI=https://portal.example.com/auth/callback \
  -e AUTH_CLIENT_ID=qm-portal \
  -e AUTH_CLIENT_SECRET="$client_secret" \
  -e AUTH_TOKEN_SECRET="$(secret)" \
  -e AUTH_SIGNING_JWK="$signing_jwk" \
  -e AUTH_ALLOWED_EMAIL_DOMAIN=example.com \
  -e AUTH_EMAIL_FROM="qm <no-reply@example.com>" \
  -e AUTH_EMAIL_TRANSPORT=resend \
  -e RESEND_API_KEY=re_runtime_smoke \
  -e OIDC_CLIENT_ID=qm-portal \
  -e OIDC_CLIENT_SECRET="$client_secret" \
  -e OIDC_ISSUER=https://portal.example.com/idp \
  -e OIDC_AUTH_ENDPOINT=https://portal.example.com/idp/authorize \
  -e OIDC_TOKEN_ENDPOINT=http://127.0.0.1:8099/token \
  -e OIDC_USERINFO_ENDPOINT=http://127.0.0.1:8099/userinfo \
  -e OIDC_JWKS_URI=http://127.0.0.1:8099/.well-known/jwks.json \
  -e OIDC_SCOPES="openid email" \
  -e OIDC_PRINCIPAL_CLAIM=email \
  -e OIDC_ALLOWED_EMAIL_DOMAIN=example.com \
  "$image" >/dev/null
port="$(docker port "$container" 8000/tcp | sed 's/.*://')"

for _ in {1..90}; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || { echo "core exited" >&2; exit 1; }
  if curl -fs "http://127.0.0.1:$port/healthz" >/dev/null && docker exec "$container" test -s /data/web-ui/live.json; then
    release="$(docker exec "$container" node -p "JSON.parse(require('node:fs').readFileSync('/data/web-ui/live.json','utf8')).release")"
    docker exec "$container" test -s "/data/web-ui/releases/$release/index.html" \
      || { echo "live.json names release $release, but its index.html is not in /data/web-ui" >&2; exit 1; }
    docker exec "$container" node -e "fetch('http://127.0.0.1:8099/.well-known/jwks.json').then(async r=>{const j=await r.json();if(r.ok&&j.keys?.length===1)return;console.error('broker JWKS answered HTTP '+r.status+' with '+(j.keys?.length??0)+' keys');process.exit(1)}).catch(e=>{console.error('broker JWKS unreachable: '+e.message);process.exit(1)})"
    status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/idp/.well-known/jwks.json")"
    [[ "$status" != 200 ]] || { echo "the broker JWKS is reachable through the front door (HTTP $status)" >&2; exit 1; }
    status="$(curl -s -o /dev/null -w '%{http_code}' -H 'accept: text/html' "http://127.0.0.1:$port/")"
    [[ "$status" == 302 ]] || { echo "the front door answered / with HTTP $status instead of a sign-in redirect" >&2; exit 1; }
    asset="$(docker exec "$container" node -p "require('node:fs').readdirSync('/data/web-ui/assets').find((name) => name.endsWith('.js'))")"
    status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/assets/$asset")"
    [[ "$status" == 200 ]] || { echo "the front door answered /assets/$asset with HTTP $status" >&2; exit 1; }
    type="$(curl -s -o /dev/null -w '%{content_type}' "http://127.0.0.1:$port/share/external/00000000-0000-4000-8000-000000000000")"
    [[ "$type" == text/html* ]] || { echo "an external share page answered $type instead of the share page" >&2; exit 1; }
    echo "ok: core image serves the front door, embedded sign-in broker, and its web UI release $release"
    exit 0
  fi
  sleep 1
done

echo "core image did not serve its front door in time" >&2
exit 1
