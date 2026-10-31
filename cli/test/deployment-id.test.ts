import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAME, loadConfigAt, type QmConfig } from "../src/config.ts";
import { derivedTomlFor, flyDown } from "../src/backends/fly.ts";
import { dockerServiceEnv } from "../src/backends/docker.ts";
import { readState } from "../src/render-state.ts";
import { awsObjectStoreBucket } from "../src/terraform.ts";
import type { DeployContext } from "../src/backends/registry.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const base = {
  contract: 1,
  publicUrl: "https://agent.example.com",
  target: "docker",
  services: ["core"],
} as const;

test("a config still spelling orgId is refused with the rename to deploymentId", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-deployment-id-"));
  try {
    const path = join(dir, CONFIG_FILENAME);
    writeFileSync(path, JSON.stringify({ ...base, orgId: "acme" }));
    assert.throws(() => loadConfigAt(path), /"orgId" is now "deploymentId" — rename the key and keep its value/);
    writeFileSync(path, JSON.stringify({ ...base, deploymentId: "acme" }));
    assert.equal(loadConfigAt(path).config.deploymentId, "acme");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const flyConfig = (): QmConfig => ({
  contract: 1,
  deploymentId: "acme",
  publicUrl: "https://agent.example.com",
  target: "fly",
  appPrefix: "acme",
  region: "sjc",
  flyOrg: "personal",
  services: ["core"],
  plugins: [],
  skills: [],
  env: {},
  imageOverrides: {},
});

test("resource names derived from the deployment id stay exactly as they were", () => {
  assert.match(derivedTomlFor(flyConfig(), "core", repoRoot), /^\s*QM_DEPLOYMENT_ID = "qm-v2:personal:acme:acme"$/m);
  const docker: QmConfig = { ...flyConfig(), target: "docker", sandbox: { backend: "local" } };
  assert.equal(dockerServiceEnv(docker, "core").QM_CORE_CONTAINER, "qm-acme-core");
  const aws = {
    ...flyConfig(),
    target: "aws",
    aws: { accountId: "123456789012", region: "us-west-2", cluster: "acme-qm" },
  } as unknown as QmConfig;
  assert.equal(awsObjectStoreBucket(aws), "qm-acme-3007717887bc");
});

test("a Render resource record written under orgId is still recognized as this deployment's", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-render-state-"));
  try {
    const config = {
      ...flyConfig(),
      target: "render",
      render: { workspaceId: "tea-acme", region: "oregon" },
    } as unknown as QmConfig;
    const ctx = { config, configDir: dir } as DeployContext;
    const record = { version: 1, workspaceId: "tea-acme", region: "oregon", appPrefix: "acme", services: {} };
    writeFileSync(join(dir, "render.resources.json"), JSON.stringify({ ...record, orgId: "acme" }));
    const state = readState(ctx);
    assert.equal(state.deploymentId, "acme");
    assert.equal("orgId" in state, false);
    writeFileSync(join(dir, "render.resources.json"), JSON.stringify({ ...record, orgId: "other" }));
    assert.throws(() => readState(ctx), /belongs to another deployment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeFlyForDown(dir: string, started: Record<string, boolean>): string {
  const bin = join(dir, "fly");
  const log = join(dir, "fly.log");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
const started = ${JSON.stringify(started)};
if (a[0] === "apps" && a[1] === "list") console.log(JSON.stringify(["acme-core", ...Object.keys(started)].map((Name) => ({ Name }))));
else if (a[0] === "secrets" && a[1] === "list") console.log("QM_OWNER_CD83933C6C53374D digest");
else if (a[0] === "status") console.log(JSON.stringify({ Machines: [{ state: started[a[a.indexOf("-a") + 1]] ? "started" : "stopped" }] }));
else console.log("ok");
`,
  );
  chmodSync(bin, 0o755);
  return log;
}

test("fly down refuses while a published app is running and scales down once they are stopped", () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-down-"));
  const prior = process.env.FLY_BIN;
  const log = console.log;
  console.log = (): void => {};
  try {
    process.env.FLY_BIN = join(dir, "fly");
    const calls = fakeFlyForDown(dir, { "acme-d-blog": true, "acme-d-old": false });
    assert.throws(() => flyDown(flyConfig(), dir), /Published apps still use this deployment \(acme-d-blog\)/);
    assert.doesNotMatch(readFileSync(calls, "utf8"), /scale count 0/);
    fakeFlyForDown(dir, { "acme-d-old": false });
    flyDown(flyConfig(), dir);
    assert.match(readFileSync(calls, "utf8"), /scale count 0 -a acme-core --yes/);
  } finally {
    console.log = log;
    if (prior === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
