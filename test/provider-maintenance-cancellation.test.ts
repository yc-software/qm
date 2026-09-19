import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSdkE2bClient } from "../src/sandbox/e2b-client.ts";
import { createSdkSuperserveClient } from "../src/sandbox/superserve-client.ts";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { withOperationSignal } from "../src/util/async.ts";

async function serverFor(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handle);
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
const info = {
  id: "box-one",
  name: "box",
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  access_token: "access-token",
};

for (const stage of [
  "connect",
  "create",
  "list",
  "update",
  "pause",
  "kill",
  "read",
  "write",
  "command",
  "refresh",
  "missing-file-info",
] as const) {
  for (const responseStage of ["headers", "body"] as const) {
    test(
      `Superserve maintenance aborts ${stage} during ${responseStage} and joins the connection`,
      { timeout: 5_000 },
      async (t) => {
        const entered = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        let armed = false;
        const calls: string[] = [];
        const baseUrl = await serverFor(t, (req, res) => {
          calls.push(`${req.method} ${req.url}`);
          if (!armed) return reply(res, info);
          if (stage === "refresh" && req.url === "/exec/stream")
            return reply(res, { error: { message: "stale token" } }, 401);
          if (stage === "missing-file-info" && req.url?.startsWith("/files"))
            return reply(res, { error: { message: "missing file" } }, 404);
          res.on("close", closed.resolve);
          if (responseStage === "body") {
            res.writeHead(200, { "content-type": "application/json" });
            res.write("{");
          }
          entered.resolve();
        });
        const nativeFetch = globalThis.fetch;
        t.mock.method(globalThis, "fetch", (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input);
          return nativeFetch(`${baseUrl}${url.pathname}${url.search}`, init);
        });
        const client = createSdkSuperserveClient({ apiKey: "test", baseUrl });
        const session = await client.connect(info.id);
        armed = true;
        const controller = new AbortController();
        const work = withOperationSignal(controller.signal, () => {
          switch (stage) {
            case "connect":
              return client.connect(info.id);
            case "create":
              return client.create({ name: "box", metadata: {} });
            case "list":
              return client.list({});
            case "update":
              return session.update({ timeoutSeconds: 3600 });
            case "pause":
              return session.pause();
            case "kill":
              return session.kill();
            case "read":
            case "missing-file-info":
              return session.readFileBytes("/file");
            case "write":
              return session.writeFileBytes("/file", Buffer.from("contents"));
            case "command":
            case "refresh":
              return session.run("echo hello");
          }
        });
        const rejected = assert.rejects(work, { name: "AbortError" });
        await entered.promise;
        const count = calls.length;
        controller.abort();
        await rejected;
        await closed.promise;
        assert.equal(calls.length, count);
        if (stage === "refresh")
          assert.deepEqual(calls.slice(-2), ["POST /exec/stream", "POST /sandboxes/box-one/activate"]);
        if (stage === "missing-file-info")
          assert.deepEqual(calls.slice(-2), ["GET /files?path=%2Ffile", "GET /sandboxes/box-one"]);
      },
    );
  }
}

for (const stage of ["lookup", "create", "exec"] as const) {
  test(
    `Sprites maintenance aborts ${stage} response bodies before starting another request`,
    { timeout: 5_000 },
    async (t) => {
      const entered = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const calls: string[] = [];
      const baseUrl = await serverFor(t, (req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (stage === "create" && req.method === "GET") return reply(res, {}, 404);
        if (stage === "exec" && req.method === "GET") return reply(res, { name: "box" });
        res.on("close", closed.resolve);
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
        entered.resolve();
      });
      const dir = await mkdtemp(join(tmpdir(), "qm-sprite-cancel-"));
      t.after(() => rm(dir, { force: true, recursive: true }));
      const sandbox = createSpritesSandbox(createLocalWorkspaceStore(dir), {
        token: "test",
        baseUrl,
      });
      const controller = new AbortController();
      const work = withOperationSignal(controller.signal, () =>
        sandbox.provision([{ scopeId: "personal:test", mode: "rw", mountPath: "" }]),
      );
      const rejected = assert.rejects(work, { name: "AbortError" });
      await entered.promise;
      const count = calls.length;
      controller.abort();
      await rejected;
      await closed.promise;
      assert.equal(calls.length, count);
    },
  );
}

for (const stage of ["create", "connect", "list", "info", "kill"] as const) {
  test(`E2B maintenance aborts ${stage} response bodies through the native SDK`, { timeout: 5_000 }, async (t) => {
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let count = 0;
    const baseUrl = await serverFor(t, (_req, res) => {
      count++;
      res.on("close", closed.resolve);
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      entered.resolve();
    });
    const old = process.env.E2B_API_URL;
    process.env.E2B_API_URL = baseUrl;
    t.after(() => {
      if (old === undefined) delete process.env.E2B_API_URL;
      else process.env.E2B_API_URL = old;
    });
    const client = createSdkE2bClient({ apiKey: "test" });
    const controller = new AbortController();
    const work = withOperationSignal(controller.signal, () => {
      switch (stage) {
        case "create":
          return client.create({ metadata: {} });
        case "connect":
          return client.connect("box-one");
        case "list":
          return client.list({});
        case "info":
          return client.info!("box-one");
        case "kill":
          return client.kill("box-one");
      }
    });
    const rejected = assert.rejects(work);
    await entered.promise;
    controller.abort();
    await rejected;
    await closed.promise;
    assert.equal(count, 1);
  });
}
