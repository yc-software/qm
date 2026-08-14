import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { openAdminBootstrapToken } from "../../plugins/chassis/src/admin-bootstrap.ts";
import { runAuthBootstrap, runAuthFallback } from "../src/commands/auth.ts";
import type { QmConfig } from "../src/config.ts";
import type { CoreRequestTransportOpts, DeploymentLayerTransport } from "../src/deployment-layer.ts";

function harness(
  responses: Array<{ status: number; body: string }>,
  options: { env?: string; config?: Partial<QmConfig> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "qm-auth-command-"));
  writeFileSync(
    join(dir, ".env"),
    options.env ?? "ADMIN_GRANTS=admin@example.com:org_admin\nPORTAL_SESSION_SECRET=portal-session-secret\n",
  );
  const requests: CoreRequestTransportOpts[] = [];
  const transport: DeploymentLayerTransport = async (request) => {
    requests.push(request);
    return responses.shift() ?? { status: 500, body: "{}" };
  };
  const config = {
    orgId: "acme",
    publicUrl: "https://agent.example.com",
    services: ["core", "portal", "admin", "auth"],
    ...options.config,
  } as QmConfig;
  return { dir, requests, transport, config };
}

test("auth bootstrap derives the unique email administrator and prints a ten-minute fragment token", async () => {
  const minted = (await import("../../plugins/chassis/src/admin-bootstrap.ts")).mintAdminBootstrapToken(
    { org: "acme", principal: "admin@example.com" },
    "core-signing-secret",
  );
  const h = harness([
    { status: 200, body: JSON.stringify({ token: minted.token, expiresAt: minted.claims.exp * 1000 }) },
  ]);
  const lines: string[] = [];
  const log = mock.method(console, "log", (...values: unknown[]) => lines.push(values.join(" ")));
  try {
    await runAuthBootstrap({ config: h.config, configDir: h.dir, transport: h.transport });
  } finally {
    log.mock.restore();
  }

  assert.equal(h.requests.length, 1);
  assert.equal(
    new URL(h.requests[0]?.path ?? "", "http://core.test").pathname,
    "/v1/operator/auth-email-settings/bootstrap",
  );
  assert.equal(h.requests[0]?.method, "POST");
  assert.deepEqual(JSON.parse(h.requests[0]?.body ?? "{}"), { principal: "admin@example.com" });
  assert.doesNotMatch(h.requests[0]?.path ?? "", /token/);
  const output = lines.join("\n");
  const match = output.match(/https:\/\/agent\.example\.com\/auth\/bootstrap#token=([^\s]+)/);
  assert.ok(match);
  const claims = openAdminBootstrapToken(decodeURIComponent(match[1]!), "core-signing-secret");
  assert.equal(claims?.principal, "admin@example.com");
  assert.equal(claims?.org, "acme");
  assert.equal(claims!.exp - claims!.iat, 600);
});

test("auth bootstrap is refused permanently after first setup", async () => {
  const h = harness([{ status: 403, body: JSON.stringify({ message: "admin bootstrap is permanently disabled" }) }]);
  await assert.rejects(
    () => runAuthBootstrap({ config: h.config, configDir: h.dir, transport: h.transport }),
    /permanently disabled/,
  );
});

test("auth fallback sends only the selected administrator to the target-specific Core route", async () => {
  const h = harness([{ status: 200, body: JSON.stringify({ ok: true }) }]);
  await runAuthFallback({ config: h.config, configDir: h.dir, transport: h.transport }, "ops@example.com");

  assert.equal(h.requests[0]?.method, "POST");
  assert.equal(
    new URL(h.requests[0]?.path ?? "", "http://core.test").pathname,
    "/v1/operator/auth-email-settings/fallback",
  );
  assert.deepEqual(JSON.parse(h.requests[0]?.body ?? "{}"), { principal: "ops@example.com" });
});

test("auth bootstrap derives the administrator from the process environment", async () => {
  const h = harness([{ status: 200, body: JSON.stringify({ token: "token" }) }], { env: "" });
  const prior = process.env.ADMIN_GRANTS;
  process.env.ADMIN_GRANTS = "shell-admin@example.com:org_admin";
  const log = mock.method(console, "log", () => undefined);
  try {
    await runAuthBootstrap({ config: h.config, configDir: h.dir, transport: h.transport });
  } finally {
    log.mock.restore();
    if (prior === undefined) delete process.env.ADMIN_GRANTS;
    else process.env.ADMIN_GRANTS = prior;
  }
  assert.deepEqual(JSON.parse(h.requests[0]?.body ?? "{}"), { principal: "shell-admin@example.com" });
});

test("auth bootstrap follows a custom ADMIN_GRANTS secret-store mapping", async () => {
  const h = harness([{ status: 200, body: JSON.stringify({ token: "token" }) }], {
    env: "ORG_ADMIN_SEED=mapped-admin@example.com:org_admin\n",
    config: { secretEnv: { core: { ADMIN_GRANTS: "ORG_ADMIN_SEED" } } },
  });
  const log = mock.method(console, "log", () => undefined);
  try {
    await runAuthBootstrap({ config: h.config, configDir: h.dir, transport: h.transport });
  } finally {
    log.mock.restore();
  }
  assert.deepEqual(JSON.parse(h.requests[0]?.body ?? "{}"), { principal: "mapped-admin@example.com" });
});

test("auth commands resolve an explicit relative env file from the invocation directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "qm-auth-relative-env-"));
  const invocation = join(root, "operator");
  const configDir = join(root, "deployment");
  mkdirSync(invocation);
  mkdirSync(configDir);
  writeFileSync(join(invocation, "secrets.env"), "ADMIN_GRANTS=caller-admin@example.com:org_admin\n");
  writeFileSync(join(configDir, "secrets.env"), "ADMIN_GRANTS=wrong-admin@example.com:org_admin\n");
  const h = harness([{ status: 200, body: JSON.stringify({ token: "token" }) }]);
  const prior = process.cwd();
  const log = mock.method(console, "log", () => undefined);
  try {
    process.chdir(invocation);
    await runAuthBootstrap({
      config: h.config,
      configDir,
      envFile: "./secrets.env",
      transport: h.transport,
    });
  } finally {
    process.chdir(prior);
    log.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(JSON.parse(h.requests[0]?.body ?? "{}"), { principal: "caller-admin@example.com" });
});
