import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  SandboxError,
  SandboxTimeoutError,
  ServerError,
} from "porter-sandbox";
import { createPorterClient } from "../src/sandbox/porter-client.ts";
import { createPorterTransport } from "../src/sandbox/porter-transport.ts";
import { withOperationSignal } from "../src/util/async.ts";

async function serverFor(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const reply = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("Porter routes preserve gateway prefixes, name lookup, filters, and sandbox handle state", async (t) => {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let refreshed = 0;
  const baseUrl = await serverFor(t, async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer secret");
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    const text = Buffer.concat(parts).toString();
    calls.push({ method: req.method!, url: req.url!, body: text ? JSON.parse(text) : null });
    const url = new URL(req.url!, "http://test");
    if (url.pathname.endsWith("/lookup"))
      return reply(res, { id: url.pathname.includes("/volume/") ? "vol-id" : "box-id" });
    if (url.pathname.endsWith("/run")) return reply(res, { id: "box-id" });
    if (url.pathname.endsWith("/exec")) return reply(res, { stdout: "ok", stderr: "", exit_code: 0 });
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.endsWith("/sandbox"))
      return reply(res, { sandboxes: [{ id: "listed", name: "listed", phase: "running", tags: { scope: "a" } }] });
    if (url.pathname.endsWith("/sandbox/box-id"))
      return reply(res, {
        id: "box-id",
        name: "box",
        phase: ++refreshed === 1 ? "pending" : "running",
        tags: { scope: "a" },
        host: "box.example",
      });
    return reply(res, { id: "vol-id" });
  });
  const client = createPorterClient({ token: "secret", baseUrl: `${baseUrl}/gateway/` });
  const created = await client.sandboxes.create({ image: "image", name: "box" });
  assert.equal(created.id, "box-id");
  assert.equal(created.phase, null);
  assert.equal(created.tags, null);
  assert.equal((await created.refresh()).name, "box");
  assert.equal(created.phase, "pending");
  assert.equal((await created.refresh()).host, "box.example");
  assert.equal(created.phase, "running");
  assert.deepEqual(Object.assign({}, created.tags), { scope: "a" });
  assert.equal((await client.sandboxes.get("my box")).id, "box-id");
  assert.equal((await client.sandboxes.list({ tags: { scope: "a", role: "worker" }, page: 2 }))[0]!.phase, "running");
  assert.equal((await client.sandboxes.raw.get("box-id")).phase, "running");
  assert.deepEqual(
    { ...(await client.sandboxes.raw.exec("box-id", { command: ["echo", "ok"] })) },
    {
      stdout: "ok",
      stderr: "",
      exit_code: 0,
    },
  );
  await created.terminate();
  assert.equal((await client.volumes.create({ name: "my volume" })).id, "vol-id");
  assert.equal((await client.volumes.get("my volume")).id, "vol-id");
  await client.volumes.delete("my volume");
  assert.ok(calls.every((call) => call.url.startsWith("/gateway/v1/")));
  assert.ok(calls.some((call) => call.url === "/gateway/v1/sandbox/lookup?name=my+box"));
  assert.ok(calls.some((call) => call.url === "/gateway/v1/sandbox?tag=scope%3Da&tag=role%3Dworker&page=2"));
  assert.deepEqual(calls[0]!.body, { image: "image", name: "box" });
  assert.deepEqual(
    calls.slice(-2).map((call) => [call.method, call.url]),
    [
      ["GET", "/gateway/v1/volume/lookup?name=my+volume"],
      ["DELETE", "/gateway/v1/volume/vol-id"],
    ],
  );
});

for (const stage of ["headers", "body"]) {
  test(
    `Porter cancellation closes an active ${stage} read without starting a later delete`,
    { timeout: 5_000 },
    async (t) => {
      const entered = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const methods: string[] = [];
      const baseUrl = await serverFor(t, (req, res) => {
        methods.push(req.method!);
        res.on("close", closed.resolve);
        if (stage === "body") {
          res.writeHead(200, { "content-type": "application/json" });
          res.write('{"id":');
        }
        entered.resolve();
      });
      const controller = new AbortController();
      const client = createPorterClient({ baseUrl });
      const deleting = withOperationSignal(controller.signal, () => client.volumes.delete("name"));
      const rejected = assert.rejects(deleting, { name: "AbortError" });
      await entered.promise;
      controller.abort();
      await rejected;
      await closed.promise;
      assert.deepEqual(methods, ["GET"]);
    },
  );
}

test(
  "Porter exec deadline aborts the network request and never retries an unknown result",
  { timeout: 5_000 },
  async (t) => {
    const closed = Promise.withResolvers<void>();
    let calls = 0;
    const baseUrl = await serverFor(t, (_req, res) => {
      calls++;
      res.on("close", closed.resolve);
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"stdout":');
    });
    const client = createPorterClient({ baseUrl });
    await assert.rejects(
      client.sandboxes.raw.exec("box", { command: ["sleep", "100"] }, { timeoutMs: 100 }),
      SandboxTimeoutError,
    );
    await closed.promise;
    assert.equal(calls, 1);
  },
);

test("Porter redirects preserve JSON and same-origin auth, then permanently drop cross-origin auth", async (t) => {
  const auth: Array<string | undefined> = [];
  const bodies: string[] = [];
  const destination = await serverFor(t, async (req, res) => {
    auth.push(req.headers.authorization);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks).toString());
    reply(res, { id: "volume" });
  });
  const source = await serverFor(t, (req, res) => {
    auth.push(req.headers.authorization);
    res.writeHead(307, { location: req.url === "/same" ? `${destination}/final` : "/same" });
    res.end();
  });
  const client = createPorterClient({ baseUrl: source, token: "secret" });
  assert.equal((await client.volumes.create({ name: "volume" })).id, "volume");
  assert.deepEqual(auth, ["Bearer secret", "Bearer secret", undefined]);
  assert.deepEqual(bodies, [JSON.stringify({ name: "volume" })]);
});

test("Porter redirect loops stop after five redirects", async (t) => {
  let calls = 0;
  const baseUrl = await serverFor(t, (_req, res) => {
    calls++;
    res.writeHead(307, { location: "/again" });
    res.end();
  });
  await assert.rejects(createPorterClient({ baseUrl }).volumes.create({}), /Too many Porter API redirects/);
  assert.equal(calls, 6);
});

for (const [status, ErrorType] of [
  [400, SandboxError],
  [401, AuthenticationError],
  [404, NotFoundError],
  [429, RateLimitError],
  [503, ServerError],
] as const) {
  test(`Porter preserves SDK HTTP ${status} errors and does not retry`, async (t) => {
    let calls = 0;
    const baseUrl = await serverFor(t, (_req, res) => {
      calls++;
      reply(res, { error: "failed", message: "API detail" }, status);
    });
    await assert.rejects(createPorterClient({ baseUrl }).volumes.create({}), (error) => {
      assert.ok(error instanceof ErrorType);
      assert.equal(error.statusCode, status);
      assert.match(error.message, /failed: API detail/);
      assert.deepEqual(error.body, { error: "failed", message: "API detail" });
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("Porter network failures do not replay a creation", async () => {
  let calls = 0;
  const client = createPorterTransport({
    baseUrl: "http://example.invalid",
    fetchImpl: async () => {
      calls++;
      throw new Error("connection lost");
    },
  });
  await assert.rejects(client.sandboxes.create({ image: "image" }), /Network error: connection lost/);
  assert.equal(calls, 1);
});
