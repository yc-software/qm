import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { armBodyDeadline, extendBodyDeadline } from "../src/api/http.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeReq(complete: boolean): IncomingMessage & { destroyedWith: Error | null } {
  const s = new PassThrough() as unknown as IncomingMessage & { destroyedWith: Error | null; complete: boolean };
  s.complete = complete;
  s.destroyedWith = null;
  const orig = s.destroy.bind(s);
  (s as { destroy: (e?: Error) => unknown }).destroy = (e?: Error) => {
    s.destroyedWith = e ?? new Error("destroyed");
    return orig();
  };
  return s;
}

test("a fully-received request whose body nobody read is never destroyed by the deadline", async () => {
  const req = fakeReq(true);
  armBodyDeadline(req, 30);
  await sleep(80);
  assert.equal(req.destroyedWith, null, "an unread GET body must not look like a slow body");
});

test("a request whose body never finishes is destroyed at the deadline", async () => {
  const req = fakeReq(false);
  armBodyDeadline(req, 30);
  await sleep(80);
  assert.match(String(req.destroyedWith), /not received within/);
});

test("extending the deadline outlives the original one", async () => {
  const req = fakeReq(false);
  armBodyDeadline(req, 30);
  extendBodyDeadline(req, 200);
  await sleep(80);
  assert.equal(req.destroyedWith, null, "the extension replaced the 30ms deadline");
  await sleep(180);
  assert.match(String(req.destroyedWith), /not received within/);
});
