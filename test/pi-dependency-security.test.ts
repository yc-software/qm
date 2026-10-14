import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const piCodingAgentTarball =
  "https://github.com/yc-software/qm/releases/download/vendored-pi-coding-agent-0.82.0-security.6/earendil-works-pi-coding-agent-0.82.0-qm-security.6.tgz";

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

  assert.deepEqual(lockedVersions(packages, "brace-expansion"), ["5.0.12"]);
  assert.deepEqual(lockedVersions(packages, "fast-uri").sort(), ["3.1.8", "4.1.5"]);
  assert.deepEqual(lockedVersions(packages, "hono"), ["4.13.9"]);
  assert.deepEqual(lockedVersions(packages, "protobufjs"), ["7.6.5"]);
  assert.deepEqual(lockedVersions(packages, "undici"), ["8.10.2"]);
  assert.deepEqual(lockedVersions(packages, "@hono/node-server"), ["2.0.10"]);
  assert.equal(dependencyVersion(minimatchManifest, "brace-expansion"), "5.0.12");
  for (const dependency of ["@fastify/ajv-compiler", "ajv", "fast-json-stringify"]) {
    const parentManifest = new URL(`../node_modules/${dependency}/package.json`, import.meta.url);
    assert.equal(
      dependencyVersion(parentManifest, "fast-uri"),
      dependency === "fast-json-stringify" ? "4.1.5" : "3.1.8",
    );
  }
  assert.equal(dependencyVersion(piManifest, "undici"), "8.10.2");
  assert.equal(dependencyVersion(piManifest, "protobufjs"), "7.6.5");
  assert.equal(installedVersion("@hono/node-server"), "2.0.10");
  assert.match(
    readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/LICENSE", import.meta.url), "utf8"),
    /Copyright \(c\) 2025 Mario Zechner/,
  );
});

function versionAtLeast(version: unknown, floor: string): boolean {
  if (typeof version !== "string") return false;
  const parts = version.split(".").map(Number);
  const minimum = floor.split(".").map(Number);
  for (const [index, required] of minimum.entries()) {
    const actual = parts[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}

// The core image runs `npm audit --omit=dev --audit-level=moderate`, so a lockfile that
// falls back below these advisory fixes fails the release build.
const advisoryFixes = {
  "@modelcontextprotocol/sdk": "1.31.0", // GHSA-6qxp-vccf-f47h
  "proxy-addr": "2.0.8", // GHSA-jqcg-44mw-7w3h
  "smol-toml": "1.9.0", // GHSA-r4xh-jqrq-34v2
};

test("the root lockfile carries the releases that fix production dependency advisories", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    packages?: Record<string, { version?: unknown }>;
  };
  for (const [dependency, floor] of Object.entries(advisoryFixes)) {
    const versions = lockedVersions(lock.packages ?? {}, dependency);
    assert.ok(versions.length > 0, `${dependency} is missing from the lockfile`);
    for (const version of versions) {
      assert.ok(versionAtLeast(version, floor), `${dependency}@${String(version)} is below the advisory fix ${floor}`);
    }
  }
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
