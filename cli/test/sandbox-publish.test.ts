import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinnedByDigest, runSandboxPublish } from "../src/commands/sandbox.ts";
import { CONFIG_FILENAME, loadConfigAt, type QmConfig } from "../src/config.ts";
import { hostingProvider, type DeployContext } from "../src/backends/registry.ts";

const BASE_DIGEST = `sha256:${"d".repeat(64)}`;
const PUSH_DIGEST = `sha256:${"e".repeat(64)}`;

function fakeFly(dir: string, expectedToken?: string): string {
  const log = join(dir, "fly.log");
  const marker = join(dir, "fly-authenticated");
  writeFileSync(log, "");
  const bin = join(dir, "flyctl");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
fs.appendFileSync(${JSON.stringify(log)}, "TOKEN_MATCH=" + (process.env.FLY_API_TOKEN === ${JSON.stringify(expectedToken)}) + "\\n");
if (args.join(" ") !== "auth docker") process.exit(2);
fs.writeFileSync(${JSON.stringify(marker)}, "ok");
`,
  );
  chmodSync(bin, 0o755);
  return log;
}

function fakeDocker(dir: string): string {
  fakeFly(dir);
  const log = join(dir, "docker.log");
  writeFileSync(log, "");
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const joined = args.join(" ");
if (joined.startsWith("buildx imagetools inspect")) {
  if (!fs.existsSync(${JSON.stringify(join(dir, "fly-authenticated"))})) process.exit(3);
  console.log("Name: " + args[3] + "\\nMediaType: application/vnd.oci.image.index.v1+json\\nDigest: ${BASE_DIGEST}\\n");
  process.exit(0);
}
if (args[0] === "pull") {
  process.exit(0);
}
if (joined.startsWith("image inspect")) {
  const ref = args[args.length - 1];
  const withoutDigest = ref.split("@")[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  const repo = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  console.log(JSON.stringify([repo + "@${BASE_DIGEST}"]));
  process.exit(0);
}
if (joined.startsWith("buildx build")) {
  if (!fs.existsSync(${JSON.stringify(join(dir, "fly-authenticated"))})) process.exit(3);
  const metadata = args[args.indexOf("--metadata-file") + 1];
  fs.writeFileSync(metadata, JSON.stringify({ "containerimage.digest": "${PUSH_DIGEST}" }));
  fs.appendFileSync(${JSON.stringify(log)}, "DOCKERFILE " + JSON.stringify(fs.readFileSync(args[args.indexOf("--file") + 1], "utf8")) + "\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return log;
}

test("sandbox publish pins the base, reads the pushed digest, and records the pin in the config", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-"));
  const priorPath = process.env.PATH;
  const priorSandboxToken = process.env.FLY_SANDBOX_API_TOKEN;
  const priorFlyToken = process.env.FLY_API_TOKEN;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(
      configPath,
      `{
  // The scaffold documents itself in comments — the pin must record through them.
  "contract": 1,
  "orgId": "acme",
  "publicUrl": "http://localhost:8080",
  "target": "docker",
  "services": ["core"],
  "sandbox": { "app": "acme-sandboxes" }
}
`,
    );
    const flyToken = "fixture-fly-token-must-not-appear-in-output";
    writeFileSync(join(dir, ".env"), `FLY_SANDBOX_API_TOKEN=${flyToken}\n`);
    const toolDir = join(dir, "sandbox", "tools", "t");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, "tool.json"), JSON.stringify({ id: "t" }));
    writeFileSync(join(toolDir, "t"), "#!/usr/bin/env bash\necho hi\n");
    chmodSync(join(toolDir, "t"), 0o755);
    const dockerLog = fakeDocker(dir);
    const flyLog = fakeFly(dir, flyToken);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.FLY_SANDBOX_API_TOKEN = "ambient-token-must-not-win";
    process.env.FLY_API_TOKEN = "personal-token-must-not-win";

    const { config } = loadConfigAt(configPath);
    const published = runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config, configPath });
    assert.deepEqual(published, { image: `registry.fly.io/acme-sandboxes@${PUSH_DIGEST}` });

    const calls = readFileSync(dockerLog, "utf8");
    assert.doesNotMatch(calls, /buildx imagetools inspect/, "the package-selected base is already immutable");
    assert.match(
      calls,
      /buildx build --platform linux\/amd64 --provenance=false --push -t registry\.fly\.io\/acme-sandboxes:latest/,
      "pushed an amd64 image to the app-derived repository",
    );
    const flyCalls = readFileSync(flyLog, "utf8");
    assert.match(flyCalls, /^auth docker\nTOKEN_MATCH=true\n$/);
    assert.doesNotMatch(
      `${calls}\n${flyCalls}`,
      new RegExp(flyToken),
      "the Fly token never appears in child arguments or logs",
    );

    assert.match(
      readFileSync(configPath, "utf8"),
      /documents itself in comments/,
      "recording the pin keeps the config's comments",
    );
    const recorded = loadConfigAt(configPath).config;
    assert.equal(recorded.sandbox?.image, `registry.fly.io/acme-sandboxes@${PUSH_DIGEST}`, "immutable pin recorded");
    assert.equal(
      recorded.sandbox?.baseImage,
      `registry.invalid/qm/qm-sandbox-base@sha256:${"a".repeat(64)}`,
      "the package-selected base digest is recorded",
    );
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    if (priorSandboxToken === undefined) delete process.env.FLY_SANDBOX_API_TOKEN;
    else process.env.FLY_SANDBOX_API_TOKEN = priorSandboxToken;
    if (priorFlyToken === undefined) delete process.env.FLY_API_TOKEN;
    else process.env.FLY_API_TOKEN = priorFlyToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish --from a Fly registry tag pins by pull, never by registry inspect", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-from-fly-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(
      configPath,
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { app: "acme-sandboxes" },
      }),
    );
    writeFileSync(join(dir, ".env"), "FLY_SANDBOX_API_TOKEN=FlyV1-scoped\n");
    const toolDir = join(dir, "sandbox", "tools", "t");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, "tool.json"), JSON.stringify({ id: "t" }));
    writeFileSync(join(toolDir, "t"), "#!/usr/bin/env bash\necho hi\n");
    chmodSync(join(toolDir, "t"), 0o755);
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;

    runSandboxPublish({
      sandboxDir: join(dir, "sandbox"),
      config: loadConfigAt(configPath).config,
      configPath,
      from: "registry.fly.io/acme-sandboxes:base",
    });

    const calls = readFileSync(dockerLog, "utf8");
    assert.doesNotMatch(calls, /imagetools inspect/, "app-scoped deploy tokens cannot read the registry");
    assert.match(
      calls,
      /pull --platform linux\/amd64 registry\.fly\.io\/acme-sandboxes:base/,
      "the base tag resolves through docker pull, which the deploy token allows",
    );
    assert.match(
      calls,
      new RegExp(`DOCKERFILE .*FROM registry\\.fly\\.io/acme-sandboxes:base@${BASE_DIGEST}`),
      "the layer builds from the digest-pinned base",
    );
    assert.equal(
      loadConfigAt(configPath).config.sandbox?.baseImage,
      `registry.fly.io/acme-sandboxes:base@${BASE_DIGEST}`,
      "the pull-resolved pin is recorded",
    );
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish reuses the recorded base pin for a custom Dockerfile instead of re-resolving the tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  const PIN = `ghcr.io/acme/base:v1@sha256:${"a".repeat(64)}`;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(
      configPath,
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { app: "acme-sandboxes", baseImage: PIN },
      }),
    );
    writeFileSync(join(dir, ".env"), "FLY_SANDBOX_API_TOKEN=FlyV1-scoped\n");
    mkdirSync(join(dir, "sandbox"), { recursive: true });
    writeFileSync(join(dir, "sandbox", "Dockerfile"), "FROM ghcr.io/acme/base:v1 \\\n  AS final\nRUN echo hi\n");
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;

    runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config: loadConfigAt(configPath).config, configPath });

    const calls = readFileSync(dockerLog, "utf8");
    assert.match(
      calls,
      /buildx build --platform linux\/amd64 --provenance=false --push/,
      "custom Dockerfiles target the Fly sandbox architecture too",
    );
    assert.doesNotMatch(
      calls,
      /imagetools inspect/,
      "source + committed config rebuilds without re-resolving the mutable tag",
    );
    assert.match(
      calls,
      new RegExp(`DOCKERFILE .*FROM ${PIN.replace(/[/@.]/g, "\\$&")} +AS final`),
      "the logical FROM is flattened onto the recorded pin",
    );
    assert.equal(loadConfigAt(configPath).config.sandbox?.baseImage, PIN, "the recorded pin is stable across builds");

    writeFileSync(join(dir, "sandbox", "Dockerfile"), "FROM ghcr.io/acme/base:v2 \\\n  AS final\nRUN echo hi\n");
    runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config: loadConfigAt(configPath).config, configPath });
    const rebuild = readFileSync(dockerLog, "utf8");
    assert.match(rebuild, /pull --platform linux\/amd64 ghcr\.io\/acme\/base:v2/, "the bumped tag is resolved fresh");
    assert.doesNotMatch(rebuild, /imagetools inspect/, "publish never inspects the registry");
    assert.equal(
      loadConfigAt(configPath).config.sandbox?.baseImage,
      `ghcr.io/acme/base:v2@${BASE_DIGEST}`,
      "the new tag's pin is recorded",
    );
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish rejects a custom Dockerfile whose final stage forces a non-amd64 platform", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-platform-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    const raw = JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "http://localhost:8080",
      target: "docker",
      services: ["core"],
      sandbox: { app: "acme-sandboxes" },
    });
    writeFileSync(configPath, raw);
    mkdirSync(join(dir, "sandbox"), { recursive: true });
    writeFileSync(
      join(dir, "sandbox", "Dockerfile"),
      "FROM --platform=linux/arm64 alpine:3 \\\n  AS arm\nFROM arm \\\n  AS final\n",
    );
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;

    assert.throws(
      () =>
        runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config: loadConfigAt(configPath).config, configPath }),
      /final stage forces linux\/arm64.*require linux\/amd64/,
    );
    assert.equal(readFileSync(dockerLog, "utf8"), "", "platform validation runs before registry or build side effects");
    assert.equal(readFileSync(configPath, "utf8"), raw);
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish ignores FROM text inside heredocs when checking the real final stage", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-heredoc-platform-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(
      configPath,
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { app: "acme-sandboxes" },
      }),
    );
    mkdirSync(join(dir, "sandbox"), { recursive: true });
    writeFileSync(
      join(dir, "sandbox", "Dockerfile"),
      "# syntax=docker/dockerfile:1\nFROM --platform=linux/arm64 alpine:3\nRUN <<'EOF'\nFROM alpine:3\nEOF\n",
    );
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;

    assert.throws(
      () =>
        runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config: loadConfigAt(configPath).config, configPath }),
      /final stage forces linux\/arm64.*require linux\/amd64/,
    );
    assert.equal(readFileSync(dockerLog, "utf8"), "", "heredoc payload cannot hide an incompatible real final stage");
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish recognizes ONBUILD heredocs with concatenated quoted delimiters", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-onbuild-heredoc-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(
      configPath,
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { app: "acme-sandboxes" },
      }),
    );
    mkdirSync(join(dir, "sandbox"), { recursive: true });
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;

    for (const instruction of [
      'ONBUILD RUN <<E"OF"',
      'ONBUILD COPY <<E"OF" /payload',
      'ONBUILD ADD <<E"OF" /payload',
    ]) {
      writeFileSync(
        join(dir, "sandbox", "Dockerfile"),
        `# syntax=docker/dockerfile:1\nFROM --platform=linux/arm64 alpine:3\n${instruction}\nFROM scratch\nEOF\n`,
      );
      assert.throws(
        () =>
          runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config: loadConfigAt(configPath).config, configPath }),
        /final stage forces linux\/arm64.*require linux\/amd64/,
        instruction,
      );
    }
    assert.equal(
      readFileSync(dockerLog, "utf8"),
      "",
      "ONBUILD heredoc payloads cannot hide an incompatible real final stage",
    );
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish ignores heredoc aliases when identifying mutable external bases", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-heredoc-base-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(
      configPath,
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { app: "acme-sandboxes" },
      }),
    );
    mkdirSync(join(dir, "sandbox"), { recursive: true });
    writeFileSync(
      join(dir, "sandbox", "Dockerfile"),
      "# syntax=docker/dockerfile:1\nFROM alpine:3 AS seed\nRUN <<-EOF\n\tFROM alpine:3 AS ubuntu\n\tEOF\nFROM ubuntu\n",
    );
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;

    assert.throws(
      () =>
        runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config: loadConfigAt(configPath).config, configPath }),
      /multiple mutable external base images/,
    );
    assert.equal(
      readFileSync(dockerLog, "utf8"),
      "",
      "a heredoc alias cannot exempt a real external base from pinning",
    );
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish fails closed on an unparseable FROM before Docker side effects", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-from-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(
      configPath,
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { app: "acme-sandboxes" },
      }),
    );
    mkdirSync(join(dir, "sandbox"), { recursive: true });
    writeFileSync(join(dir, "sandbox", "Dockerfile"), "FROM alpine:3 AS\nRUN true\n");
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;

    assert.throws(
      () =>
        runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config: loadConfigAt(configPath).config, configPath }),
      /unsupported or malformed FROM instruction/,
    );
    assert.equal(readFileSync(dockerLog, "utf8"), "");
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish fails when Buildx returns no immutable digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(
      configPath,
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { app: "acme-sandboxes", baseImage: `ghcr.io/base@sha256:${"f".repeat(64)}` },
      }),
    );
    writeFileSync(join(dir, ".env"), "FLY_SANDBOX_API_TOKEN=FlyV1-scoped\n");
    const toolDir = join(dir, "sandbox", "tools", "t");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, "tool.json"), JSON.stringify({ id: "t" }));
    writeFileSync(join(toolDir, "t"), "#!/usr/bin/env bash\necho hi\n");
    chmodSync(join(toolDir, "t"), 0o755);
    const bin = join(dir, "docker");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const i = args.indexOf("--metadata-file");
if (i !== -1) fs.writeFileSync(args[i + 1], JSON.stringify({ "containerimage.digest": "not-a-digest" }));
process.exit(0);
`,
    );
    chmodSync(bin, 0o755);
    fakeFly(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    const { config } = loadConfigAt(configPath);
    assert.throws(
      () => runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config, configPath }),
      /without an immutable image digest/,
    );
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish accepts FROM scratch without trying to resolve a nonexistent base digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-scratch-"));
  const priorPath = process.env.PATH;
  const log = console.log,
    warn = console.warn;
  console.log = (): void => {};
  console.warn = console.log;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    writeFileSync(
      configPath,
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl: "http://localhost:8080",
        target: "docker",
        services: ["core"],
        sandbox: { app: "acme-sandboxes" },
      }),
    );
    writeFileSync(join(dir, ".env"), "FLY_SANDBOX_API_TOKEN=FlyV1-scoped\n");
    mkdirSync(join(dir, "sandbox"), { recursive: true });
    writeFileSync(join(dir, "sandbox", "Dockerfile"), "FROM scratch\nCOPY payload /payload\n");
    writeFileSync(join(dir, "sandbox", "payload"), "ok\n");
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;

    runSandboxPublish({ sandboxDir: join(dir, "sandbox"), config: loadConfigAt(configPath).config, configPath });

    const calls = readFileSync(dockerLog, "utf8");
    assert.doesNotMatch(calls, /imagetools inspect scratch/);
    assert.match(calls, /buildx build --platform linux\/amd64 --provenance=false --push/);
    assert.equal(loadConfigAt(configPath).config.sandbox?.baseImage, undefined);
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

const AWS_BLOCK: QmConfig["aws"] = {
  accountId: "123456789012",
  region: "us-west-2",
  cluster: "acme-qm",
  deployRoleArn: "arn:aws:iam::123456789012:role/acme-deploy",
  secretsPrefix: "acme/qm/",
  imageLabel: "release",
  networking: { cloudMapNamespace: "acme.internal" },
  services: { core: { ecrRepository: "qm-core", ecsService: "acme-core", cpu: 2048, memory: 4096 } },
};

function fakeAwsBin(dir: string, manifest?: Record<string, unknown>): { log: string; restore: () => void } {
  const bin = join(dir, "aws-fake");
  const log = join(dir, "aws-cli.log");
  writeFileSync(log, "");
  const items: Record<string, unknown> = manifest
    ? {
        "deployment/current": { lockKey: { S: "deployment/current" }, manifestId: { S: "m1" } },
        "deployment/manifest/m1": {
          lockKey: { S: "deployment/manifest/m1" },
          manifest: { S: JSON.stringify(manifest) },
        },
      }
    : {};
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const a = args.join(" ");
fs.appendFileSync(${JSON.stringify(log)}, a + "\\n");
if (a.includes("sts get-caller-identity")) console.log("123456789012");
else if (a.includes("dynamodb get-item")) {
  const key = JSON.parse(args[args.indexOf("--key") + 1]).lockKey.S;
  const items = ${JSON.stringify(items)};
  console.log(JSON.stringify(items[key] ? { Item: items[key] } : {}));
}
else console.log("");
`,
  );
  chmodSync(bin, 0o755);
  const prior = process.env.AWS_BIN;
  process.env.AWS_BIN = bin;
  return {
    log,
    restore: () => {
      if (prior === undefined) delete process.env.AWS_BIN;
      else process.env.AWS_BIN = prior;
    },
  };
}

test("the AWS provider rejects sandbox registry publication before build or registry work, --app included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-aws-"));
  const priorPath = process.env.PATH;
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    const configBody = JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "https://agent.acme.example",
      target: "docker",
      services: ["core"],
    });
    writeFileSync(configPath, configBody);
    const toolDir = join(dir, "sandbox", "tools", "t");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, "tool.json"), JSON.stringify({ id: "t" }));
    writeFileSync(join(toolDir, "t"), "#!/usr/bin/env bash\necho hi\n");
    chmodSync(join(toolDir, "t"), 0o755);
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    const { config } = loadConfigAt(configPath);
    const ctx: DeployContext = {
      config: { ...config, target: "aws" },
      configPath,
      configDir: dir,
      sandboxDir: join(dir, "sandbox"),
      target: "aws",
    };
    for (const app of [undefined, "registry.example/acme/sandbox"]) {
      await assert.rejects(
        () =>
          hostingProvider("aws").publishSandbox(ctx, {
            sandboxDir: ctx.sandboxDir,
            config: ctx.config,
            configPath,
            ...(app ? { app } : {}),
          }),
        /Lambda MicroVM sandboxes.*infra build-image/,
        app ?? "no --app",
      );
    }
    assert.equal(readFileSync(dockerLog, "utf8"), "", "rejected before any docker side effect");
    assert.equal(readFileSync(configPath, "utf8"), configBody, "the config file is byte-identical");
  } finally {
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AWS sandbox publish preconditions run before the build: frozen override and missing manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-aws-precheck-"));
  const priorPath = process.env.PATH;
  const aws = fakeAwsBin(dir);
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    const pin = `registry.fly.io/acme-sandboxes@sha256:${"b".repeat(64)}`;
    const configBody = JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "https://agent.acme.example",
      target: "docker",
      services: ["core"],
      sandbox: { backend: "sprites", app: "acme-sandboxes", image: pin },
    });
    writeFileSync(configPath, configBody);
    const toolDir = join(dir, "sandbox", "tools", "t");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, "tool.json"), JSON.stringify({ id: "t" }));
    writeFileSync(join(toolDir, "t"), "#!/usr/bin/env bash\necho hi\n");
    chmodSync(join(toolDir, "t"), 0o755);
    const dockerLog = fakeDocker(dir);
    process.env.PATH = `${dir}:${priorPath}`;
    const { config } = loadConfigAt(configPath);
    const frozen: DeployContext = {
      config: { ...config, target: "aws", aws: AWS_BLOCK },
      configPath,
      configDir: dir,
      sandboxDir: join(dir, "sandbox"),
      target: "aws",
    };
    await assert.rejects(
      () =>
        hostingProvider("aws").publishSandbox(frozen, {
          sandboxDir: frozen.sandboxDir,
          config: frozen.config,
          configPath,
        }),
      /freezes the sandbox pin/,
    );
    const pinless: DeployContext = {
      ...frozen,
      config: { ...frozen.config, sandbox: { backend: "sprites", app: "acme-sandboxes" } },
    };
    await assert.rejects(
      () =>
        hostingProvider("aws").publishSandbox(pinless, {
          sandboxDir: pinless.sandboxDir,
          config: pinless.config,
          configPath,
        }),
      /no AWS deployment manifest exists yet/,
    );
    assert.equal(readFileSync(dockerLog, "utf8"), "", "preconditions fail before any docker side effect");
    assert.equal(readFileSync(configPath, "utf8"), configBody);
  } finally {
    process.env.PATH = priorPath;
    aws.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox publish on AWS with sandbox.backend sprites proceeds to the layer build (operator-hosted sandbox image)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-aws-fly-"));
  const aws = fakeAwsBin(dir, {
    id: "m1",
    createdAt: "2026-01-01T00:00:00.000Z",
    tasks: { core: "arn:aws:ecs:us-west-2:123456789012:task-definition/acme-core:1" },
  });
  try {
    const configPath = join(dir, CONFIG_FILENAME);
    const configBody = JSON.stringify({
      contract: 1,
      orgId: "acme",
      publicUrl: "https://agent.acme.example",
      target: "docker",
      services: ["core"],
      sandbox: { backend: "sprites", app: "acme-sandboxes" },
    });
    writeFileSync(configPath, configBody);
    const { config } = loadConfigAt(configPath);
    const ctx: DeployContext = {
      config: { ...config, target: "aws", aws: AWS_BLOCK },
      configPath,
      configDir: dir,
      sandboxDir: join(dir, "missing-sandbox"),
      target: "aws",
    };
    await assert.rejects(
      () => hostingProvider("aws").publishSandbox(ctx, { sandboxDir: ctx.sandboxDir, config: ctx.config, configPath }),
      /nothing to build/,
    );
    assert.equal(readFileSync(configPath, "utf8"), configBody);
  } finally {
    aws.restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pinnedByDigest verifies digest-form refs but warns and proceeds when the registry inspect fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-pinned-digest-"));
  const emptyPath = mkdtempSync(join(tmpdir(), "qm-pinned-no-docker-"));
  const priorPath = process.env.PATH;
  const good = `repo.example/app@sha256:${"a".repeat(64)}`;
  const unverifiable = `repo.example/app@sha256:${"f".repeat(64)}`;
  const log = join(dir, "docker.log");
  writeFileSync(log, "");
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
if (args.join(" ") === "buildx imagetools inspect ${good}") {
  console.log("Digest: sha256:${"a".repeat(64)}");
  process.exit(0);
}
console.error("ERROR: manifest unknown");
process.exit(1);
`,
  );
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${priorPath}`;
  const warnings: string[] = [];
  const warnLog = console.warn;
  console.warn = (...parts: unknown[]): void => void warnings.push(parts.join(" "));
  try {
    assert.equal(pinnedByDigest(good), good);
    assert.match(
      readFileSync(log, "utf8"),
      /buildx imagetools inspect repo\.example\/app@sha256:a/,
      "digest-form refs are verified when the registry is reachable",
    );
    assert.equal(warnings.length, 0);
    assert.equal(
      pinnedByDigest(unverifiable),
      unverifiable,
      "an unverifiable digest-form ref still resolves for emergency rollback",
    );
    assert.match(
      warnings.join("\n"),
      /could not verify repo\.example\/app@sha256:f{64} against the registry \(ERROR: manifest unknown\)/,
      "the warning carries docker's stderr detail",
    );
    assert.throws(
      () => pinnedByDigest("repo.example/app:v9"),
      /could not resolve an immutable digest for repo\.example\/app:v9 .*pass repo\.example\/app@sha256:<digest> to skip the registry lookup \(ERROR: manifest unknown\)/,
      "tag-form refs still fail hard — the inspect is what resolves them",
    );
    process.env.PATH = emptyPath;
    assert.equal(pinnedByDigest(good), good, "a machine without docker can still roll back to a digest-form ref");
    assert.match(warnings.at(-1)!, /could not verify repo\.example\/app@sha256:a{64} against the registry/);
  } finally {
    console.warn = warnLog;
    process.env.PATH = priorPath;
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyPath, { recursive: true, force: true });
  }
});
