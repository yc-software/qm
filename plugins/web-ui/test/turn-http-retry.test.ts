import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { makeCoreStreamFn, userSendMessage } from "../src/core-bridge.ts";

const model = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;

test("a server failure retains a retry action and reuses the original input", async (t) => {
  const attachment = {
    id: "note",
    type: "document",
    fileName: "note.txt",
    mimeType: "text/plain",
    size: 4,
    content: "bm90ZQ==",
  };
  const input = userSendMessage("Read this note", [attachment]);
  const agent = new Agent({ initialState: { model, messages: [input] } });
  const submissions: Array<{ idempotencyKey: string; text: string; attachments: unknown[] }> = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/api/blobs")) return Response.json({ blobId: "note-blob", sizeBytes: 4 });
    assert.ok(String(url).endsWith("/api/turn"));
    submissions.push(JSON.parse(String(init?.body)));
    return submissions.length === 1
      ? Response.json({ error: "temporarily unavailable" }, { status: 503 })
      : Response.json({ reply: "Read successfully" });
  });
  agent.streamFn = makeCoreStreamFn("web:user:retry", agent);
  await agent.continue();
  const failed = agent.state.messages.at(-1) as unknown as { retryableSend?: boolean; stopReason?: string };
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.retryableSend, true);
  assert.match((input as unknown as { sendFailure: string }).sendFailure, /try again/i);
  assert.deepEqual((input as unknown as { attachments: unknown[] }).attachments, [attachment]);
  agent.state.messages.pop();
  await agent.continue();
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions[1], submissions[0]);
  assert.ok(submissions[0]?.idempotencyKey);
  assert.equal(agent.state.messages.at(-1)?.role, "assistant");
  assert.deepEqual((agent.state.messages.at(-1) as unknown as { content: unknown }).content, [
    { type: "text", text: "Read successfully" },
  ]);
});

test("a definitive refusal does not offer a retry", async (t) => {
  const input = userSendMessage("Test message");
  const agent = new Agent({ initialState: { model, messages: [input] } });
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "request refused" }, { status: 403 }));
  agent.streamFn = makeCoreStreamFn("web:user:refused", agent);
  await agent.continue();
  const failed = agent.state.messages.at(-1) as unknown as { retryableSend?: boolean; errorMessage?: string };
  assert.equal(failed.retryableSend, undefined);
  assert.equal(failed.errorMessage, "request refused");
  assert.equal((input as unknown as { sendFailure?: string }).sendFailure, undefined);
});
