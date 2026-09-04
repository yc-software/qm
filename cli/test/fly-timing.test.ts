import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(cliDir, "..");
const bin = join(cliDir, "bin", "qm.ts");

function fakeFlyBin(dir: string): string {
  const binPath = join(dir, "fake-fly.cjs");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const cmd = args.join(" ");
if (process.env.FAKE_FLY_LOG) fs.appendFileSync(process.env.FAKE_FLY_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "apps" && args[1] === "create") {
  console.log("created");
} else if (args[0] === "secrets" && args[1] === "set") {
  console.log("staged");
} else if (args[0] === "secrets" && args[1] === "list") {
  console.log("ADMIN_GRANTS\\nANTHROPIC_API_KEY\\nAWS_ACCESS_KEY_ID\\nAWS_ENDPOINT_URL_S3\\nAWS_SECRET_ACCESS_KEY\\nCAPABILITY_SECRET\\nCONNECTOR_SECRET_KEY\\nCORE_SIGNING_SECRET\\nPORTAL_IDENTITY_SECRET\\nSKILL_SIGNING_SECRET\\nFLY_API_TOKEN\\nPUBLIC_API_URL\\n" + (process.env.FAKE_FLY_FRESH_PG ? "" : "DATABASE_URL\\n") + "SLACK_BOT_TOKEN\\nSLACK_APP_TOKEN");
} else if (args[0] === "mpg" && args[1] === "list") {
  console.log(process.env.FAKE_FLY_FRESH_PG ? "" : "pg-1 test-pg");
} else if (args[0] === "mpg" && args[1] === "create") {
  console.log("ID: pg-1");
} else if (args[0] === "mpg" && args[1] === "status") {
  if (process.env.FAKE_FLY_STATUS_FAIL) {
    console.log("postgresql://fly-user:secret@direct.pg-1.flympg.net/fly-db");
    console.error("postgresql://fly-user:secret@direct.pg-1.flympg.net/fly-db");
    process.exit(1);
  }
  console.log(JSON.stringify({ credentials: { pgbouncer_uri: "postgresql://fly-user:secret@pgbouncer.pg-1.flympg.net/fly-db" } }));
} else if (args[0] === "status" && args.includes("--json")) {
  console.log(JSON.stringify({ Machines: [{ id: "machine-core", config: { image: "registry.fly.io/source-core:v1" } }] }));
} else if (args[0] === "image" && args[1] === "show") {
  console.log(process.env.FAKE_FLY_NO_IMAGE_DIGEST ? "[]" : JSON.stringify([
    ...(process.env.FAKE_FLY_MIXED_IMAGES ? [{ MachineID: "machine-other", Registry: "registry.fly.io", Repository: "source-core", Tag: "v1", Digest: "sha256:${"b".repeat(64)}" }] : []),
    { MachineID: "machine-core", Registry: "registry.fly.io", Repository: "source-core", Tag: "v1", Digest: "sha256:${"a".repeat(64)}" },
  ]));
} else if (args[0] === "deploy") {
  console.log("deployed");
} else if (args[0] === "ssh" && args[1] === "console") {
  console.log('QM_LAYER_RESPONSE=' + JSON.stringify({ status: 200, body: JSON.stringify({ version: 1, contentHash: "0123456789abcdef" }) }));
} else {
  console.error("unexpected fake fly command: " + cmd);
  process.exit(42);
}
`,
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

test("fly up emits phase timings and appends a GitHub step summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-timing-"));
  const summaryPath = join(dir, "summary.md");
  const stdout = execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.match(stdout, /timing qm\/core: app ensure \d+(?:ms|\.\d+s)/);
  assert.match(stdout, /timing qm\/core: secret checks \d+(?:ms|\.\d+s)/);
  assert.match(stdout, /timing qm\/core: Postgres ensure \d+(?:ms|\.\d+s)/);
  assert.match(stdout, /timing qm\/core: current image lookup \d+(?:ms|\.\d+s)/);
  assert.match(stdout, /timing qm\/core: fly deploy \d+(?:ms|\.\d+s)/);

  const summary = readFileSync(summaryPath, "utf8");
  assert.match(summary, /### Fly deploy timings \(qm\)/);
  assert.match(summary, /\| Stack \| Service \| Phase \| Duration \|/);
  assert.match(summary, /\| qm \| core \| app ensure \| \d+(?:ms|\.\d+s) \|/);
  assert.match(summary, /\| qm \| core \| secret checks \| \d+(?:ms|\.\d+s) \|/);
  assert.match(summary, /\| qm \| core \| Postgres ensure \| \d+(?:ms|\.\d+s) \|/);
  assert.match(summary, /\| qm \| core \| current image lookup \| \d+(?:ms|\.\d+s) \|/);
  assert.match(summary, /\| qm \| core \| fly deploy \| \d+(?:ms|\.\d+s) \|/);
});

test("fly up can deploy a tagged image without consulting the source stack's running image", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-tagged-"));
  const logPath = join(dir, "fly.log");
  const stdout = execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "cli", "test", "fixtures", "imagefrom-stack.json"),
      "--only",
      "core",
      "--image-label",
      "sha123",
      "--image-repo-prefix",
      "qm",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.match(stdout, /--image registry\.fly\.io\/qm-core:sha123/);
  assert.doesNotMatch(stdout, /current image lookup/);
  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    commands.some((args) => args[0] === "status"),
    false,
  );
  assert.equal(
    commands.some(
      (args) => args[0] === "deploy" && args.includes("--image") && args.includes("registry.fly.io/qm-core:sha123"),
    ),
    true,
  );
});

test("fly image-from fails closed when Fly cannot resolve the running tag to a digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-no-digest-"));
  const result = spawnSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_NO_IMAGE_DIGEST: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source-core did not report an immutable image digest/);
  assert.doesNotMatch(result.stdout, /fly deploy/);
});

test("fly image-from resolves by machine id during a mixed rollout", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-mixed-images-"));
  const logPath = join(dir, "fly.log");
  execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
        FAKE_FLY_MIXED_IMAGES: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  const deploy = commands.find((args) => args[0] === "deploy");
  assert.ok(deploy?.includes(`registry.fly.io/source-core@sha256:${"a".repeat(64)}`));
  assert.equal(deploy?.includes(`registry.fly.io/source-core@sha256:${"b".repeat(64)}`), false);
});

test("a fresh Fly deploy stages the direct Managed Postgres URL without attaching the pooled URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-fresh-pg-"));
  const logPath = join(dir, "fly.log");
  execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
        FAKE_FLY_FRESH_PG: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  const directSecret = commands.findIndex(
    (args) => args[0] === "secrets" && args[1] === "set" && args.includes("DATABASE_URL=-"),
  );
  const deploy = commands.findIndex((args) => args[0] === "deploy");
  assert.ok(directSecret >= 0, "the direct DATABASE_URL is staged");
  assert.ok(deploy > directSecret, "the direct DATABASE_URL is staged before the first deploy");
  assert.equal(
    commands.some((args) => args[0] === "mpg" && args[1] === "attach"),
    false,
  );
});

test("Fly preserves an existing DATABASE_URL even when a same-name Managed Postgres cluster exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-existing-db-"));
  const logPath = join(dir, "fly.log");
  execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    commands.some((args) => args[0] === "mpg"),
    false,
  );
  assert.equal(
    commands.some((args) => args[0] === "secrets" && args[1] === "set" && args.includes("DATABASE_URL=-")),
    false,
  );
});

test("Fly redacts credential-bearing Managed Postgres status failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-pg-error-"));
  const result = spawnSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--image-from",
      "source",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_FRESH_PG: "1",
        FAKE_FLY_STATUS_FAIL: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to read Managed Postgres connection details/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /fly-user|secret@|flympg\.net/);
});

test("fly up build-only pushes a tagged image without checking runtime deploy secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-build-only-"));
  const logPath = join(dir, "fly.log");
  const stdout = execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--build-only",
      "--image-label",
      "sha123",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.match(stdout, /--build-only --push --image-label sha123/);
  assert.match(stdout, /image: qm-core -> registry\.fly\.io\/qm-core:sha123/);
  const commands = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.equal(
    commands.some((args) => args[0] === "secrets" && args[1] === "list"),
    false,
  );
  assert.equal(
    commands.some((args) => args[0] === "secrets" && args[1] === "set"),
    true,
    "new apps receive only the ownership marker",
  );
  assert.equal(
    commands.some(
      (args) =>
        args[0] === "deploy" &&
        args.includes("--build-only") &&
        args.includes("--push") &&
        args.includes("--image-label"),
    ),
    true,
  );
});

test("fly up build-only dry-run plans without pushing an image", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-build-only-dry-run-"));
  const logPath = join(dir, "fly.log");
  const stdout = execFileSync(
    process.execPath,
    [
      bin,
      "up",
      "--config",
      join(repoRoot, "deploy", "stacks", "acme", "qm.config.jsonc"),
      "--only",
      "core",
      "--build-only",
      "--image-label",
      "sha123",
      "--dry-run",
    ],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: {
        ...process.env,
        FLY_BIN: fakeFlyBin(dir),
        FAKE_FLY_LOG: logPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  assert.match(stdout, /Plan only\. Re-run without --dry-run to build images\./);
  assert.equal(existsSync(logPath), false);
});
