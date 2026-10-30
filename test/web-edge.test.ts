import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

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
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
const corePort = (core.address() as AddressInfo).port;

const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const publicPort = (probe.address() as AddressInfo).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));

const edgeModule = new URL("../src/web-edge.ts", import.meta.url).href;
const child = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `const { startWebEdge } = await import(${JSON.stringify(edgeModule)});
     await startWebEdge({ publicPort: ${publicPort}, corePort: ${corePort}, orgId: "edge-org" }, process.env);
     console.log("edge-ready", process.env.CORE_API_URL, process.env.CORE_ORG_ID);`,
  ],
  {
    env: {
      ...process.env,
      PORTAL_PUBLIC_URL: `http://localhost:${publicPort}`,
      PORTAL_SESSION_SECRET: "web-edge-test-portal-session-secret",
      CORE_SIGNING_SECRET: "web-edge-test-core-signing-secret-value",
      CORE_API_URL: "http://unreachable.invalid",
      PORTAL_LOCAL_AUTH_BYPASS: "1",
      PORTAL_DEV_PRINCIPAL: "edge-user",
      ADMIN_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => (output += chunk));
while (!output.includes("edge-ready")) await once(child.stdout, "data");

test.after(() => {
  child.kill();
  core.close();
});

test("core hosts the public front door and the web surface in its own process", async () => {
  assert.match(output, new RegExp(`edge-ready http://127\\.0\\.0\\.1:${corePort} edge-org`));
  const base = `http://localhost:${publicPort}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const login = await fetch(`${base}/auth/login?returnTo=/`, { redirect: "manual" });
  const session = login.headers.getSetCookie().find((cookie) => cookie.startsWith("portal_session="));
  assert.ok(session);
  const manifest = await fetch(`${base}/manifest.webmanifest`, { headers: { cookie: session.split(";")[0]! } });
  assert.equal(manifest.status, 200);
  assert.equal(((await manifest.json()) as { name: string }).name, "Edge Test");
  assert.ok(corePaths.includes("/v1/surface-config"));
});
