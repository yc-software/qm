import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGkeSandbox } from "../src/sandbox/gke-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";

test("GKE sandbox claims a scope, routes daemon calls, and destroys the claim", async () => {
  let created: Record<string, unknown> | undefined;
  let createdVersion = "";
  let deleted = "";
  const requests: Array<{ path: string; headers: Headers; body: string }> = [];
  const client = {
    async createNamespacedCustomObject(
      _group: string,
      version: string,
      _namespace: string,
      _plural: string,
      body: unknown,
    ) {
      createdVersion = version;
      created = body as Record<string, unknown>;
      return { body: { status: { sandbox: { Name: "sandbox-abc" } } } };
    },
    async getNamespacedCustomObject() {
      if (!created) {
        const error = new Error("missing") as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }
      return { body: { status: { sandbox: { Name: "sandbox-abc" } } } };
    },
    async deleteNamespacedCustomObject(
      _group: string,
      _version: string,
      _namespace: string,
      _plural: string,
      name: string,
    ) {
      deleted = name;
      return {};
    },
  };
  const files = new Map<string, Buffer>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    requests.push({ path: url.pathname, headers, body });
    if (url.pathname === "/health") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url.pathname === "/exec") {
      const command = (JSON.parse(body) as { cmd: string }).cmd;
      return new Response(JSON.stringify({ stdout: command, stderr: "", code: 0, timedOut: false }), {
        status: 200,
      });
    }
    if (url.pathname === "/write") {
      const payload = JSON.parse(body) as { path: string; b64: string };
      files.set(payload.path, Buffer.from(payload.b64, "base64"));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.pathname === "/read") {
      const payload = JSON.parse(body) as { path: string };
      const hit = files.get(payload.path);
      return hit
        ? new Response(JSON.stringify({ b64: hit.toString("base64") }), { status: 200 })
        : new Response(JSON.stringify({ error: "missing" }), { status: 404 });
    }
    return new Response("missing", { status: 404 });
  };
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "qm-gke-test-")));
  const sandbox = createGkeSandbox(workspace, {
    namespace: "qm-sandboxes",
    warmPool: "qm-sandbox-pool",
    routerUrl: "http://sandbox-router:8080",
    routerToken: "router-test-token",
    client,
    fetchImpl,
  });

  const handle = await sandbox.provision([]);
  assert.equal(handle.id, "sandbox-abc");
  assert.equal(handle.rootDir, "/home/agent/workspace");
  assert.equal(handle.backend, "gke");
  assert.ok(created);
  assert.equal(createdVersion, "v1alpha1");
  assert.equal(created.apiVersion, "extensions.agents.x-k8s.io/v1alpha1");
  assert.equal((created.spec as { warmPoolRef: { name: string } }).warmPoolRef.name, "qm-sandbox-pool");

  await sandbox.writeFile(handle, "evidence.txt", "ready");
  assert.equal(await sandbox.readFile(handle, "evidence.txt"), "ready");
  const result = await sandbox.run(handle, "printf ready");
  assert.match(result.stdout, /printf ready/);
  assert.ok(requests.every((request) => request.headers.get("x-sandbox-id") === "sandbox-abc"));
  assert.ok(requests.every((request) => request.headers.get("x-sandbox-namespace") === "qm-sandboxes"));
  assert.ok(requests.every((request) => request.headers.get("authorization") === "Bearer router-test-token"));

  await sandbox.teardown(handle, { destroy: true });
  assert.match(deleted, /^qm-default-/);
});

test("GKE sandbox deletes a newly-created claim when daemon readiness fails", async () => {
  let created = false;
  let deleted = "";
  const client = {
    async createNamespacedCustomObject() {
      created = true;
      return { body: { status: { sandbox: { name: "sandbox-broken" } } } };
    },
    async getNamespacedCustomObject() {
      if (!created) {
        const error = new Error("missing") as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }
      return { body: { status: { sandbox: { name: "sandbox-broken" } } } };
    },
    async deleteNamespacedCustomObject(
      _group: string,
      _version: string,
      _namespace: string,
      _plural: string,
      name: string,
    ) {
      deleted = name;
      return {};
    },
  };
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "qm-gke-failure-test-")));
  const sandbox = createGkeSandbox(workspace, {
    namespace: "qm-sandboxes",
    warmPool: "qm-sandbox-pool",
    routerUrl: "http://sandbox-router:8080",
    routerToken: "router-test-token",
    client,
    fetchImpl: async () => new Response("not ready", { status: 503 }),
    daemonReadyTimeoutMs: 10,
  });

  await assert.rejects(sandbox.provision([]), /never became reachable/);
  assert.match(deleted, /^qm-default-/);
});

test("GKE sandbox deletes a newly-created claim that never binds", async () => {
  let created = false;
  let deleted = "";
  const client = {
    async createNamespacedCustomObject() {
      created = true;
      return { body: { status: {} } };
    },
    async getNamespacedCustomObject() {
      if (!created) {
        const error = new Error("missing") as Error & { statusCode: number };
        error.statusCode = 404;
        throw error;
      }
      return { body: { status: {} } };
    },
    async deleteNamespacedCustomObject(
      _group: string,
      _version: string,
      _namespace: string,
      _plural: string,
      name: string,
    ) {
      deleted = name;
      return {};
    },
  };
  const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "qm-gke-unbound-test-")));
  const sandbox = createGkeSandbox(workspace, {
    namespace: "qm-sandboxes",
    warmPool: "qm-sandbox-pool",
    routerUrl: "http://sandbox-router:8080",
    routerToken: "router-test-token",
    client,
    fetchImpl: async () => new Response("unused", { status: 500 }),
    claimTimeoutMs: 10,
  });

  await assert.rejects(sandbox.provision([]), /was not ready within the deadline/);
  assert.match(deleted, /^qm-default-/);
});
