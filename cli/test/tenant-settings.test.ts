import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QmConfig } from "../src/config.ts";
import { isTenantSetting, withoutTenantSettings } from "../src/tenant-setting-names.ts";
import { seedTenantSettings, tenantSettingsEnv } from "../src/tenant-settings.ts";
import { flyCoreLink } from "../src/backends/fly-proxy.ts";
import { CoreUnreachableError } from "../src/deployment-layer.ts";
import type { CoreLink } from "../src/operator-request.ts";
import { createHmac } from "node:crypto";
import { runtimeSecretNames, computedSecrets } from "../src/secrets.ts";

const config = (overrides: Partial<QmConfig> = {}): QmConfig => ({
  contract: 1,
  deploymentId: "acme",
  publicUrl: "https://agent.example.com",
  target: "docker",
  model: "claude-opus-4-8",
  modelProvider: "anthropic",
  botName: "straylight",
  orgName: "Acme Corp",
  services: ["core", "slack"],
  plugins: [],
  skills: [],
  env: { core: { HARNESS: "pi", PI_DETECT_MODEL: "small", S3_BUCKET: "acme-data", GOOGLE_OAUTH_CLIENT_ID: "gid" } },
  imageOverrides: {},
  sandbox: { backend: "sprites" },
  securityScreen: { mode: "observe", classifier: "model" },
  ...overrides,
});

test("tenant-owned keys are classified, and operator keys are not", () => {
  for (const name of ["ANTHROPIC_API_KEY", "SPRITES_TOKEN", "GOOGLE_OAUTH_CLIENT_SECRET", "ORG_BRAND_SELF_LABEL"])
    assert.ok(isTenantSetting(name), name);
  for (const name of ["DATABASE_URL", "CORE_SIGNING_SECRET", "S3_BUCKET", "RENDER_API_KEY", "SLACK_BOT_TOKEN"])
    assert.ok(!isTenantSetting(name), name);
  assert.deepEqual(withoutTenantSettings({ PI_MODEL: "x", PORT: "8080" }), { PORT: "8080" });
});

test("the seed gathers config, brand, sandbox, screen and .env values for the tenant row only", () => {
  const settings = tenantSettingsEnv(
    config(),
    new Map([
      ["ANTHROPIC_API_KEY", "sk-ant"],
      ["SPRITES_TOKEN", "sprite"],
      ["CORE_SIGNING_SECRET", "operator-only"],
      ["SLACK_BOT_TOKEN", "xoxb"],
    ]),
  );
  assert.deepEqual(settings, {
    SANDBOX_BACKEND: "sprites",
    PI_MODEL: "claude-opus-4-8",
    MODEL_PROVIDER: "anthropic",
    ORG_BRAND_SELF_LABEL: "straylight",
    ORG_BRAND_ORG_NAME: "Acme Corp",
    PI_DETECT_MODEL: "small",
    GOOGLE_OAUTH_CLIENT_ID: "gid",
    SECURITY_SCREEN: "observe",
    ANTHROPIC_API_KEY: "sk-ant",
    SPRITES_TOKEN: "sprite",
  });
  const anthropic = computedSecrets(config()).find((secret) => secret.name === "ANTHROPIC_API_KEY")!;
  assert.deepEqual(runtimeSecretNames("core", anthropic), [], "tenant secrets no longer route to core env");
});

test("Render seeds its sandbox backend with the deployment's workspace and key", () => {
  const render = config({
    target: "render",
    render: { workspaceId: "tea-acme", region: "oregon" } as QmConfig["render"],
  });
  const settings = tenantSettingsEnv(render, new Map([["RENDER_API_KEY", "rnd_key"]]));
  assert.equal(settings.SANDBOX_BACKEND, "render");
  assert.equal(settings.RENDER_SANDBOX_WORKSPACE_ID, "tea-acme");
  assert.equal(settings.RENDER_SANDBOX_API_KEY, "rnd_key");
  assert.equal(settings.RENDER_API_KEY, undefined);
});

function quietly<T>(fn: (lines: string[]) => Promise<T>): Promise<T> {
  const log = console.log;
  const warn = console.warn;
  const lines: string[] = [];
  console.log = (...parts: unknown[]): void => void lines.push(parts.join(" "));
  console.warn = console.log;
  return fn(lines).finally(() => {
    console.log = log;
    console.warn = warn;
  });
}

const signing = "core-signing-secret".repeat(3);
const control = "deployment-control-secret".repeat(3);

test("seeding creates the install tenant, then pushes its settings with the operator credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-tenant-seed-"));
  try {
    writeFileSync(
      join(dir, ".env"),
      `ANTHROPIC_API_KEY=sk-ant\nCORE_SIGNING_SECRET=${signing}\nDEPLOYMENT_CONTROL_SECRET=${control}\n`,
    );
    const seen: { path: string; init: RequestInit }[] = [];
    let closed = false;
    const link = async (): Promise<CoreLink> => ({
      request: async (path, init) => {
        seen.push({ path, init });
        return { status: 200, body: "{}" };
      },
      close: () => void (closed = true),
    });
    await quietly(async (lines) => {
      await seedTenantSettings({ config: config(), configDir: dir }, link);
      assert.ok(!lines.join("\n").includes("sk-ant"), "values are never printed");
    });
    assert.deepEqual(
      seen.map((entry) => entry.path),
      ["/v1/install/tenant", "/v1/tenant-settings"],
    );
    assert.ok(closed);
    const settings = seen[1]!;
    const headers = settings.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${control}`);
    const body = String(settings.init.body);
    assert.equal(JSON.parse(body).env.ANTHROPIC_API_KEY, "sk-ant");
    const expected = createHmac("sha256", signing)
      .update(`v0:${headers["x-timestamp"]}:PUT\n/v1/tenant-settings\n${body}`)
      .digest("hex");
    assert.equal(headers["x-signature"], `v0=${expected}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seeding refuses without a distinct operator credential, surfaces rejections and defers when core is unreachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-tenant-seed-"));
  try {
    const ok = async (): Promise<CoreLink> => ({ request: async () => ({ status: 200, body: "{}" }), close: () => {} });
    writeFileSync(join(dir, ".env"), `CORE_SIGNING_SECRET=${signing}\nDEPLOYMENT_CONTROL_SECRET=${signing}\n`);
    await assert.rejects(seedTenantSettings({ config: config(), configDir: dir }, ok), /must differ/);
    writeFileSync(join(dir, ".env"), `CORE_SIGNING_SECRET=${signing}\nDEPLOYMENT_CONTROL_SECRET=${control}\n`);
    const rejected = async (): Promise<CoreLink> => ({
      request: async (path) => ({
        status: path === "/v1/tenant-settings" ? 400 : 200,
        body: '{"error":"not_tenant_settings"}',
      }),
      close: () => {},
    });
    await assert.rejects(
      seedTenantSettings({ config: config(), configDir: dir }, rejected),
      /\/v1\/tenant-settings failed \(400\)/,
    );
    await quietly(async (lines) => {
      await seedTenantSettings({ config: config(), configDir: dir }, async () => {
        throw new CoreUnreachableError("could not open a private fly proxy to acme-core");
      });
      assert.match(lines.join("\n"), /run `qm settings push` once core is reachable/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Fly reaches core through a private fly proxy and closes it afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-fly-proxy-"));
  const prior = process.env.FLY_BIN;
  try {
    const log = join(dir, "requests.log");
    writeFileSync(
      join(dir, "fly"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] !== "proxy" || a[2] !== "-a" || a[3] !== "acme-core") process.exit(2);
const port = Number(a[1].split(":")[0]);
require("node:http").createServer((req, res) => {
  fs.appendFileSync(${JSON.stringify(log)}, req.method + " " + req.url + " " + req.headers.authorization + "\\n");
  res.end("{}");
}).listen(port, "127.0.0.1");
`,
    );
    chmodSync(join(dir, "fly"), 0o755);
    process.env.FLY_BIN = join(dir, "fly");
    const core = await flyCoreLink(config({ target: "fly", appPrefix: "acme" }));
    const response = await core.request("/v1/install/tenant", {
      method: "PUT",
      headers: { authorization: "Bearer x" },
    });
    core.close();
    assert.equal(response.status, 200);
    assert.equal(readFileSync(log, "utf8"), "PUT /v1/install/tenant Bearer x\n");
  } finally {
    if (prior === undefined) delete process.env.FLY_BIN;
    else process.env.FLY_BIN = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
