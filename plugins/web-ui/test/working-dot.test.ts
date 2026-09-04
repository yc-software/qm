import { test } from "node:test";
import assert from "node:assert/strict";
import { isSessionWorking, liveTurnThreadRef } from "../src/working-dot.ts";

test("no mounted chat → no thread is live", () => {
  assert.equal(liveTurnThreadRef({ mountedThreadRef: null, isStreaming: true, pendingSend: "web:u:A" }), null);
});

test("the mounted chat is live while its turn streams", () => {
  assert.equal(liveTurnThreadRef({ mountedThreadRef: "web:u:A", isStreaming: true, pendingSend: null }), "web:u:A");
});

test("the mounted chat is live the instant a send is pending — before streaming starts", () => {
  assert.equal(
    liveTurnThreadRef({ mountedThreadRef: "web:u:A", isStreaming: false, pendingSend: "web:u:A" }),
    "web:u:A",
  );
});

test("an idle mounted chat is not live", () => {
  assert.equal(liveTurnThreadRef({ mountedThreadRef: "web:u:A", isStreaming: false, pendingSend: null }), null);
});

test("a stale pendingSend for another thread never marks the mounted chat live", () => {
  assert.equal(liveTurnThreadRef({ mountedThreadRef: "web:u:B", isStreaming: false, pendingSend: "web:u:A" }), null);
});

test("mid-switch, the incoming idle row shows no dot; the outgoing streaming chat keeps its own", () => {
  const live = liveTurnThreadRef({ mountedThreadRef: "web:u:A", isStreaming: true, pendingSend: null });
  const dotFor = (s: { working: boolean; threadRef: string }): boolean =>
    s.working || (Boolean(s.threadRef) && s.threadRef === live);
  assert.equal(
    dotFor({ working: false, threadRef: "web:u:B" }),
    false,
    "incoming finished row must not borrow the dot",
  );
  assert.equal(dotFor({ working: false, threadRef: "web:u:A" }), true, "outgoing streaming chat keeps its dot");
});

test("the mounted idle chat keeps server work visible during reload or background runs", () => {
  assert.equal(
    isSessionWorking({
      serverWorking: true,
      threadRef: "web:u:A",
      liveThreadRef: null,
    }),
    true,
  );
});

test("an unmounted chat keeps using the server working flag", () => {
  assert.equal(
    isSessionWorking({
      serverWorking: true,
      threadRef: "web:u:A",
      liveThreadRef: null,
    }),
    true,
  );
});
