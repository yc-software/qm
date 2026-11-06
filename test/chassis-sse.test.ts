import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openSseStream, parseSseFrames, sseFrame } from "../plugins/chassis/src/sse.ts";

test("sseFrame writes id, event and JSON data in wire order", () => {
  assert.equal(sseFrame({ a: 1 }), 'data: {"a":1}\n\n');
  assert.equal(sseFrame({}, { event: "x_resync" }), "event: x_resync\ndata: {}\n\n");
  assert.equal(sseFrame("v", { id: "7", event: "e" }), 'id: 7\nevent: e\ndata: "v"\n\n');
});

test("parseSseFrames round-trips frames and keeps partial input as rest", () => {
  const wire = `: open\n\n${sseFrame({ n: 1 }, { event: "a" })}${sseFrame({ n: 2 }, { id: "9" })}event: a\ndata: {"n"`;
  const { frames, rest } = parseSseFrames(wire);
  assert.deepEqual(frames, [{ data: "" }, { event: "a", data: '{"n":1}' }, { id: "9", data: '{"n":2}' }]);
  assert.equal(rest, 'event: a\ndata: {"n"');
});

test("parseSseFrames handles CRLF, comments, unspaced fields and multi-line data", () => {
  const { frames, rest } = parseSseFrames("event:e\r\n: ping\r\ndata: one\r\ndata:two\r\n\r\ndata: tail");
  assert.deepEqual(frames, [{ event: "e", data: "one\ntwo" }]);
  assert.equal(rest, "data: tail");
});

test("openSseStream subscribes until the request closes and skips already-closed clients", () => {
  const writes: string[] = [];
  const res = { destroyed: false, writeHead: () => undefined, write: (chunk: string) => writes.push(chunk) };
  const req = new EventEmitter();
  let live = 0;
  const start = () => {
    live++;
    return () => live--;
  };
  openSseStream(req as IncomingMessage, res as unknown as ServerResponse, 60_000, start);
  assert.deepEqual([live, writes], [1, [": open\n\n"]]);
  req.emit("close");
  assert.equal(live, 0);
  openSseStream(req as IncomingMessage, { ...res, destroyed: true } as unknown as ServerResponse, 60_000, start);
  assert.equal(live, 0);
});
