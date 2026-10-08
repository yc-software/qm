#!/usr/bin/env bash
# Repackages the vendored pi-coding-agent (security.5 -> security.6) so its npm-shrinkwrap
# pins pi-ai to the qm.1 tarball instead of stock npm. Only npm-shrinkwrap.json changes.
set -euo pipefail
base=https://github.com/yc-software/qm/releases/download
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/src.tgz" "$base/vendored-pi-coding-agent-0.82.0-security.5/earendil-works-pi-coding-agent-0.82.0-qm-security.5.tgz"
echo "6d5ae8ee0c5c8c7d92fef0e6b1573d136292587027d9328f334ce0693b9e90fc  $work/src.tgz" | sha256sum -c -
curl -fsSL -o "$work/pi-ai.tgz" "$base/vendored-pi-ai-0.82.0-qm.1/earendil-works-pi-ai-0.82.0-qm.1.tgz"
echo "fee4e2e6df462d76a63f2ce957d126738e281238694bdbaa12d677d130aae1ef  $work/pi-ai.tgz" | sha256sum -c -
tar xzf "$work/src.tgz" -C "$work"
node -e '
const fs = require("node:fs");
const [file, url, tgz] = process.argv.slice(1);
const integrity = "sha512-" + require("node:crypto").createHash("sha512").update(fs.readFileSync(tgz)).digest("base64");
const lock = JSON.parse(fs.readFileSync(file, "utf8"));
Object.assign(lock.packages["node_modules/@earendil-works/pi-ai"], { resolved: url, integrity });
fs.writeFileSync(file, JSON.stringify(lock, null, "\t") + "\n");
' "$work/package/npm-shrinkwrap.json" "$base/vendored-pi-ai-0.82.0-qm.1/earendil-works-pi-ai-0.82.0-qm.1.tgz" "$work/pi-ai.tgz"
npm pack --silent "$work/package" --pack-destination "$work" >/dev/null
mv "$work/earendil-works-pi-coding-agent-0.82.0.tgz" ./earendil-works-pi-coding-agent-0.82.0-qm-security.6.tgz
sha256sum earendil-works-pi-coding-agent-0.82.0-qm-security.6.tgz
