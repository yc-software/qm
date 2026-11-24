import assert from "node:assert/strict";
import { test } from "node:test";
import { answerDesktopCall, stopDesktopCall } from "../src/desktop-computer.ts";

const claim = { runId: "11111111-1111-4111-8111-111111111111", args: { code: "1" }, deadline: Date.now() + 50_000 };

function recorder(onClaim: () => unknown) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const post = async (path: string, body: unknown) => {
    posts.push({ path, body: body as Record<string, unknown> });
    return path.endsWith("/claim") ? onClaim() : { ok: true };
  };
  return { posts, post };
}

test("the window that wins the claim runs the call once under the run's key and posts the result", async () => {
  const { posts, post } = recorder(() => claim);
  const calls: unknown[][] = [];
  await answerDesktopCall("call-1", post, {
    call: async (...args) => {
      calls.push(args);
      return { content: "Calculator" };
    },
  });
  assert.deepEqual(calls, [[claim.args, claim.runId, claim.deadline]]);
  assert.deepEqual(
    posts.map((p) => p.path),
    ["/api/desktop/calls/call-1/claim", "/api/desktop/calls/call-1/result"],
  );
  assert.equal(posts[0]!.body.desktopClientId, posts[1]!.body.desktopClientId);
  assert.deepEqual(posts[1]!.body.result, { content: "Calculator" });
});

test("a window that loses the claim does nothing, and a failing desk reports the error as the result", async () => {
  let ran = false;
  const lost = recorder(() => Promise.reject(Object.assign(new Error("not_found"), { status: 404 })));
  await answerDesktopCall("call-2", lost.post, {
    call: async () => {
      ran = true;
      return { content: "" };
    },
  });
  assert.equal(ran, false);
  assert.equal(lost.posts.length, 1);

  const failing = recorder(() => claim);
  await answerDesktopCall("call-3", failing.post, {
    call: () => Promise.reject(new Error("Cannot identify the foreground app")),
  });
  assert.deepEqual(failing.posts[1]!.body.result, { content: "Cannot identify the foreground app", isError: true });
});

test("a stop for a call this window is running stops the desk for that run", async () => {
  const stopped: string[] = [];
  const release = Promise.withResolvers<{ content: string }>();
  const desk = { call: () => release.promise, stop: async (id: string) => stopped.push(id) };
  const answering = answerDesktopCall("call-4", recorder(() => claim).post, desk);
  await new Promise((r) => setTimeout(r, 0));
  stopDesktopCall("call-4", desk);
  release.resolve({ content: "stopped" });
  await answering;
  stopDesktopCall("call-4", desk);
  assert.deepEqual(stopped, [claim.runId]);
});
