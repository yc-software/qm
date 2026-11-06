import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { relayStream } from "../plugins/chassis/src/http.ts";

const uncaught: unknown[] = [];
const onUncaught = (e: unknown): void => void uncaught.push(e);
process.on("uncaughtException", onUncaught);
test.after(() => process.off("uncaughtException", onUncaught));

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server & { url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return Object.assign(server, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
}

const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("an upstream web stream that fails mid-body fails only that response", async (t) => {
  const upstream = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    if (req.url === "/whole") return void res.end("complete");
    res.write("x".repeat(64 * 1024));
    setTimeout(() => res.socket?.destroy(), 20);
  });
  const front = await serve(async (req, res) => {
    const r = await fetch(`${upstream.url}${req.url}`);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    relayStream(r.body!, res);
  });
  t.after(() => {
    front.close();
    upstream.close();
  });
  const cut = await fetch(`${front.url}/cut`);
  await assert.rejects(cut.arrayBuffer());
  await settle();
  assert.deepEqual(uncaught, []);
  assert.equal(await (await fetch(`${front.url}/whole`)).text(), "complete");
});

test("a source that fails before any byte is sent becomes a 502 and reports the error", async (t) => {
  const reported: Error[] = [];
  const front = await serve((_req, res) => {
    const source = new PassThrough();
    relayStream(source, res, { onError: (error) => reported.push(error) });
    source.destroy(new Error("disk gone"));
  });
  t.after(() => front.close());
  const r = await fetch(front.url);
  assert.equal(r.status, 502);
  assert.deepEqual(await r.json(), { error: "upstream_error" });
  assert.deepEqual(
    reported.map((e) => e.message),
    ["disk gone"],
  );
  assert.deepEqual(uncaught, []);
});

test("a client that disconnects destroys the upstream source", async (t) => {
  const source = new Readable({ read() {} });
  const closed = new Promise<void>((r) => source.once("close", r));
  const front = await serve((_req, res) => {
    res.writeHead(200);
    relayStream(source, res);
    source.push("first chunk");
  });
  t.after(() => front.close());
  const controller = new AbortController();
  const r = await fetch(front.url, { signal: controller.signal });
  const reader = r.body!.getReader();
  await reader.read();
  controller.abort();
  await closed;
  assert.equal(source.destroyed, true);
  assert.deepEqual(uncaught, []);
});

test("an upload whose upstream drops mid-body leaves the server answering", async (t) => {
  const upstream = await serve((req) => {
    req.once("data", () => req.socket.destroy());
  });
  const front = await serve((req, res) => {
    const up = request(`${upstream.url}/`, { method: "POST" }, (upRes) => relayStream(upRes, res));
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502).end();
    });
    relayStream(req, up);
  });
  t.after(() => {
    front.close();
    upstream.close();
  });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await settle(5);
      controller.enqueue(new Uint8Array(16 * 1024));
    },
  });
  const r = await fetch(front.url, { method: "POST", body, duplex: "half" } as RequestInit);
  assert.equal(r.status, 502);
  await settle();
  assert.deepEqual(uncaught, []);
  assert.equal((await fetch(front.url, { method: "POST", body: "small" })).status, 502);
});
