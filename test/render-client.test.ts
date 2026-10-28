import { ClientError, SandboxEndedError, SandboxSnapshotNotFoundError } from "@renderinc/sdk";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkRenderClient, RENDER_SCRIPT_DIR } from "../src/sandbox/render-client.ts";
import { createFakeRender, serveFakeRenderApi } from "./support/fake-render.ts";

const SPOOLED = new RegExp(`^timeout (\\d+) sh '${RENDER_SCRIPT_DIR.replaceAll(".", "\\.")}/[0-9a-f-]{36}\\.sh'$`);
const prelude = (path: string): string =>
  `rm -f '${path}'; find '${RENDER_SCRIPT_DIR}' -type f -mmin +5 -delete 2>/dev/null\n`;

function fakeStream(t: import("node:test").TestContext, stream: string) {
  const sent: Array<{ path: string; body: string }> = [];
  t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    sent.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/files/upload/token"))
      return Response.json({ uri: "https://sandbox.example/files", method: "PUT", token: "file-secret" });
    if (url.pathname.endsWith("/runs/stream/token"))
      return Response.json({
        uri: "https://sandbox.example/stream",
        method: "POST",
        token: "stream-secret",
        executionId: "exe-test",
      });
    if (url.pathname === "/files") return new Response(null, { status: 204 });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  return sent;
}

const sandbox = {
  id: "sbx-test",
  status: "running",
  plan: "standard",
  networkPolicy: { type: "allow-all" },
  region: "oregon",
  timeoutSeconds: 86400,
  createdAt: "2026-09-12T00:00:00Z",
};
const snapshot = {
  id: "snp-test",
  name: "qm-test",
  sandboxGroupId: "sbg-test",
  sourceSandboxId: "sbx-test",
  kind: "filesystem",
  status: "available",
  plan: "standard",
  requestedAt: "2026-09-12T00:00:00Z",
  capturedAt: "2026-09-12T00:00:01Z",
  expiresAt: "2026-10-12T00:00:00Z",
};

test("Render SDK adapter maps sandbox and snapshot records and forwards the creation settings", async (t) => {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    assert.equal(request.headers.get("authorization"), "Bearer secret");
    const path = new URL(request.url).pathname;
    requests.push({
      method: request.method,
      path,
      ...(request.method === "POST" ? { body: await request.json() } : {}),
    });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(path.includes("/snapshots") ? snapshot : sandbox);
  });
  const client = createSdkRenderClient({
    apiKey: "secret",
    workspaceId: "tea-test",
  });
  const info = await client.create("snp-base");
  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/v1/sandboxes",
      body: { ownerId: "tea-test", timeoutSeconds: 86400, idleTimeoutSeconds: 0, snapshotId: "snp-base" },
    },
    { method: "GET", path: "/v1/sandboxes/sbx-test" },
  ]);
  assert.equal(info.id, sandbox.id);
  assert.equal(info.status, "running");
  assert.equal(info.expiresAtMs, Date.parse(sandbox.createdAt) + 86400_000);
  const saved = await client.createSnapshot(info.id, "qm-test");
  assert.equal(saved.id, snapshot.id);
  assert.equal(saved.sandboxGroupId, snapshot.sandboxGroupId);
  assert.equal(saved.status, "available");
  assert.equal(saved.capturedAtMs, Date.parse(snapshot.capturedAt));
  assert.equal(saved.expiresAtMs, Date.parse(snapshot.expiresAt));
  assert.deepEqual(await client.getSnapshot(saved), saved);
  await client.deleteSnapshot(saved);
  assert.deepEqual(requests.slice(2), [
    { method: "POST", path: "/v1/sandboxes/sbx-test/snapshots", body: { kind: "filesystem", name: "qm-test" } },
    { method: "GET", path: "/v1/sandbox-groups/sbg-test/snapshots/snp-test" },
    { method: "DELETE", path: "/v1/sandbox-groups/sbg-test/snapshots/snp-test" },
  ]);
});

test("Render SDK adapter waits for a checkpoint and keeps the provider reason when it fails", async (t) => {
  const statuses = ["creating", "available", "creating", "failed"];
  t.mock.method(globalThis, "fetch", async () => {
    const status = statuses.shift()!;
    return Response.json({ ...snapshot, status, ...(status === "failed" ? { error: "Provider: no capacity" } : {}) });
  });
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  const pending = { id: "snp-test", sandboxGroupId: "sbg-test", status: "creating" as const, expiresAtMs: 0 };
  assert.equal((await client.waitSnapshot(pending)).status, "available");
  await assert.rejects(client.waitSnapshot(pending), /Render checkpoint snp-test failed: Provider: no capacity/);
});

test("Render SDK adapter keeps waiting through a transient API error while a sandbox or checkpoint starts", async (t) => {
  let sandboxReads = 0;
  let snapshotReads = 0;
  t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST") return Response.json({ ...sandbox, status: "creating" }, { status: 201 });
    if (path.includes("/snapshots/")) {
      return ++snapshotReads === 1
        ? Response.json({ message: "unavailable" }, { status: 503 })
        : Response.json(snapshot);
    }
    return ++sandboxReads === 1
      ? Response.json({ message: "unavailable" }, { status: 503 })
      : Response.json({ ...sandbox, status: "running" });
  });
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  assert.equal((await client.create()).status, "running");
  const pending = { id: "snp-test", sandboxGroupId: "sbg-test", status: "creating" as const, expiresAtMs: 0 };
  assert.equal((await client.waitSnapshot(pending)).status, "available");
  assert.deepEqual([sandboxReads, snapshotReads], [2, 2]);
});

for (const becomesReady of [true, false]) {
  test(`Render SDK adapter limits startup requests and ${becomesReady ? "returns a ready sandbox" : "cleans up after timeout"}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-09-12T00:00:00Z") });
    const start = Date.now();
    let reads = 0;
    let creates = 0;
    let terminations = 0;
    t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/terminate")) {
        terminations++;
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST") creates++;
      else reads++;
      return Response.json({
        ...sandbox,
        status: becomesReady && Date.now() - start >= 60_000 ? "running" : "creating",
      });
    });
    const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
    const outcome = client.create().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let settled = false;
    void outcome.then(() => (settled = true));
    while (!settled) {
      await new Promise((resolve) => setImmediate(resolve));
      t.mock.timers.tick(250);
    }
    const result = await outcome;
    const elapsed = Date.now() - start;
    if (becomesReady) {
      assert.equal((result as { value: { status: string } }).value.status, "running");
      assert.ok(elapsed >= 60_000 && elapsed < 63_000, `${elapsed}ms`);
      assert.ok(reads < 40, `${reads} startup requests in ${elapsed}ms`);
    } else {
      assert.equal((result as { error: Error }).error.name, "SandboxWaitTimeoutError");
      assert.ok(elapsed >= 180_000 && elapsed < 183_000, `${elapsed}ms`);
      assert.ok(reads < 110, `${reads} startup requests in ${elapsed}ms`);
    }
    assert.equal(creates, 1);
    assert.equal(terminations, becomesReady ? 0 : 1);
  });
}

test("Render SDK adapter uploads binary files to new directories without a command", async (t) => {
  const fake = createFakeRender();
  t.after(() => fake.cleanup());
  const http = serveFakeRenderApi(t, fake);
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  const { id } = await client.create();
  const path = "/root/new/nested/data.bin";
  for (const bytes of [Buffer.from([0, 255, 128, 10]), Buffer.from("replacement")]) {
    await client.writeFileBytes(id, path, bytes);
    assert.deepEqual(await fake.client.readFileBytes(id, path), bytes);
  }
  assert.deepEqual(http.proxyCommands, []);
  assert.deepEqual(
    http.tokenRequests.map((request) => request.operation),
    ["upload", "upload"],
  );
  assert.equal(http.uploads.length, 2);
});

test("Render SDK adapter keeps stdout, stderr, and nonzero exit status of an uploaded script", async (t) => {
  const sent = fakeStream(
    t,
    'event: output\ndata: {"stream":"stdout","data":"hello\\n"}\n\nevent: output\ndata: {"stream":"stderr","data":"problem\\n"}\n\nevent: exit\ndata: {"exit_code":7}\n\n',
  );
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  assert.deepEqual(await client.runScript("sbx-test", "example command", 10), {
    stdout: "hello\n",
    stderr: "problem\n",
    exitCode: 7,
  });
  assert.deepEqual(
    sent.map((request) => request.path),
    ["/v1/sandboxes/sbx-test/files/upload/token", "/files", "/v1/sandboxes/sbx-test/runs/stream/token", "/stream"],
  );
  const command = (JSON.parse(sent[2]!.body) as { command: string }).command;
  assert.match(command, SPOOLED);
  assert.equal(SPOOLED.exec(command)![1], "10");
  assert.deepEqual(JSON.parse(sent[3]!.body), { command });
  const path = command.slice(command.indexOf("'") + 1, -1);
  assert.equal(sent[1]!.body, `${prelude(path)}example command`);
});

function scriptedApi(t: import("node:test").TestContext, failures: Map<string, number[]>) {
  const attempts = new Map<string, number>();
  t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    const status = failures.get(key)?.shift();
    if (status === 0) throw new TypeError("fetch failed");
    if (status && status < 0) return new Response(null, { status: -status });
    if (status) return Response.json({ message: `injected ${status}` }, { status });
    if (url.pathname.endsWith("/files/upload/token"))
      return Response.json({ uri: "https://sandbox.example/files", method: "PUT", token: "file-token" });
    if (url.pathname.endsWith("/files/download/token"))
      return Response.json({ uri: "https://sandbox.example/files", method: "GET", token: "file-token" });
    if (url.pathname.endsWith("/runs/stream/token"))
      return Response.json({ uri: "https://sandbox.example/stream", method: "POST", token: "t", executionId: "exe" });
    if (url.pathname === "/stream")
      return new Response('event: exit\ndata: {"exit_code":0}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    if (url.pathname === "/files")
      return request.method === "PUT" ? new Response(null, { status: 204 }) : new Response("data");
    if (url.pathname.endsWith("/terminate") || request.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json(url.pathname.includes("/snapshots") ? snapshot : sandbox);
  });
  return (key: string) => attempts.get(key) ?? 0;
}

test("Render SDK adapter retries reads, deletes, and file transfers after a server error or a lost connection", async (t) => {
  const attempts = scriptedApi(
    t,
    new Map([
      ["GET /v1/sandboxes/sbx-test", [0]],
      ["POST /v1/sandboxes/sbx-test/terminate", [503]],
      ["GET /v1/sandbox-groups/sbg-test/snapshots/snp-test", [503]],
      ["DELETE /v1/sandbox-groups/sbg-test/snapshots/snp-test", [503]],
      ["POST /v1/sandboxes/sbx-test/files/upload/token", [-503]],
      ["PUT /files", [0]],
      ["POST /v1/sandboxes/sbx-test/files/download/token", [-503]],
      ["GET /files", [503]],
    ]),
  );
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  assert.equal((await client.get("sbx-test"))?.id, "sbx-test");
  await client.terminate("sbx-test");
  const checkpoint = { id: "snp-test", sandboxGroupId: "sbg-test", status: "available" as const, expiresAtMs: 0 };
  assert.equal((await client.getSnapshot(checkpoint)).id, "snp-test");
  await client.deleteSnapshot(checkpoint);
  await client.writeFileBytes("sbx-test", "/root/file", Buffer.from("data"));
  assert.equal(Buffer.from((await client.readFileBytes("sbx-test", "/root/file"))!).toString(), "data");
  assert.equal(attempts("GET /v1/sandboxes/sbx-test"), 2);
  assert.equal(attempts("POST /v1/sandboxes/sbx-test/terminate"), 2);
  assert.equal(attempts("GET /v1/sandbox-groups/sbg-test/snapshots/snp-test"), 2);
  assert.equal(attempts("DELETE /v1/sandbox-groups/sbg-test/snapshots/snp-test"), 2);
  assert.equal(attempts("POST /v1/sandboxes/sbx-test/files/upload/token"), 3);
  assert.equal(attempts("PUT /files"), 2);
  assert.equal(attempts("POST /v1/sandboxes/sbx-test/files/download/token"), 3);
  assert.equal(attempts("GET /files"), 2);
  assert.equal(attempts("POST /v1/sandboxes/sbx-test/runs/stream/token"), 1);
});

test("Render SDK adapter retries sandbox and checkpoint creation only on 429", async (t) => {
  const failures = new Map([
    ["POST /v1/sandboxes", [429]],
    ["POST /v1/sandboxes/sbx-test/snapshots", [429]],
  ]);
  const attempts = scriptedApi(t, failures);
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  assert.equal((await client.create()).id, "sbx-test");
  assert.equal((await client.createSnapshot("sbx-test", "qm-test")).id, "snp-test");
  assert.equal(attempts("POST /v1/sandboxes"), 2);
  assert.equal(attempts("POST /v1/sandboxes/sbx-test/snapshots"), 2);
  failures.set("POST /v1/sandboxes", [503]);
  failures.set("POST /v1/sandboxes/sbx-test/snapshots", [503]);
  await assert.rejects(client.create(), /injected 503/);
  await assert.rejects(client.createSnapshot("sbx-test", "qm-test"), /injected 503/);
  assert.equal(attempts("POST /v1/sandboxes"), 3);
  assert.equal(attempts("POST /v1/sandboxes/sbx-test/snapshots"), 3);
});

for (const { operation, status, cleanup } of [
  { operation: "upload", status: "terminated", cleanup: false },
  { operation: "exec", status: "errored", cleanup: false },
  { operation: "exec", status: "starting", cleanup: true },
]) {
  test(`Render SDK adapter handles ${operation} failure in a ${status} sandbox`, async (t) => {
    const commands: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/v1/sandboxes/sbx-test") return Response.json({ ...sandbox, status });
      if (path.endsWith("/files/upload/token"))
        return operation === "upload"
          ? Response.json({ message: "sandbox is not ready" }, { status: 404 })
          : Response.json({ uri: "https://sandbox.example/files", method: "PUT", token: "file-token" });
      if (path === "/files") return new Response(null, { status: 204 });
      if (path.endsWith("/runs/stream/token")) {
        commands.push(((await request.json()) as { command: string }).command);
        if (operation === "exec" && commands.length === 1)
          return Response.json({ message: "sandbox is not ready" }, { status: 404 });
        return Response.json({ uri: "https://sandbox.example/stream", method: "POST", token: "t", executionId: "exe" });
      }
      return new Response('event: exit\ndata: {"exit_code":0}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
    await assert.rejects(client.runScript("sbx-test", "echo once", 30), (error: unknown) => {
      assert.ok(error instanceof ClientError);
      assert.equal(error.statusCode, 404);
      if (cleanup) assert.equal(error instanceof SandboxEndedError, false);
      else {
        assert.ok(error instanceof SandboxEndedError);
        assert.equal(error.sandboxStatus, status);
      }
      return true;
    });
    assert.equal(commands.length, Number(operation === "exec") + Number(cleanup));
    if (cleanup) assert.match(commands.at(-1)!, /^rm -f '/);
  });
}

test("Render SDK adapter sends an exec once", async (t) => {
  const attempts = scriptedApi(t, new Map([["POST /v1/sandboxes/sbx-test/runs/stream/token", [503]]]));
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  await assert.rejects(client.runScript("sbx-test", "echo once", 30), /injected 503/);
  assert.equal(attempts("POST /v1/sandboxes/sbx-test/runs/stream/token"), 2);
  assert.equal(attempts("POST /v1/sandboxes/sbx-test/files/upload/token"), 1);
});

test(
  "Render SDK adapter removes a sandbox or a checkpoint that Render creates after the submit deadline",
  { timeout: 10_000 },
  async (t) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (ms: number) => timeout(ms === 60_000 ? 50 : ms));
    let checkpointStatus = "creating";
    const cleaned = { sandbox: Promise.withResolvers<void>(), checkpoint: Promise.withResolvers<void>() };
    const deletes: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/v1/sandboxes") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return Response.json({ ...sandbox, id: "sbx-late", status: "creating" }, { status: 201 });
      }
      if (path === "/v1/sandboxes/sbx-late/terminate") {
        cleaned.sandbox.resolve();
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && path === "/v1/sandboxes/sbx-test/snapshots") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return Response.json({ ...snapshot, id: "snp-late", status: "creating" }, { status: 202 });
      }
      if (request.method === "GET" && path === "/v1/sandbox-groups/sbg-test/snapshots/snp-late") {
        const status = checkpointStatus;
        checkpointStatus = "available";
        return Response.json({ ...snapshot, id: "snp-late", status });
      }
      if (request.method === "DELETE" && path === "/v1/sandbox-groups/sbg-test/snapshots/snp-late") {
        deletes.push(checkpointStatus);
        if (checkpointStatus === "creating")
          return Response.json({ message: "capture in progress", code: "snapshot_creating" }, { status: 409 });
        cleaned.checkpoint.resolve();
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected ${request.method} ${path}`);
    });
    const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
    await assert.rejects(client.create(), { name: "TimeoutError" });
    await cleaned.sandbox.promise;
    await assert.rejects(client.createSnapshot("sbx-test", "qm-test"), { name: "TimeoutError" });
    await cleaned.checkpoint.promise;
    assert.deepEqual(deletes, ["available"]);
  },
);

test("Render SDK adapter treats only HTTP 404 as a missing sandbox", async (t) => {
  let status = 404;
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "unavailable" }, { status }));
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  assert.equal(await client.get("sbx-test"), null);
  await client.terminate("sbx-test");
  status = 401;
  await assert.rejects(client.get("sbx-test"), /unavailable/);
  await assert.rejects(client.terminate("sbx-test"), /unavailable/);
});

test("Render SDK adapter rejects truncated streams and removes the uploaded script", async (t) => {
  const sent = fakeStream(t, 'event: output\ndata: {"stream":"stdout","data":"partial"}\n\n');
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  await assert.rejects(client.runScript("sbx-test", "side effect", 10), /terminal event/);
  const commands = sent
    .filter((request) => request.path.endsWith("/runs/stream/token"))
    .map((request) => (JSON.parse(request.body) as { command: string }).command);
  assert.equal(commands.length, 2);
  assert.match(commands[0]!, SPOOLED);
  assert.equal(commands[1], `rm -f ${commands[0]!.slice(commands[0]!.indexOf("'"))}`);
});

test("Render SDK adapter keeps scripts and secrets out of run token requests and runs scripts past the argument limit", async (t) => {
  const fake = createFakeRender();
  t.after(() => fake.cleanup());
  const http = serveFakeRenderApi(t, fake);
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  const { id } = await client.create();
  const secret = "turn-secret-value-4711";
  const payload = "x".repeat(200 * 1024);
  const result = await client.runScript(
    id,
    `export QM_TURN_TOKEN='${secret}'\npayload='${payload}'\nprintf '%s:%s' "$QM_TURN_TOKEN" "\${#payload}"`,
    30,
  );
  assert.deepEqual(result, { stdout: `${secret}:${payload.length}`, stderr: "", exitCode: 0 });
  const runs = http.tokenRequests.filter((request) => request.operation === "stream");
  assert.equal(runs.length, 1);
  for (const request of http.tokenRequests) {
    assert.equal(request.body.includes(secret), false);
    assert.equal(request.body.includes(payload.slice(0, 64)), false);
  }
  assert.match((JSON.parse(runs[0]!.body) as { command: string }).command, SPOOLED);
  assert.ok(http.proxyCommands.every((command) => command.length < 200 && !command.includes(secret)));
  assert.equal(http.uploads.length, 1);
  assert.ok(http.uploads[0]!.path.startsWith(`${RENDER_SCRIPT_DIR}/`));
  const spoolDir = join(fake.home(id), RENDER_SCRIPT_DIR);
  assert.ok(!existsSync(spoolDir) || readdirSync(spoolDir).length === 0);
});

test("Render SDK adapter removes scripts that an earlier run left behind", async (t) => {
  const fake = createFakeRender();
  t.after(() => fake.cleanup());
  serveFakeRenderApi(t, fake);
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  const { id } = await client.create();
  const spoolDir = join(fake.home(id), RENDER_SCRIPT_DIR);
  mkdirSync(spoolDir, { recursive: true });
  const stale = join(spoolDir, "00000000-0000-0000-0000-000000000000.sh");
  const recent = join(spoolDir, "11111111-1111-1111-1111-111111111111.sh");
  writeFileSync(stale, "export QM_TURN_TOKEN='left-behind'");
  writeFileSync(recent, "echo starting");
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(stale, old, old);
  assert.equal((await client.runScript(id, "echo ran", 30)).stdout, "ran\n");
  assert.deepEqual(readdirSync(spoolDir), ["11111111-1111-1111-1111-111111111111.sh"]);
});

test("Render SDK adapter bounds a stalled run token request by the script deadline and a short cleanup", async (t) => {
  const commands: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/files/upload/token"))
      return Response.json({ uri: "https://sandbox.example/files", method: "PUT", token: "file-token" });
    if (url.pathname === "/files") return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/runs/stream/token")) {
      commands.push(((await request.json()) as { command: string }).command);
      if (commands.length === 1) return new Promise<Response>(() => undefined);
      return Response.json({ uri: "https://sandbox.example/stream", method: "POST", token: "t", executionId: "exe" });
    }
    return new Response('event: exit\ndata: {"exit_code":0}\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  const started = Date.now();
  await assert.rejects(client.runScript("sbx-test", "sleep 60", 1));
  assert.ok(Date.now() - started < 5_000);
  assert.equal(commands.length, 2);
  assert.match(commands[0]!, SPOOLED);
  assert.match(commands[1]!, /^rm -f '/);
});

test("Render SDK adapter removes an uploaded script when the run cannot start", async (t) => {
  const fake = createFakeRender();
  t.after(() => fake.cleanup());
  let refuse = true;
  const http = serveFakeRenderApi(t, fake, (request) => {
    if (!refuse || !new URL(request.url).pathname.endsWith("/runs/stream/token")) return undefined;
    refuse = false;
    return Response.json({ message: "unavailable" }, { status: 503 });
  });
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  const { id } = await client.create();
  await assert.rejects(client.runScript(id, "export QM_TURN_TOKEN='never-run'; echo ran", 30), /unavailable/);
  assert.equal(http.uploads.length, 1);
  assert.deepEqual(http.proxyCommands, [`rm -f '${http.uploads[0]!.path}'`]);
  assert.equal(existsSync(join(fake.home(id), http.uploads[0]!.path)), false);
});

test("Render SDK adapter preserves missing checkpoint details and accepts deletion", async (t) => {
  let status = 404;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ message: "unavailable", ...(status === 404 ? { code: "snapshot_not_found" } : {}) }, { status }),
  );
  const client = createSdkRenderClient({ apiKey: "secret", workspaceId: "tea-test" });
  const checkpoint = {
    id: "snp-gone",
    sandboxGroupId: "sbg-test",
    status: "available" as const,
    expiresAtMs: Date.now(),
  };
  await assert.rejects(client.getSnapshot(checkpoint), (error: unknown) => {
    assert.ok(error instanceof SandboxSnapshotNotFoundError);
    assert.equal(error.statusCode, 404);
    assert.equal(error.code, "snapshot_not_found");
    assert.match(error.message, /unavailable/);
    return true;
  });
  await client.deleteSnapshot(checkpoint);
  status = 403;
  await assert.rejects(client.deleteSnapshot(checkpoint), /unavailable/);
});
