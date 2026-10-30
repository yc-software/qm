#!/usr/bin/env bash
set -euo pipefail

service="${1:?service required}"
root="$(git rev-parse --show-toplevel)"
image="qm-$service:runtime-smoke"
container="qm-$service-runtime-smoke-${GITHUB_RUN_ID:-$$}"

case "$service" in
  admin) container_port=8080 ;;
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

docker run -d --name "$container" -p 127.0.0.1::"$container_port" "$image" >/dev/null
port="$(docker port "$container" "$container_port/tcp" | sed 's/.*://')"

for _ in {1..30}; do
  if curl -fs "http://127.0.0.1:$port/healthz" >/dev/null; then
    echo "ok: $service production image serves its combined routes"
    exit 0
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || break
  sleep 1
done

docker logs "$container" >&2 || true
echo "$service production image failed to serve /healthz" >&2
exit 1
