import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import type { DeploymentLayerStore } from "../src/deployment/deployment-layer-store.ts";
import { resolvedDeploymentLayer } from "../src/deployment/load-layer.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { createSandboxRouter, type SandboxRoute } from "../src/sandbox/sandbox-routing.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const LYING_DIGEST = "a".repeat(64);
const EXECUTABLE = Buffer.from("actual installed executable bytes");
const EXECUTABLE_DIGEST = createHash("sha256").update(EXECUTABLE).digest("hex");

interface RuntimeFixtureOptions {
  descriptor?: "missing" | "unopted";
  sandboxBackend?: string;
  pinned?: boolean;
  handle?: Partial<SandboxHandle>;
  executable?: Uint8Array | null;
  attestError?: Error;
  routeBackend?: "sprites";
  configuredImageVersion?: string;
}

async function runtimeFixture(t: TestContext, options: RuntimeFixtureOptions = {}) {
  const calls = [] as Array<{ kind: string; value?: unknown }>;
  const backendSandbox: Sandbox = {
    profile: { backend: "aws-microvm", writablePersistence: "snapshot_to_workspace", processSessions: true },
    async provision(layers, provisionOptions) {
      calls.push({ kind: "provision", value: { layers, options: provisionOptions } });
      return {
        id: "fresh-microvm",
        rootDir: "/workspace",
        scratch: true,
        coldStart: true,
        backend: "aws",
        executionAuthority: "none",
        imageIdentifier: "arn:aws:lambda:us-west-2:123456789012:microvm-image/sample-image",
        imageVersion: "3",
        ...options.handle,
      };
    },
    async run(_handle, command) {
      calls.push({ kind: "run", value: command });
      return {
        stdout: JSON.stringify({ contract: 1, sha256: LYING_DIGEST }),
        stderr: "",
        code: 0,
        timedOut: false,
      };
    },
    async readInstalledExecutable(_handle, binary) {
      calls.push({ kind: "attest", value: binary });
      if (options.attestError) throw options.attestError;
      return options.executable === undefined ? EXECUTABLE : options.executable;
    },
    async teardown(handle, teardownOptions) {
      calls.push({ kind: "teardown", value: { handle, options: teardownOptions } });
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async readFileBytes() {
      return null;
    },
    async writeFileBytes() {},
    async listDir() {
      return [];
    },
    async removeDir() {},
  };
  const routes = createMemoryMap<SandboxRoute>();
  if (options.routeBackend) await routes.put("org:default-org", { backend: options.routeBackend });
  const sandbox = createSandboxRouter({
    backends: { aws: backendSandbox, sprites: backendSandbox },
    routes,
    defaultBackend: "aws",
  });
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "runtime-self-check-")) }));
  const descriptor = {
    id: "sample-tool",
    install: { binary: "sample-tool" },
    ...(options.descriptor === "unopted" ? {} : { selfCheck: { kind: "executable-sha256-v1" as const } }),
  };
  const deploymentLayer = {
    live: () => ({
      source: "durable",
      contentHash: "test",
      resolved: resolvedDeploymentLayer("", options.descriptor === "missing" ? [] : [descriptor]),
    }),
  } as unknown as DeploymentLayerStore;
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sandbox,
    sandboxBackend: options.sandboxBackend ?? "aws-microvm",
    sandboxImage: {
      identifier: "sample-image",
      ...(options.pinned === false ? {} : { version: options.configuredImageVersion ?? "3" }),
    },
    deploymentLayer,
  });
  server.listen(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, calls };
}

async function selfCheck(base: string, tool = "sample-tool"): Promise<Response> {
  return fetch(`${base}/v1/admin/runtime/tools/${tool}/self-check`, { method: "POST", headers: ADMIN, body: "{}" });
}

test("admin runtime self-check externally hashes opted-in executable bytes without invoking the subject", async (t) => {
  const { base, built, calls } = await runtimeFixture(t);
  const response = await selfCheck(base);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    tool: "sample-tool",
    backend: "aws",
    imageIdentifier: "arn:aws:lambda:us-west-2:123456789012:microvm-image/sample-image",
    imageVersion: "3",
    configuredImageIdentifier: "sample-image",
    configuredImageVersion: "3",
    microvmId: "fresh-microvm",
    fresh: true,
    attestation: "external-executable-sha256-v1",
    helperSha256: EXECUTABLE_DIGEST,
  });
  assert.equal(calls[1]?.kind, "attest");
  assert.equal(calls[1]?.value, "sample-tool");
  assert.notEqual(EXECUTABLE_DIGEST, LYING_DIGEST);
  assert.equal(
    calls.some((call) => call.kind === "run"),
    false,
  );
  assert.ok(calls[0]);
  const provision = calls[0].value as {
    layers: unknown[];
    options: { scratch: unknown; env?: unknown; egress?: unknown; executionAuthority?: unknown };
  };
  assert.deepEqual(provision.layers, []);
  assert.equal(provision.options.egress, undefined);
  assert.equal(provision.options.executionAuthority, "none");
  assert.equal(provision.options.env, undefined);
  assert.ok(provision.options.scratch);
  assert.ok(calls[2]);
  assert.deepEqual((calls[2].value as { options: unknown }).options, { destroy: true });
  assert.ok((await built.auditLog.events()).some((event) => event.action === "runtime.tool_self_check"));
});

test("admin runtime self-check refuses missing opt-in, bad ids, unpinned images, and non-MicroVM defaults", async (t) => {
  await t.test("missing descriptor", async (t) => {
    const { base, calls } = await runtimeFixture(t, { descriptor: "missing" });
    assert.equal((await selfCheck(base)).status, 409);
    assert.equal(calls.length, 0);
  });
  await t.test("unopted descriptor", async (t) => {
    const { base, calls } = await runtimeFixture(t, { descriptor: "unopted" });
    const response = await selfCheck(base);
    assert.equal(response.status, 409);
    assert.match(await response.text(), /does not opt in/);
    assert.equal(calls.length, 0);
  });
  await t.test("bad id", async (t) => {
    const { base, calls } = await runtimeFixture(t);
    assert.equal((await selfCheck(base, "UPPER")).status, 400);
    assert.equal(calls.length, 0);
  });
  await t.test("unpinned image", async (t) => {
    const { base, calls } = await runtimeFixture(t, { pinned: false });
    assert.equal((await selfCheck(base)).status, 409);
    assert.equal(calls.length, 0);
  });
  for (const version of ["", " ", "3\n4", "x".repeat(129)]) {
    await t.test(`invalid image version ${JSON.stringify(version)}`, async (t) => {
      const { base, calls } = await runtimeFixture(t, { configuredImageVersion: version });
      assert.equal((await selfCheck(base)).status, 409);
      assert.equal(calls.length, 0);
    });
  }
  await t.test("bounded provider image version", async (t) => {
    const { base } = await runtimeFixture(t, {
      configuredImageVersion: "3.0",
      handle: { imageVersion: "3.0" },
    });
    assert.equal((await selfCheck(base)).status, 200);
  });
  await t.test("non-MicroVM default", async (t) => {
    const { base, calls } = await runtimeFixture(t, { sandboxBackend: "local" });
    assert.equal((await selfCheck(base)).status, 409);
    assert.equal(calls.length, 0);
  });
});

test("admin runtime self-check rejects routed, freshness, provenance, and byte-read failures and always tears down", async (t) => {
  const cases: Array<{ name: string; options: RuntimeFixtureOptions }> = [
    { name: "secondary backend", options: { routeBackend: "sprites" } },
    { name: "authority-bearing handle", options: { handle: { executionAuthority: undefined } } },
    { name: "warm handle", options: { handle: { coldStart: false } } },
    { name: "durable handle", options: { handle: { scratch: false } } },
    { name: "missing image", options: { handle: { imageIdentifier: undefined } } },
    {
      name: "wrong image identifier",
      options: { handle: { imageIdentifier: "arn:aws:lambda:us-west-2:123456789012:microvm-image/other" } },
    },
    { name: "wrong image version", options: { handle: { imageVersion: "2" } } },
    { name: "missing executable", options: { executable: null } },
    { name: "empty executable", options: { executable: new Uint8Array() } },
    { name: "oversize executable", options: { executable: new Uint8Array(1024 * 1024 + 1) } },
    { name: "attestation read failure", options: { attestError: new Error("attestation failed") } },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (t) => {
      const { base, calls } = await runtimeFixture(t, entry.options);
      const response = await selfCheck(base);
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.doesNotMatch(text, new RegExp(LYING_DIGEST));
      assert.equal(
        calls.some((call) => call.kind === "run"),
        false,
      );
      const lastCall = calls.at(-1);
      assert.ok(lastCall);
      assert.deepEqual((lastCall.value as { options: unknown }).options, { destroy: true });
    });
  }
});
