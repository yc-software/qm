#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_TAG="qm-sandbox-base:dev"
LOCAL_TAG="${LOCAL_SANDBOX_IMAGE:-qm-sandbox-local:latest}"
# Match the docker host arch: emulated amd64 on arm64 runs node without its JIT and hangs the sandbox tests.
HOST_ARCH="$(docker version --format '{{.Server.Arch}}')"
PLATFORM="${LOCAL_SANDBOX_PLATFORM:-linux/${HOST_ARCH}}"

FINGERPRINT="$(node --input-type=module -e '
const { computeSandboxImageFingerprint } = await import("./src/sandbox/local-sandbox.ts");
const fp = await computeSandboxImageFingerprint(process.cwd());
if (!fp) { console.error("cannot compute sandbox image fingerprint (missing sources)"); process.exit(1); }
console.log(fp);
')"

if [[ -n "${FLY_SANDBOX_APP_NAME:-}" ]] && command -v flyctl >/dev/null 2>&1; then
  BASE_REF="registry.fly.io/${FLY_SANDBOX_APP_NAME}:dev"
  PLATFORM="linux/amd64"
  echo "==> building ${BASE_REF} from fly/Dockerfile on Fly's remote amd64 builder"
  flyctl deploy --build-only --push --remote-only --image-label dev \
    --app "${FLY_SANDBOX_APP_NAME}" -c fly/fly.toml --dockerfile fly/Dockerfile . --yes
  flyctl auth docker
  docker pull --platform "${PLATFORM}" "${BASE_REF}"
  docker tag "${BASE_REF}" "${BASE_TAG}"
else
  echo "==> building ${BASE_TAG} from fly/Dockerfile (${PLATFORM})"
  docker build --platform "${PLATFORM}" -f fly/Dockerfile -t "${BASE_TAG}" .
fi

echo "==> building ${LOCAL_TAG} from local/Dockerfile (fingerprint ${FINGERPRINT})"
docker build --platform "${PLATFORM}" -f local/Dockerfile --build-arg "BASE=${BASE_TAG}" \
  --label "qm.sandbox-fingerprint=${FINGERPRINT}" \
  -t "${LOCAL_TAG}" .

echo "==> done: ${LOCAL_TAG}"
