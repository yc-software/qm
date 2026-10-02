import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openSseStream, parseSseFrames, sseFrame } from "../plugins/chassis/src/sse.ts";

test("sseFrame writes id, event and JSON data in a fixed order", () => {
  assert.equal(sseFrame({ a: 1 }), 'data: {"a":1}\n\n');
  assert.equal(sseFrame({}, { event: "x_resync" }), "event: x_resync\ndata: {}\n\n");
  assert.equal(sseFrame("hi", { id: "text:3" }), 'id: text:3\ndata: "hi"\n\n');
  assert.equal(sseFrame(1, { id: "7", event: "e" }), "id: 7\nevent: e\ndata: 1\n\n");
});

test("parseSseFrames keeps partial frames for the next read", () => {
  const first = parseSseFrames("event: a\ndata: 1\n\nevent: b\nda");
  assert.deepEqual(first.frames, [{ event: "a", data: "1" }]);
  const second = parseSseFrames(`${first.rest}ta: 2\n\n`);
  assert.deepEqual(second.frames, [{ event: "b", data: "2" }]);
  assert.equal(second.rest, "");
});

test("parseSseFrames handles CRLF, comments, multi-line data and ids", () => {
  const { frames } = parseSseFrames(": open\r\n\r\nid: 9\r\nevent: e\r\ndata:x\r\ndata: y\r\n: ping\r\n\r\n");
  assert.deepEqual(frames, [{ data: "" }, { id: "9", event: "e", data: "x\ny" }]);
});

test("parseSseFrames splits a CRLF terminator torn across reads", () => {
  const first = parseSseFrames("data: 1\r\n\r");
  assert.deepEqual(first.frames, []);
  assert.deepEqual(parseSseFrames(`${first.rest}\ndata: 2\n\n`).frames, [{ data: "1" }, { data: "2" }]);
});

test("openSseStream sends headers, open comment, heartbeats, and stops on disconnect", async () => {
  let stopped!: () => void;
  const stoppedP = new Promise<void>((r) => (stopped = r));
  const server: Server = createServer((req, res) =>
    openSseStream(req, res, 20, () => {
      res.write(sseFrame({ ok: true }, { event: "hello" }));
      return stopped;
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { signal: ac.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(": ping\n\n")) text += decoder.decode((await reader.read()).value, { stream: true });
    assert.ok(text.startsWith(': open\n\nevent: hello\ndata: {"ok":true}\n\n'));
    ac.abort();
    await stoppedP;
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
