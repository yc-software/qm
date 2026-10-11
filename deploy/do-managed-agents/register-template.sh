#!/usr/bin/env bash
# Build the QM sandbox image and register it as a Managed Agents template
# on your own DigitalOcean team. Run once per team, and again after the
# Dockerfile changes.
#
# Needs: docker (buildx), doctl authenticated with a token that has
# registry and Managed Agents access, and an existing container registry.
#
# Usage: deploy/do-managed-agents/register-template.sh [tag]
#   DO_REGISTRY      registry name (default: first registry on the account)
#   TEMPLATE_NAME    template name (default: qm-sandbox)
set -euo pipefail

TAG="${1:-$(date +%Y%m%d%H%M%S)}"
TEMPLATE_NAME="${TEMPLATE_NAME:-qm-sandbox}"
DIR="$(cd "$(dirname "$0")" && pwd)"

for bin in docker doctl jq; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done

DO_REGISTRY="${DO_REGISTRY:-$(doctl registry get -o json | jq -r 'if type=="array" then .[0].name else .name end // empty')}"
[ -n "$DO_REGISTRY" ] || { echo "no container registry found; create one or set DO_REGISTRY" >&2; exit 1; }
IMAGE="registry.digitalocean.com/$DO_REGISTRY/$TEMPLATE_NAME:$TAG"

echo "building $IMAGE"
docker build --platform linux/amd64 -t "$IMAGE" "$DIR"
doctl registry login >/dev/null
docker push "$IMAGE"

if doctl harness-runtime template get "$TEMPLATE_NAME" >/dev/null 2>&1; then
  echo "updating template $TEMPLATE_NAME"
  doctl harness-runtime template update "$TEMPLATE_NAME" --source-oci-ref "$IMAGE" >/dev/null
else
  echo "creating template $TEMPLATE_NAME"
  doctl harness-runtime template create --name "$TEMPLATE_NAME" \
    --base-template sandbox --source-oci-ref "$IMAGE" >/dev/null
fi

echo "waiting for the template build"
for _ in $(seq 1 60); do
  status="$(doctl harness-runtime template list-builds "$TEMPLATE_NAME" -o json \
    | jq -r 'sort_by(.created_at) | last | .status')"
  case "$status" in
    SUCCEEDED) echo "ready. Set DO_AGENTS_TEMPLATE=$TEMPLATE_NAME in your QM config."; exit 0 ;;
    FAILED) echo "template build failed" >&2; exit 1 ;;
  esac
  sleep 20
done
echo "timed out waiting for the template build (last status: $status)" >&2
exit 1
