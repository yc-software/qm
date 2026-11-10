import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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

const stop = (...servers: Server[]): void => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
};

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
  t.after(() => stop(front, upstream));
  const cut = await fetch(`${front.url}/cut`);
  await assert.rejects(cut.arrayBuffer());
  await settle();
  assert.deepEqual(uncaught, []);
  assert.equal(await (await fetch(`${front.url}/whole`)).text(), "complete");
});

test("a source that fails mid-body destroys the response and reports the error", async (t) => {
  const reported: Error[] = [];
  const front = await serve((_req, res) => {
    const source = new PassThrough();
    res.writeHead(200);
    relayStream(source, res, { onError: (error) => reported.push(error) });
    source.write("partial");
    setTimeout(() => source.destroy(new Error("disk gone")), 20);
  });
  t.after(() => stop(front));
  const r = await fetch(front.url);
  await assert.rejects(r.arrayBuffer());
  assert.deepEqual(
    reported.map((e) => e.message),
    ["disk gone"],
  );
  assert.deepEqual(uncaught, []);
});

test("a client that disconnects destroys a Node readable source", async (t) => {
  const source = new Readable({ read() {} });
  const closed = new Promise<void>((r) => source.once("close", r));
  const front = await serve((_req, res) => {
    res.writeHead(200);
    relayStream(source, res);
    source.push("first chunk");
  });
  t.after(() => stop(front));
  const controller = new AbortController();
  const r = await fetch(front.url, { signal: controller.signal });
  await r.body!.getReader().read();
  controller.abort();
  await closed;
  assert.equal(source.destroyed, true);
  assert.deepEqual(uncaught, []);
});

test("a client that disconnects closes an upstream HTTP response", async (t) => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((r) => (upstreamClosed = r));
  const upstream = await serve((_req, res) => {
    res.writeHead(200);
    res.write("first chunk");
    res.once("close", upstreamClosed);
  });
  const front = await serve((_req, res) => {
    request(upstream.url, (upRes) => {
      res.writeHead(200);
      relayStream(upRes, res);
    }).end();
  });
  t.after(() => stop(front, upstream));
  const controller = new AbortController();
  const r = await fetch(front.url, { signal: controller.signal });
  await r.body!.getReader().read();
  controller.abort();
  await closed;
  assert.deepEqual(uncaught, []);
});

test("a client that aborts mid-upload destroys the upstream request", async (t) => {
  let upstreamGone!: () => void;
  const gone = new Promise<void>((r) => (upstreamGone = r));
  const upstream = await serve((req) => {
    req.on("error", () => undefined);
    req.once("close", upstreamGone);
  });
  let up!: ClientRequest;
  const front = await serve((req, res) => {
    up = request(upstream.url, { method: "POST" }, (upRes) => relayStream(upRes, res));
    up.on("error", () => undefined);
    relayStream(req, up);
  });
  t.after(() => stop(front, upstream));
  const controller = new AbortController();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      await settle(5);
      if (controller.signal.aborted) return stream.close();
      if (++sent === 3) controller.abort();
      stream.enqueue(new Uint8Array(16 * 1024));
    },
  });
  await assert.rejects(
    fetch(front.url, { method: "POST", body, duplex: "half", signal: controller.signal } as RequestInit),
  );
  await gone;
  assert.equal(up.destroyed, true);
  assert.deepEqual(uncaught, []);
});
