#!/usr/bin/env bash
# Rebuilds the vendored pi-ai tarball: stock npm 0.82.0 + provider-error.patch.
# Output: earendil-works-pi-ai-0.82.0-qm.1.tgz in the current directory.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/stock.tgz" https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.82.0.tgz
echo "761e2492dab7bf5601143d005b9f82ec9000338d02d06f737b6574e057fd61c3  $work/stock.tgz" | sha256sum -c -
tar xzf "$work/stock.tgz" -C "$work"
git -C "$work/package" apply -p1 "$here/provider-error.patch"
npm pack --silent "$work/package" --pack-destination "$work" >/dev/null
mv "$work/earendil-works-pi-ai-0.82.0.tgz" ./earendil-works-pi-ai-0.82.0-qm.1.tgz
sha256sum earendil-works-pi-ai-0.82.0-qm.1.tgz
