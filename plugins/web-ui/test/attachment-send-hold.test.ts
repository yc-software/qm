import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Agent } from "@earendil-works/pi-agent-core";
import { makeCoreStreamFn } from "../src/core-bridge.ts";

const MODEL = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;

interface StreamOutcome {
  stopReason?: string;
  errorMessage?: string;
  sendFailed?: string;
  droppedAttachmentIds?: string[];
}

function agentWith(attachments: Array<{ id: string; fileName: string; size: number; content: string }>): Agent {
  return {
    state: {
      model: MODEL,
      messages: [
        {
          role: "user-with-attachments",
          content: [{ type: "text", text: "here is the demo video" }],
          attachments: attachments.map((a) => ({ ...a, type: "document", mimeType: "video/mp4" })),
        },
      ],
      isStreaming: false,
    },
  } as unknown as Agent;
}

function stub(blobStatus: number): { turns: number } {
  const seen = { turns: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/blobs")) {
      return new Response(JSON.stringify({ error: "bad_gateway" }), { status: blobStatus });
    }
    if (url.endsWith("/api/turn") && init?.method === "POST") {
      seen.turns++;
      return new Response(JSON.stringify({ status: "completed", reply: "ok" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return seen;
}

async function drive(agent: Agent): Promise<StreamOutcome> {
  const streamFn = makeCoreStreamFn("web:u:t", agent) as unknown as (
    model: Model<Api>,
    context: unknown,
  ) => { result(): Promise<StreamOutcome> };
  return streamFn(MODEL, { messages: [] }).result();
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a transient attachment upload failure holds the message instead of sending it text-only", async () => {
  const seen = stub(502);
  const outcome = await drive(agentWith([{ id: "v1", fileName: "demo.mp4", size: 3, content: "YWJj" }]));
  assert.equal(seen.turns, 0, "no turn goes out without the file the user attached");
  assert.equal(outcome.stopReason, "error");
  assert.equal(outcome.sendFailed, "attachments", "the composer restores the draft and the file for a retry");
  assert.deepEqual(outcome.droppedAttachmentIds, [], "the file is retryable, not dropped");
  assert.match(outcome.errorMessage ?? "", /"demo\.mp4" couldn't be uploaded/);
});

test("a permanently rejected attachment still lets the text go, with the file noted as left out", async () => {
  const seen = stub(413);
  await drive(agentWith([{ id: "v1", fileName: "huge.mp4", size: 3, content: "YWJj" }]));
  assert.equal(seen.turns, 1, "an over-limit file can never succeed, so the text is sent without it");
});
