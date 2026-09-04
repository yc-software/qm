import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("core deploy image includes git", () => {
  const dockerfile = readFileSync(join(repoRoot, "deploy/core/Dockerfile"), "utf8");

  assert.match(
    dockerfile,
    /\bapk\s+add\b[\s\S]*\bgit\b/,
    "core hosts deployment git repos over git http-backend, which needs git in the image",
  );
  assert.match(
    dockerfile,
    /npm audit --omit=dev --audit-level=moderate/,
    "the production dependency threshold is a build gate",
  );
  assert.doesNotMatch(dockerfile, /patch-pi-shrinkwrap/, "the dependency layer should be lockfile-only");
  assert.match(
    dockerfile,
    /COPY cli\/templates\/slack-manifest\.json \.\/cli\/templates\/slack-manifest\.json/,
    "admin Slack setup needs the canonical manifest at runtime",
  );
  for (const line of dockerfile.split("\n").filter((candidate) => candidate.startsWith("COPY "))) {
    const sources = line.trim().split(/\s+/).slice(1, -1);
    for (const source of sources) {
      assert.equal(existsSync(join(repoRoot, source)), true, `core Dockerfile COPY source does not exist: ${source}`);
    }
  }
});
