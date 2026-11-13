import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "./support/free-port.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "qm-web-release-"));
const dataDir = join(work, "data");
mkdirSync(dataDir);

const FAKE_AWS = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.FAKE_S3_ROOT;
const args = [];
const opts = {};
const raw = process.argv.slice(2);
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === "--size-only" || raw[i] === "--only-show-errors" || raw[i] === "--recursive") { opts[raw[i]] = true; continue; }
  if (raw[i] === "--exclude") { (opts.exclude ??= []).push(raw[++i]); continue; }
  if (raw[i].startsWith("--")) { opts[raw[i]] = raw[++i]; continue; }
  args.push(raw[i]);
}
const local = (url) => path.join(root, url.replace(/^s3:\\/\\/[^/]+\\//, ""));
const [service, verb, a, b] = args;
if (service === "s3api" && verb === "list-objects-v2") { process.stdout.write(fs.existsSync(path.join(root, opts["--prefix"])) ? "1\\n" : "0\\n"); process.exit(0); }
if (service !== "s3") { process.stderr.write("unsupported " + args.join(" ")); process.exit(2); }
if (verb === "cp" && b === "-") { process.stdout.write(fs.readFileSync(local(a))); process.exit(0); }
if (verb === "cp" && opts["--recursive"]) { const skip = (rel) => (opts.exclude ?? []).some((x) => x.endsWith("/*") ? rel.startsWith(x.slice(0, -1)) : rel === x); for (const rel of fs.readdirSync(a, { recursive: true })) { const from = path.join(a, rel); if (!fs.statSync(from).isFile() || skip(rel)) continue; const to = path.join(local(b), rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); } process.exit(0); }
if (verb === "cp") { const p = local(b); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, a === "-" ? fs.readFileSync(0) : fs.readFileSync(a)); process.exit(0); }
if (verb === "sync") { const to = local(b); fs.mkdirSync(to, { recursive: true }); for (const f of fs.readdirSync(a)) fs.copyFileSync(path.join(a, f), path.join(to, f)); process.exit(0); }
process.stderr.write("unsupported " + args.join(" ")); process.exit(2);
`;
const fakeAws = join(work, "aws");
writeFileSync(fakeAws, FAKE_AWS);
chmodSync(fakeAws, 0o755);

const configPath = join(work, "qm.config.jsonc");
writeFileSync(
  configPath,
  JSON.stringify({
    contract: 1,
    orgId: "acme",
    publicUrl: "http://localhost:8082",
    target: "docker",
    services: ["core"],
    env: { core: { SNAPSHOT_STORE: "s3", S3_BUCKET: "web-releases" } },
  }),
);

function bundle(name: string, marker: string): { dir: string; asset: string } {
  const dir = join(work, name);
  mkdirSync(join(dir, "assets"), { recursive: true });
  const asset = `assets/app-${name}.js`;
  writeFileSync(join(dir, asset), `console.log(${JSON.stringify(marker)});\n`);
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><title>${marker}</title><script type="module" src="/${asset}"></script></head><body></body></html>`,
  );
  writeFileSync(join(dir, "shared.html"), `<!doctype html><html><body>${marker}</body></html>`);
  return { dir, asset };
}

function publish(args: string[]): string {
  const r = spawnSync(
    process.execPath,
    [join(repo, "cli/bin/qm.ts"), "ui", "publish", "--config", configPath, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, AWS_BIN: fakeAws, FAKE_S3_ROOT: dataDir, NO_COLOR: "1" },
    },
  );
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const id = /web UI release ([0-9a-f]{64}) is live/.exec(r.stdout)?.[1];
  assert.ok(id, r.stdout);
  return id;
}

let core: ChildProcess | undefined;
let log = "";

test.after(() => {
  core?.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
});

async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return Date.now() - started;
    if (core?.exitCode !== null) assert.fail(`core exited while waiting for ${what}:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`timed out after ${ms} ms waiting for ${what}:\n${log}`);
}

test("a running core serves each published web UI release without restarting", async (t) => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  const [apiPort, publicPort] = [await freePort(), await freePort()];
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env))
    if (name.startsWith("MODEL_GATEWAY_") || name.startsWith("SLACK_")) delete env[name];
  core = spawn(process.execPath, ["src/index.ts"], {
    cwd: repo,
    env: {
      ...env,
      NODE_ENV: "development",
      DATA_DIR: dataDir,
      PORT: String(apiPort),
      PUBLIC_PORT: String(publicPort),
      PUBLIC_WEB_URL: `http://localhost:${publicPort}`,
      PORTAL_LOCAL_AUTH_BYPASS: "1",
      PORTAL_SESSION_SECRET: "web-release-publish-test-session-secret-0123",
      PORTAL_DEV_PRINCIPAL: "dev@example.com",
      CONNECTOR_SECRET_KEY: "a".repeat(64),
      CORE_SIGNING_SECRET: "web-release-publish-test-signing-secret",
      ORG_ID: "acme",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  core.stdout!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  core.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  await waitFor("the front door", () => log.includes("public front door on"), 90_000);
  await waitFor(
    "the bundled release step",
    () => log.includes("bundled web UI release") || log.includes("carries no web UI bundle"),
    60_000,
  );

  const page = async (): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${publicPort}/`).catch(() => undefined);
    return response?.ok ? await response.text() : "";
  };
  const a = bundle("a", "release-alpha");
  const b = bundle("b", "release-bravo");

  const idA = publish(["--dir", a.dir]);
  await waitFor("release A", async () => (await page()).includes("release-alpha"), 10_000);

  const idB = publish(["--dir", b.dir]);
  assert.notEqual(idB, idA);
  const tookB = await waitFor("release B", async () => (await page()).includes("release-bravo"), 10_000);
  t.diagnostic(`release B served ${tookB} ms after qm ui publish returned`);

  const oldAsset = await fetch(`http://127.0.0.1:${publicPort}/${a.asset}`);
  assert.equal(oldAsset.status, 200);
  assert.match(await oldAsset.text(), /release-alpha/);

  assert.equal(publish(["--release", idA]), idA);
  await waitFor("the rollback to release A", async () => (await page()).includes("release-alpha"), 10_000);

  assert.equal(core.exitCode, null);
});
