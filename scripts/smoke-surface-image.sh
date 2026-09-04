#!/usr/bin/env bash
set -euo pipefail

service="${1:?service required}"
root="$(git rev-parse --show-toplevel)"
image="qm-$service:runtime-smoke"
container="qm-$service-runtime-smoke-${GITHUB_RUN_ID:-$$}"

case "$service" in
  admin | web-ui | portal | auth) container_port=8080 ;;
  *) echo "unsupported service: $service" >&2; exit 2 ;;
esac

cleanup() {
  status=$?
  trap - EXIT
  docker rm -f "$container" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

cd "$root"
docker build -f "deploy/$service/Dockerfile" -t "$image" .

if [[ "$service" == "portal" ]]; then
  docker run -d --name "$container" -p 127.0.0.1::"$container_port" \
    -e PORTAL_SESSION_SECRET=runtime-smoke-portal-session-secret \
    -e CORE_SIGNING_SECRET=runtime-smoke-core-signing-secret \
    -e OIDC_CLIENT_ID=runtime-smoke-client \
    -e OIDC_CLIENT_SECRET=runtime-smoke-client-secret \
    -e OIDC_ALLOWED_EMAIL_DOMAIN=example.com \
    -e PORTAL_PUBLIC_URL=https://portal.example.com \
    "$image" >/dev/null
elif [[ "$service" == "auth" ]]; then
  signing_jwk="$(node -e "const {generateKeyPairSync}=require('node:crypto');process.stdout.write(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))")"
  docker run -d --name "$container" -p 127.0.0.1::"$container_port" \
    -e CORE_SIGNING_SECRET=runtime-smoke-core-signing-secret-0123456789 \
    -e AUTH_ISSUER=https://portal.example.com/idp \
    -e AUTH_REDIRECT_URI=https://portal.example.com/auth/callback \
    -e AUTH_CLIENT_ID=qm-portal \
    -e AUTH_CLIENT_SECRET=runtime-smoke-auth-client-secret-0123456789 \
    -e AUTH_TOKEN_SECRET=runtime-smoke-auth-token-secret-0123456789 \
    -e AUTH_SIGNING_JWK="$signing_jwk" \
    -e AUTH_ALLOWED_EMAIL_DOMAIN=example.com \
    -e AUTH_EMAIL_FROM="qm <no-reply@example.com>" \
    -e AUTH_EMAIL_TRANSPORT=resend \
    -e RESEND_API_KEY=re_runtime_smoke \
    "$image" >/dev/null
else
  docker run -d --name "$container" -p 127.0.0.1::"$container_port" "$image" >/dev/null
fi
port="$(docker port "$container" "$container_port/tcp" | sed 's/.*://')"

for _ in {1..30}; do
  if curl -fs "http://127.0.0.1:$port/healthz" >/dev/null; then
    echo "ok: $service production image serves /healthz"
    exit 0
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || break
  sleep 1
done

docker logs "$container" >&2 || true
echo "$service production image failed to serve /healthz" >&2
exit 1
