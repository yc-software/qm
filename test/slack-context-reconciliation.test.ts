import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

function reply(): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-test",
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Acknowledged." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

for (const warm of [false, true]) {
  test(`${warm ? "existing" : "fresh"} human thread includes the approval referent in the provider request and deduplicates after harness reset`, async () => {
    const built = buildApp(testConfig({ harness: "pi", anthropicApiKey: "sk-test", securityScreenBackend: "off" }));
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      return reply();
    }) as typeof fetch;
    const base: TurnRequest = {
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: {
        kind: "channel",
        threadRef: `ch:C1:${warm ? "existing" : "fresh"}`,
        channelRef: "C1",
        audience: [{ externalId: "U1" }],
      },
      origin: { kind: "human" },
      text: "go",
      envelopeWrapped: true,
    };
    try {
      if (warm) {
        assert.equal((await built.app.turn({ ...base, text: "Can you check the worker?" })).status, "ok");
      }
      const input: TurnRequest = {
        ...base,
        overheard: [
          { ts: "100.001", role: "user", name: "Alex", text: "The worker needs restarting." },
          { ts: "100.002", role: "self", text: "Shall I restart the worker?" },
          { ts: "100.003", role: "user", name: "Blair", text: "Alex, can you approve the restart above?" },
        ],
      };
      const first = await built.app.turn(input);
      assert.equal(first.status, "ok", first.reason);
      const messages = JSON.parse(requests.at(-1)!).messages as Array<{ role: string; content: unknown }>;
      const quoted = messages.filter((m) => JSON.stringify(m.content).includes("Shall I restart the worker?"));
      assert.equal(quoted.length, 1);
      assert.equal(quoted[0]!.role, "user");
      assert.match(JSON.stringify(quoted[0]!.content), /from=\\"agent\\"/);
      const requestText = JSON.stringify(messages);
      assert.match(requestText, /The worker needs restarting/);
      assert.match(requestText, /Alex, can you approve/);
      await built.runtime.stop();
      built.runtime.start();
      const second = await built.app.turn({ ...input, text: "yes, go ahead" });
      assert.equal(second.status, "ok", second.reason);
      const next = JSON.stringify(JSON.parse(requests.at(-1)!).messages);
      assert.equal(next.split("Shall I restart the worker?").length - 1, 1);
      const session = await built.app.getSession(first.sessionId!);
      const imports = session!.entries.filter(
        (e) => e.type === "user" && (e.payload as { overheard?: boolean }).overheard,
      );
      assert.equal(imports.length, 3);
      assert.equal((imports[1]!.payload as { sourceRole?: string }).sourceRole, "agent");
    } finally {
      globalThis.fetch = originalFetch;
      await built.runtime.stop();
    }
  });
}
