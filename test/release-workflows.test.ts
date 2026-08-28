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
    /image='ghcr\.io\/yc-software\/qm\/\$\{\{ matrix\.name \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}'\s+cosign sign --yes "\$image"\s+cosign verify "\$image"/,
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

  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(workflow, /^ {2}workflow_call:$/m);
  assert.doesNotMatch(workflow, /^ {2}push:$/m);
  assert.doesNotMatch(workflow, /^ {2}pull_request:$/m);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /permissions:\s+contents: read\s+id-token: write/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /npm publish --provenance --access public/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /packages: write/);
});

test("the published package pins real image digests, never the checked-in sentinel", () => {
  const workflow = readFileSync(".github/workflows/publish-cli.yml", "utf8");

  assert.ok(
    workflow.indexOf("Pin published image digests") < workflow.indexOf("npm publish"),
    "digests are resolved before the package is published",
  );
  assert.match(workflow, /for service in core web-ui admin portal auth sandbox-base; do/);
  assert.match(workflow, /printf '%s\\n' "\$out" > cli\/manifest\.json/);
  assert.match(workflow, /no published image for \$repo at \$IMAGES_REF/);
  assert.match(workflow, /\{63\}\$"\) \| not\)/);

  const sentinel = JSON.parse(readFileSync("cli/manifest.json", "utf8")) as {
    sandboxBase: string;
    services: Record<string, string>;
  };
  const refs = [sentinel.sandboxBase, ...Object.values(sentinel.services)];
  assert.equal(refs.length, 6);
  assert.ok(
    refs.every((ref) => ref.startsWith("registry.invalid/")),
    "the checked-in manifest stays a sentinel so a source checkout never pulls a stale digest",
  );
});

test("the release republishes nothing already on npm so a half-finished run can resume", () => {
  const workflow = readFileSync(".github/workflows/publish-cli.yml", "utf8");

  assert.match(workflow, /if npm view "@yc-software\/qm@\$version" version/);
  assert.ok(
    workflow.indexOf("npm view") < workflow.indexOf("npm publish --provenance"),
    "the already-published check guards the publish rather than following it",
  );
  assert.match(workflow, /manifest: \$\{\{ steps\.pin\.outputs\.manifest \}\}/);
});

test("one dispatchable workflow drives the whole release, main-only and in order", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /^on:\n {2}workflow_dispatch:$/m);
  assert.match(workflow, /releases are cut from main; this run is on \$GITHUB_REF/);
  assert.doesNotMatch(
    workflow,
    /^ {4}if: github\.ref == 'refs\/heads\/main'$/m,
    "a non-main dispatch fails loudly instead of skipping every job and reporting green",
  );
  assert.match(
    workflow,
    /^ {2}images:\n[\s\S]*?needs: preflight\n[\s\S]*?uses: \.\/\.github\/workflows\/release-package\.yml$/m,
  );
  assert.match(workflow, /^ {2}cli:\n[\s\S]*?needs: images\n[\s\S]*?uses: \.\/\.github\/workflows\/publish-cli\.yml$/m);
  assert.match(workflow, /^ {2}release:\n[\s\S]*?needs:\n {6}- preflight\n {6}- cli$/m);
  assert.match(workflow, /concurrency:\n {2}group: release\n {2}cancel-in-progress: false/);
});

test("the release refuses a tag it already published and writes the tag last", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /version=\$\(jq -r \.version cli\/package\.json\)/);
  assert.match(workflow, /cli\/package\.json version must be semver/);
  assert.match(workflow, /tag="v\$version"/);
  assert.match(workflow, /is already released; bump cli\/package\.json before releasing again/);
  assert.ok(
    workflow.indexOf("already released") < workflow.indexOf("gh release create"),
    "the tag gate runs before anything is published",
  );
  assert.match(workflow, /gh release create "\$TAG"/);
  assert.match(workflow, /--generate-notes/);
  assert.match(workflow, /"images\.json#Pinned image digests"/);
});

test("the tag is created atomically at the released commit, never adopted from elsewhere", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(
    workflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/refs" \\\n\s+-f ref="refs\/tags\/\$TAG" -f sha="\$GITHUB_SHA"/,
  );
  assert.match(workflow, /--verify-tag/);
  assert.doesNotMatch(
    workflow,
    /--target/,
    "--target only names a commit when gh creates the tag itself, so a tag another actor raced in would silently win",
  );
  assert.ok(
    workflow.indexOf("git/refs") < workflow.indexOf("gh release create"),
    "the ref is created before the release so a duplicate tag fails the run",
  );
});

test("a resumed publish keeps npm only when it already pins the digests being released", () => {
  const workflow = readFileSync(".github/workflows/publish-cli.yml", "utf8");

  assert.match(workflow, /npm pack "@yc-software\/qm@\$version"/);
  assert.match(workflow, /tar -xzf "\$published\/\$tarball" -C "\$published" package\/manifest\.json/);
  assert.match(workflow, /is on npm pinning different image digests; bump the version/);
  assert.ok(
    workflow.indexOf("npm pack") < workflow.indexOf("keeping it"),
    "the published tarball is compared before the publish is skipped",
  );
});

test("only the tagging job may write to the repository", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  const writes = workflow.match(/^ {6}contents: write$/gm) ?? [];
  assert.equal(writes.length, 1);
  assert.match(workflow, /^ {2}release:\n[\s\S]*?permissions:\n {6}contents: write\n[\s\S]*?gh release create/m);
  assert.doesNotMatch(workflow, /packages: write\n {4}secrets: inherit/);
});

test("images are signed from a main ref, so the pinned cosign identity keeps verifying", () => {
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  const images = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.match(release, /^on:\n {2}workflow_dispatch:$/m);
  assert.doesNotMatch(release, /^ {2}push:$/m);
  assert.match(release, /if \[ "\$GITHUB_REF" != refs\/heads\/main \]/);
  assert.match(images, /--certificate-identity='[^']*release-package\.yml@refs\/heads\/main'/);
});
