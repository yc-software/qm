import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize, resolve, sep } from "node:path";
import { runUiPublish } from "../cli/src/commands/ui.ts";

const scratch = mkdtempSync(join(tmpdir(), "qm-front-door-"));
const bucketDir = join(scratch, "bucket");
mkdirSync(bucketDir);

const corePaths: string[] = [];
const core = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0]!;
  corePaths.push(path);
  const body = path.endsWith("/canonical")
    ? { canonicalId: "edge-user" }
    : { "/v1/surface-config": { branding: { selfLabel: "Edge Test" }, modelProviderConfigured: true } }[path];
  res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(body ?? { error: "not_found" }));
});

const bucket = createServer((req, res) => {
  const key = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]!)).replace(/^\/+/, "");
  const file = resolve(bucketDir, key);
  if (!file.startsWith(bucketDir + sep)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200);
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

const listen = async (server: ReturnType<typeof createServer>): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
const corePort = await listen(core);
const bucketPort = await listen(bucket);
const probe = createServer();
const publicPort = await listen(probe);
await new Promise<void>((resolve) => probe.close(() => resolve()));

const frontDoorModule = new URL("../src/edge/front-door.ts", import.meta.url).href;
const child = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `const { startFrontDoor } = await import(${JSON.stringify(frontDoorModule)});
     const frontDoor = await startFrontDoor({ apiPort: ${corePort}, publicPort: ${publicPort} }, process.env);
     console.log("front-door-ready", process.pid, process.env.CORE_API_URL);
     process.stdin.once("data", async () => {
       await frontDoor.close();
       console.log("front-door-closed");
     });`,
  ],
  {
    env: {
      ...process.env,
      PORT: String(corePort),
      PORTAL_PUBLIC_URL: "",
      WEB_UI_PUBLIC_URL: "",
      PORTAL_SESSION_SECRET: "front-door-test-portal-session-secret",
      CORE_SIGNING_SECRET: "front-door-test-core-signing-secret-value",
      CORE_API_URL: "http://unreachable.invalid",
      PORTAL_LOCAL_AUTH_BYPASS: "1",
      PORTAL_DEV_PRINCIPAL: "edge-user",
      ADMIN_ENABLED: "0",
      WEB_UI_RELEASES_URL: `http://127.0.0.1:${bucketPort}`,
    },
    stdio: ["pipe", "pipe", "inherit"],
  },
);
let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => (output += chunk));
while (!output.includes("front-door-ready")) await once(child.stdout, "data");

test.after(() => {
  child.kill();
  core.close();
  bucket.close();
  rmSync(scratch, { recursive: true, force: true });
});

const base = `http://127.0.0.1:${publicPort}`;

function build(marker: string): string {
  const dist = join(scratch, `dist-${marker}`);
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), `<!doctype html><html><head></head><body>${marker}</body></html>`);
  writeFileSync(join(dist, "shared.html"), "<!doctype html><html><head></head><body>shared</body></html>");
  writeFileSync(join(dist, "assets", `${marker}.js`), `console.log(${JSON.stringify(marker)})`);
  return dist;
}

function publish(marker: string): void {
  const bin = join(scratch, "aws");
  writeFileSync(
    bin,
    `#!/bin/sh\nroot=${JSON.stringify(bucketDir)}\ncase "$1 $2" in\n"s3 sync") d="$root/\${4#s3://*/}"; mkdir -p "$d"; cp -R "$3/." "$d/";;\n"s3 cp") d="$root/\${4#s3://*/}"; if [ -d "$3" ]; then mkdir -p "$d"; cp "$3"/*.html "$d/"; else mkdir -p "$(dirname "$d")"; cp "$3" "$d"; fi;;\n*) exit 1;;\nesac\n`,
  );
  chmodSync(bin, 0o755);
  const previous = process.env.AWS_BIN;
  process.env.AWS_BIN = bin;
  try {
    runUiPublish({ bucket: "ui-releases", dir: build(marker) });
  } finally {
    if (previous === undefined) delete process.env.AWS_BIN;
    else process.env.AWS_BIN = previous;
  }
}

test("the edge front door serves the portal session and the web surface against core", async () => {
  assert.match(output, new RegExp(`front-door-ready ${child.pid} http://127\\.0\\.0\\.1:${corePort}`));
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.equal(((await manifest.json()) as { name: string }).name, "Edge Test");
  assert.ok(corePaths.includes("/v1/surface-config"));
});

test("a web-only publish goes live in the running edge without a restart", async () => {
  const page = async () => (await fetch(`${base}/`)).text();
  publish("release-one");
  assert.match(await page(), /release-one/);
  publish("release-two");
  const deadline = Date.now() + 15_000;
  let body = await page();
  while (!body.includes("release-two") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    body = await page();
  }
  assert.match(body, /release-two/);
  const asset = await fetch(`${base}/assets/release-two.js`);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'console.log("release-two")');
  assert.equal(child.exitCode, null);
  assert.match(output, new RegExp(`front-door-ready ${child.pid} `));
});

test("closing the front door releases the public port", async () => {
  child.stdin.end("close\n");
  while (!output.includes("front-door-closed")) await once(child.stdout, "data");
  await assert.rejects(fetch(`${base}/healthz`));
  const [code] = (await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(() => resolve(["still-running"]), 5_000)),
  ])) as [unknown];
  assert.equal(code, 0);
});
