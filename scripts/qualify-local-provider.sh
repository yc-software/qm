#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
candidate="${1:?usage: qualify-local-provider.sh <candidate.json>}"
if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${MODEL_GATEWAY_URL:-}" ]]; then
  echo "a live model credential or model gateway is required" >&2
  exit 1
fi
core_image="$(node --input-type=module - "$candidate" <<'JS'
import { readFileSync } from 'node:fs';
const candidate = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!/^[^\s]+@sha256:[a-f0-9]{64}$/.test(candidate.images?.core ?? '')) throw new Error('candidate core must be immutable');
console.log(candidate.images.core);
JS
)"
source_sha="$(git rev-parse HEAD)"
registry="${core_image%%/*}"
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry"
docker pull "$core_image"
base_tag="qm-qualification-base:$source_sha"
local_tag="qm-qualification-local:$source_sha"
cache_args=()
if [[ -n "${ACTIONS_RUNTIME_TOKEN:-}" && -n "${ACTIONS_CACHE_URL:-}${ACTIONS_RESULTS_URL:-}" ]]; then
  cache_args=(--cache-from type=gha,scope=qm-local-base --cache-to type=gha,scope=qm-local-base,mode=max)
fi
platform="${LOCAL_SANDBOX_PLATFORM:-linux/arm64}"
docker buildx build --load --platform "$platform" "${cache_args[@]}" -f fly/Dockerfile -t "$base_tag" .
fingerprint="$(node --input-type=module -e 'import { computeSandboxImageFingerprint } from "./src/sandbox/local-sandbox.ts"; const value = await computeSandboxImageFingerprint(process.cwd()); if (!value) throw new Error("missing sandbox sources"); console.log(value);')"
docker build --builder "$(docker context show)" --platform "$platform" -f local/Dockerfile --build-arg "BASE=$base_tag" --label "qm.sandbox-fingerprint=$fingerprint" -t "$local_tag" .
local_image="$(docker image inspect --format '{{.Id}}' "$local_tag")"
container="qm-provider-qualification-${GITHUB_RUN_ID:-local}-$$"
database="$container-postgres"
network="$container-network"
cleanup() {
  docker rm -f "$container" "$database" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
database_password="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')"
connector_secret_key="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
docker network create "$network" >/dev/null
docker run -d --name "$database" --network "$network" -e "POSTGRES_PASSWORD=$database_password" -e POSTGRES_DB=qm \
  pgvector/pgvector:0.8.1-pg16 >/dev/null
until docker exec "$database" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$database")" != true ]]; then
    docker logs "$database" >&2
    echo "the qualification Postgres container stopped before accepting connections" >&2
    exit 1
  fi
  sleep 1
done
socket_group="$(node -e 'console.log(require("node:fs").statSync("/var/run/docker.sock").gid)')"
printf 'core=%s\nsource=%s\nlocal=%s\n' "$core_image" "$source_sha" "$local_image"
docker run --rm --name "$container" --network "$network" --group-add "$socket_group" \
  --add-host host.docker.internal:host-gateway \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/test/live-slack/local-provider.ts:/app/test/live-slack/local-provider.ts:ro" \
  -v "$PWD/test/live-slack/scenarios-sandbox-providers.ts:/app/test/live-slack/scenarios-sandbox-providers.ts:ro" \
  -e ANTHROPIC_API_KEY -e NODE_ENV=development \
  -e MODEL_GATEWAY_URL -e MODEL_GATEWAY_API_KEY -e MODEL_GATEWAY_API_KEY_HEADER -e MODEL_GATEWAY_MODELS \
  -e "EXPECTED_SOURCE_SHA=$source_sha" -e "QM_CORE_CONTAINER=$container" \
  -e "DATABASE_URL=postgres://postgres:$database_password@$database:5432/qm" -e "CONNECTOR_SECRET_KEY=$connector_secret_key" \
  -e "LOCAL_SANDBOX_IMAGE=$local_image" -e LOCAL_SANDBOX_CPUS=2 -e LOCAL_SANDBOX_MEMORY_MB=2048 \
  -e PI_MODEL=claude-haiku-4-5 \
  "$core_image" node test/live-slack/local-provider.ts
