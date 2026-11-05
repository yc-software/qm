import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, loadConfigAt } from "../src/config.ts";
import { dockerUp } from "../src/backends/docker.ts";

const ENV = [
  "PUBLIC_API_URL=http://qm-acme-core:8080",
  `CAPABILITY_SECRET=${"capability".repeat(4)}`,
  `CONNECTOR_SECRET_KEY=${"connector".repeat(4)}`,
  `CORE_SIGNING_SECRET=${"signing".repeat(6)}`,
  `PORTAL_IDENTITY_SECRET=${"identity".repeat(5)}`,
  `SKILL_SIGNING_SECRET=${"skill".repeat(8)}`,
  `PORTAL_SESSION_SECRET=${"session".repeat(6)}`,
  `AUTH_SIGNING_JWK={"kty":"EC","crv":"P-256","x":"x","y":"y","d":"d"}`,
  `AUTH_TOKEN_SECRET=${"token".repeat(8)}`,
  `AUTH_CLIENT_SECRET=${"client".repeat(7)}`,
  "AUTH_ALLOWED_EMAILS=admin@example.com",
  "ADMIN_GRANTS=admin@example.com:org_admin",
  "",
].join("\n");

function fakeDocker(dir: string, logs: string): string {
  const argvLog = join(dir, "docker-argv.log");
  writeFileSync(argvLog, "");
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args[0] === "version") { console.log("25.0"); process.exit(0); }
if (args[0] === "logs") { console.log(${JSON.stringify(logs)}); process.exit(0); }
if (args[0] === "inspect") { console.log(${JSON.stringify(logs.includes("front door") ? "true" : "false")}); process.exit(0); }
if (args[0] === "exec") { if (${JSON.stringify(logs.includes("front door"))}) process.exit(0); console.error("connect ECONNREFUSED 127.0.0.1:8000"); process.exit(1); }
process.exit(0);
`,
  );
  chmodSync(bin, 0o755);
  return argvLog;
}

async function up(logs: string, publicUrl = "http://localhost:8082"): Promise<{ calls: string[][]; error?: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "qm-docker-front-door-"));
  const priorPath = process.env.PATH;
  const priorDb = process.env.DATABASE_URL;
  const log = console.log;
  const warn = console.warn;
  try {
    writeFileSync(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({
        contract: 1,
        orgId: "acme",
        publicUrl,
        target: "docker",
        services: ["core", "auth"],
        env: { auth: { AUTH_EMAIL_TRANSPORT: "resend" } },
        secretEnv: { core: { ADMIN_GRANTS: "ADMIN_GRANTS" } },
      }),
    );
    writeFileSync(join(dir, ".env"), ENV);
    const argvLog = fakeDocker(dir, logs);
    process.env.PATH = `${dir}:${priorPath}`;
    process.env.DATABASE_URL = "postgres://external/db";
    console.log = () => {};
    console.warn = () => {};
    let error: unknown;
    try {
      await dockerUp(loadConfigAt(join(dir, CONFIG_FILENAME)).config, dir, {});
    } catch (caught) {
      error = caught;
    }
    const calls = readFileSync(argvLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    return { calls, ...(error === undefined ? {} : { error }) };
  } finally {
    console.log = log;
    console.warn = warn;
    process.env.PATH = priorPath;
    if (priorDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDb;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("docker up publishes core's front door on loopback", { timeout: 60_000 }, async () => {
  const { calls, error } = await up("[qm] listening on :8080\n[portal] public front door on http://localhost:8000");
  assert.equal(error, undefined);
  const run = calls.find((args) => args[0] === "run" && args.includes("qm-acme-core"))!;
  assert.ok(run.includes("8080:8080"), run.join(" "));
  assert.ok(run.includes("127.0.0.1:8082:8000"), run.join(" "));
  for (const env of ["PUBLIC_PORT=8000", "PUBLIC_WEB_URL=http://localhost:8082"]) assert.ok(run.includes(env), env);
});

test("docker up does not report core ready until its front door answers", { timeout: 60_000 }, async () => {
  const { error } = await up("[qm] listening on :8080");
  assert.match(String(error), /core exited before becoming ready/);
});

test("docker up refuses a loopback publicUrl that misses the front door's port", { timeout: 60_000 }, async () => {
  const { calls, error } = await up("[portal] public front door on http://localhost:8000", "http://localhost:8081");
  assert.match(String(error), /publicUrl http:\/\/localhost:8081 must use port 8082/);
  assert.deepEqual(calls, []);
});
