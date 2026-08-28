import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the canonical and packaged MicroVM Dockerfiles stay snapshot-safe and executable", () => {
  const canonical = readFileSync(new URL("../../aws/microvm-agent/Dockerfile", import.meta.url), "utf8");
  const packaged = readFileSync(new URL("../templates/aws/microvm-agent/Dockerfile", import.meta.url), "utf8");
  assert.equal(packaged, canonical);
  assert.equal(
    readFileSync(new URL("../templates/aws/microvm-agent/agent.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../../aws/microvm-agent/agent.mjs", import.meta.url), "utf8"),
  );
  assert.match(canonical, /^FROM public\.ecr\.aws\/lambda\/microvms:al2023-minimal@sha256:[a-f0-9]{64}$/m);
  assert.match(canonical, /dnf install -y[\s\\]+curl-minimal\b/);
  assert.doesNotMatch(canonical, /cli\.github\.com\/packages\/rpm/);
  assert.doesNotMatch(canonical, /dnf install -y gh-/);
  assert.match(canonical, /GH_VERSION=\d+\.\d+\.\d+/);
  assert.match(canonical, /GH_SHA256=[a-f0-9]{64}/);
  assert.match(
    canonical,
    /github\.com\/cli\/cli\/releases\/download\/v\$\{GH_VERSION\}\/gh_\$\{GH_VERSION\}_linux_arm64\.tar\.gz/,
  );
  assert.match(canonical, /\$\{GH_SHA256\} {2}\/tmp\/gh\.tgz" \| sha256sum -c -/);
  assert.match(canonical, /awscli-exe-linux-aarch64-\d+\.\d+\.\d+\.zip/);
  assert.match(canonical, /[a-f0-9]{64} {2}\/tmp\/awscliv2\.zip" \| sha256sum -c -/);
  assert.match(canonical, /rpm -q openssl-snapsafe-libs/);
  assert.match(canonical, /\bnodejs24\b/);
  assert.match(canonical, /\bnodejs24-npm\b/);
  for (const command of ["npm --version", "npx --version", "setsid --version", "seq 1 1"])
    assert.match(canonical, new RegExp(command));
});
