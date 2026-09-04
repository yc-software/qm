import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const piCodingAgentTarball =
  "https://github.com/yc-software/pi/releases/download/qm-pi-coding-agent-0.82.0-security.3/earendil-works-pi-coding-agent-0.82.0-qm-security.3.tgz";

function installedVersion(path: string): string {
  const manifestUrl = new URL(`../node_modules/${path}/package.json`, import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error(`${path} has no package version`);
  return manifest.version;
}

function dependencyVersion(parentManifest: URL | string, dependency: string): string {
  const requireFromParent = createRequire(parentManifest);
  const manifest = JSON.parse(readFileSync(requireFromParent.resolve(`${dependency}/package.json`), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") throw new Error(`${dependency} has no package version`);
  return manifest.version;
}

function lockedVersions(packages: Record<string, { version?: unknown }>, dependency: string): unknown[] {
  return [
    ...new Set(
      Object.entries(packages)
        .filter(([path]) => path === `node_modules/${dependency}` || path.endsWith(`/node_modules/${dependency}`))
        .map(([, manifest]) => manifest.version),
    ),
  ];
}

test("Pi and MCP security overrides are materialized by the root lockfile", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    packages?: Record<string, { resolved?: unknown; version?: unknown; hasShrinkwrap?: unknown }>;
  };
  const packages = lock.packages ?? {};
  const pi = packages["node_modules/@earendil-works/pi-coding-agent"];
  const piManifest = new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
  const minimatchManifest = createRequire(piManifest).resolve("minimatch/package.json");

  assert.equal(pi?.resolved, piCodingAgentTarball);
  assert.equal(pi?.hasShrinkwrap, true);
  assert.deepEqual(lockedVersions(packages, "brace-expansion"), ["5.0.9"]);
  assert.deepEqual(lockedVersions(packages, "fast-uri").sort(), ["3.1.5", "4.1.2"]);
  assert.deepEqual(lockedVersions(packages, "hono"), ["4.12.34"]);
  assert.deepEqual(lockedVersions(packages, "protobufjs"), ["7.6.5"]);
  assert.deepEqual(lockedVersions(packages, "undici"), ["8.9.0"]);
  assert.deepEqual(lockedVersions(packages, "@hono/node-server"), ["2.0.10"]);
  assert.equal(dependencyVersion(minimatchManifest, "brace-expansion"), "5.0.9");
  assert.equal(dependencyVersion(piManifest, "undici"), "8.9.0");
  assert.equal(dependencyVersion(piManifest, "protobufjs"), "7.6.5");
  assert.equal(installedVersion("@hono/node-server"), "2.0.10");
  assert.match(
    readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/LICENSE", import.meta.url), "utf8"),
    /Copyright \(c\) 2025 Mario Zechner/,
  );
});

test("MCP Streamable HTTP works through the patched Hono major", async (t) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await transport.start();
  const server = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await transport.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: "{}",
  });
  const body = (await response.json()) as { error?: { code?: number } };
  assert.equal(response.status, 400);
  assert.equal(body.error?.code, -32700);
});
