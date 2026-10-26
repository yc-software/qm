#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_TAG="qm-sandbox-base:dev"
LOCAL_TAG="${LOCAL_SANDBOX_IMAGE:-qm-sandbox-local:latest}"
PLATFORM="linux/amd64"

FINGERPRINT="$(node --input-type=module -e '
const { computeSandboxImageFingerprint } = await import("./src/sandbox/local-sandbox.ts");
const fp = await computeSandboxImageFingerprint(process.cwd());
if (!fp) { console.error("cannot compute sandbox image fingerprint (missing sources)"); process.exit(1); }
console.log(fp);
')"

echo "==> building ${BASE_TAG} from sandbox-base/Dockerfile (${PLATFORM})"
docker build --platform "${PLATFORM}" -f sandbox-base/Dockerfile -t "${BASE_TAG}" .

echo "==> building ${LOCAL_TAG} from local/Dockerfile (fingerprint ${FINGERPRINT})"
docker build --platform "${PLATFORM}" -f local/Dockerfile --build-arg "BASE=${BASE_TAG}" \
  --label "qm.sandbox-fingerprint=${FINGERPRINT}" \
  -t "${LOCAL_TAG}" .

echo "==> done: ${LOCAL_TAG}"
