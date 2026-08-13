import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSandboxPublish } from "../src/commands/sandbox.ts";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";

const BASE_DIGEST = `sha256:${"a".repeat(64)}`;
const LOCAL_DIGEST = `sha256:${"b".repeat(64)}`;

function fakeFly(dir: string): string {
  const log = join(dir, "fly.log");
  writeFileSync(log, "");
  const bin = join(dir, "flyctl");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return log;
}

function fakeDockerLocal(dir: string): string {
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
// The fly-authenticated marker must NOT exist for --local-only; if it does the
// fake binary records the call so the test can assert it was never reached.
if (fs.existsSync(${JSON.stringify(join(dir, "fly-authenticated"))})) {
  fs.appendFileSync(${JSON.stringify(log)}, "UNEXPECTED_FLY_AUTH_REACHED\\n");
  process.exit(2);
}
if (joined.startsWith("buildx build")) {
  fs.appendFileSync(${JSON.stringify(log)}, "USED_LOAD=" + joined.includes("--load") + "\\n");
  fs.appendFileSync(${JSON.stringify(log)}, "USED_PUSH=" + joined.includes("--push") + "\\n");
  fs.appendFileSync(${JSON.stringify(log)}, "HAS_METADATA_FILE=" + joined.includes("--metadata-file") + "\\n");
  process.exit(0);
}
if (joined.startsWith("image inspect")) {
  const ref = args[args.length - 1];
  const withoutDigest = ref.split("@")[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  const repo = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  console.log(JSON.stringify([repo + "@${LOCAL_DIGEST}"]));
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return log;
}

test("sandbox publish --local-only skips Fly auth, uses --load, and pins the locally-loaded image", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-publish-local-"));
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
  "contract": 1,
  "orgId": "acme",
  "publicUrl": "http://localhost:8080",
  "target": "docker",
  "services": ["core"],
  "sandbox": { "app": "acme-sandboxes" }
}
`,
    );
    // No FLY_SANDBOX_API_TOKEN in .env — the auth path must not be reachable.
    writeFileSync(join(dir, ".env"), "# no fly token on purpose\n");
    const toolDir = join(dir, "sandbox", "tools", "t");
    mkdirSync(toolDir, { recursive: true });
    writeFileSync(join(toolDir, "tool.json"), JSON.stringify({ id: "t" }));
    writeFileSync(join(toolDir, "t"), "#!/usr/bin/env bash\necho hi\n");
    chmodSync(join(toolDir, "t"), 0o755);
    const dockerLog = fakeDockerLocal(dir);
    const flyLog = join(dir, "fly.log");
    process.env.PATH = `${dir}:${priorPath}`;
    // Even an ambient token must not be picked up by the local-only path.
    process.env.FLY_SANDBOX_API_TOKEN = "ambient-token-must-not-be-used";
    process.env.FLY_API_TOKEN = "ambient-fly-token-must-not-be-used";

    const { config } = loadConfigAt(configPath);
    const published = runSandboxPublish({
      sandboxDir: join(dir, "sandbox"),
      config,
      configPath,
      localOnly: true,
    });
    assert.deepEqual(published, { image: `registry.fly.io/acme-sandboxes@${LOCAL_DIGEST}` });

    const calls = readFileSync(dockerLog, "utf8");
    assert.match(calls, /USED_LOAD=true/, "buildx used --load for the local-only path");
    assert.match(calls, /USED_PUSH=false/, "buildx did not use --push for the local-only path");
    assert.match(calls, /HAS_METADATA_FILE=false/, "buildx did not request --metadata-file");
    assert.match(
      calls,
      /buildx build --platform linux\/amd64 --provenance=false --load -t registry\.fly\.io\/acme-sandboxes:latest/,
    );
    assert.doesNotMatch(calls, /UNEXPECTED_FLY_AUTH_REACHED/, "the Fly auth path was never invoked");
    assert.doesNotMatch(calls, new RegExp(BASE_DIGEST), "no registry-side digest resolution was attempted");

    const flyCalls = readFileSync(flyLog, "utf8");
    assert.equal(flyCalls, "", "flyctl was never spawned on the local-only path");

    const recorded = loadConfigAt(configPath).config;
    assert.equal(
      recorded.sandbox?.image,
      `registry.fly.io/acme-sandboxes@${LOCAL_DIGEST}`,
      "immutable pin recorded from the locally-loaded image",
    );
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    if (priorSandboxToken === undefined) delete process.env.FLY_SANDBOX_API_TOKEN;
    else process.env.FLY_SANDBOX_API_TOKEN = priorSandboxToken;
    if (priorFlyToken === undefined) delete process.env.FLY_API_TOKEN;
    else process.env.FLY_API_TOKEN = priorFlyToken;
  }
});
