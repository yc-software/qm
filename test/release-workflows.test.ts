import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("the release publishes signed images and never a package", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.doesNotMatch(workflow, /npm pack/);
  assert.doesNotMatch(workflow, /npm publish/);
  assert.doesNotMatch(workflow, /verify:release/);
  assert.doesNotMatch(workflow, /prepare-release-manifest/);
  assert.doesNotMatch(workflow, /^ {2}package:$/m);
  assert.match(workflow, /^ {2}image:$/m);
  assert.equal(existsSync(".github/workflows/release-images.yml"), false);
});

test("the release is the sole sandbox-base publisher and bakes in the browser engine", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.match(
    workflow,
    /- name: sandbox-base\n\s+dockerfile: fly\/Dockerfile\n\s+build-args: INSTALL_BROWSER_ENGINE=1\n/,
  );
  assert.match(workflow, /build-args: \$\{\{ matrix\.build-args \}\}/);
  assert.equal(existsSync(".github/workflows/publish-sandbox-base.yml"), false);
  assert.equal(existsSync(".github/workflows/publish-images.yml"), false);
});

test("the release signs private images without requiring anonymous registry access", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.doesNotMatch(workflow, /anonymously pullable|DOCKER_CONFIG="\$probe"/);
  assert.match(workflow, /permissions:\s+contents: read\s+packages: write\s+id-token: write/);
  assert.match(
    workflow,
    /docker\/login-action@[^\n]+\s+with:\s+registry: ghcr\.io\s+username: \$\{\{ github\.actor \}\}\s+password: \$\{\{ github\.token \}\}/,
  );
  assert.match(workflow, /platforms: linux\/amd64\s+provenance: false/);
  assert.match(
    workflow,
    /image='ghcr\.io\/yc-software\/qm-\$\{\{ matrix\.name \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}'\s+cosign sign --yes "\$image"\s+cosign verify "\$image"/,
  );
  assert.ok(workflow.indexOf("docker/login-action") < workflow.indexOf("docker/build-push-action"));
  assert.ok(workflow.indexOf("docker/build-push-action") < workflow.indexOf("Sign exact image"));
});

test("the CLI package publishes publicly with provenance", () => {
  const manifest = JSON.parse(readFileSync("cli/package.json", "utf8")) as {
    private?: boolean;
    repository?: { url?: string; directory?: string };
    publishConfig?: { access?: string; provenance?: boolean };
    scripts?: Record<string, string>;
  };

  assert.equal(manifest.private, undefined);
  assert.equal(manifest.publishConfig?.access, "public");
  assert.equal(manifest.publishConfig?.provenance, true);
  assert.equal(manifest.repository?.url, "git+https://github.com/yc-software/qm.git");
  assert.equal(manifest.repository?.directory, "cli");
  assert.equal(manifest.scripts?.["verify:release"], undefined);
  assert.equal(existsSync("cli/scripts/verify-release-manifest.mjs"), false);
  assert.equal(existsSync("scripts/prepare-release-manifest.mjs"), false);
});

test("publishing the CLI is a separate, attested, main-only operation", () => {
  const workflow = readFileSync(".github/workflows/publish-cli.yml", "utf8");

  assert.match(workflow, /^on:\n {2}workflow_dispatch:$/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /permissions:\s+contents: read\s+id-token: write/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /npm publish --provenance --access public/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /packages: write/);
});
