#!/usr/bin/env bash
set -euo pipefail

REPO="${1:?usage: scripts/deploy-helm.sh <image-repo-prefix> [tag]   e.g. scripts/deploy-helm.sh ghcr.io/<org>/qm}"
TAG="${2:-$(git rev-parse --short HEAD)}"
RELEASE="${QM_RELEASE:-qm}"
NAMESPACE="${QM_NAMESPACE:-qm}"
PLATFORM="${QM_PLATFORM:-linux/amd64}"
DEPLOY="${QM_DEPLOY:-1}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/deploy/helm"
CHART_NS="${REPO%/*}"

SERVICES=(core auth web-ui admin portal egress-proxy)

for svc in "${SERVICES[@]}"; do
  image="$REPO-$svc:$TAG"
  echo ">> building $image from deploy/$svc/Dockerfile"
  docker build \
    --platform "$PLATFORM" \
    --build-arg GIT_SHA="$TAG" \
    -t "$image" \
    -f "$ROOT/deploy/$svc/Dockerfile" \
    "$ROOT"
  echo ">> pushing $image"
  docker push "$image"
done

echo ">> packaging chart and pushing to oci://$CHART_NS"
PKG_DIR="$(mktemp -d)"
helm package "$CHART" --app-version "$TAG" --destination "$PKG_DIR" >/dev/null
helm push "$PKG_DIR"/*.tgz "oci://$CHART_NS"
rm -rf "$PKG_DIR"

if [ "$DEPLOY" = "1" ]; then
  echo ">> deploying release '$RELEASE' to namespace '$NAMESPACE'"
  helm upgrade --install "$RELEASE" "$CHART" \
    --namespace "$NAMESPACE" \
    --create-namespace \
    --set image.repository="$REPO" \
    --set image.tag="$TAG"
else
  echo ">> QM_DEPLOY=0, skipping in-cluster deploy (images + chart published)"
fi

echo ">> done: chart oci://$CHART_NS @ chart $(helm show chart "$CHART" | awk '/^version:/{print $2}'), images @ $TAG"
