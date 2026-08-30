import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createPiHarness } from "../src/harness/pi-harness.ts";
import { forModelContext } from "../src/harness/context-compaction.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import type { HarnessLlmRequestRecord, HarnessTurnInput } from "../src/harness/harness.ts";
import type { NewTapeRecord } from "../src/sessions/session-store.ts";
import type { ScopeId, Session, SessionEntry } from "../src/types.ts";

test("Pi keeps a hidden continuation in the active provider request only", async (t) => {
  const providerRequests: string[] = [];
  const provider = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      providerRequests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: {
            id: `msg_${providerRequests.length}`,
            type: "message",
            role: "assistant",
            model: "ephemeral-private-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Continuation processed." } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: "message_stop" },
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  t.after(() => setCustomProviders([]));
  const baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  setCustomProviders([
    {
      id: "ephemeral-test",
      name: "Ephemeral Test",
      protocol: "anthropic",
      baseUrl,
      models: [{ id: "ephemeral-private-model", name: "Ephemeral Private Model" }],
    },
  ]);
  const harness = createPiHarness({
    modelId: "ephemeral-private-model",
    resolveProviderKeys: async () => ({ "ephemeral-test": "test-key" }),
  });
  const scope = "org:test" as ScopeId;
  const session = { id: "pi-private-session" } as Session;
  const entries: SessionEntry[] = [];
  const tape: NewTapeRecord[] = [];
  const captures: HarnessLlmRequestRecord[] = [];
  const continuation = {
    approvalId: "approval-1",
    approvalVersion: 2,
    bindingId: "binding-1",
    recipient: "private-recipient@example.com",
    subject: "Private subject",
    body: "Private body",
  };
  const run = (input: string, includeContinuation = false) =>
    harness.turns.runTurn({
      session,
      input,
      ...(includeContinuation
        ? { continuationInstruction: { kind: "message_approval", value: continuation, hidden: true } as const }
        : {}),
      systemPrompt: "be concise",
      history: forModelContext(entries),
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: scope,
      orgScopeId: scope,
      emit: async (entry) => {
        const saved = {
          ...entry,
          sessionId: session.id,
          seq: entries.length + 1,
          createdAt: Date.now(),
        } as SessionEntry;
        entries.push(saved);
        return saved;
      },
      tape: async (record) => void tape.push(record),
      recordModelCall: () => {},
      recordLlmRequest: async (record) => void captures.push(record),
    });

  await run("", true);
  assert.match(providerRequests[0]!, /private-recipient@example\.com|Private subject|Private body/);
  const request = JSON.parse(providerRequests[0]!) as { tools?: Array<{ name?: string }> };
  assert.equal(request.tools?.some((tool) => /task|agent|subagent|delegat/i.test(tool.name ?? "")) ?? false, false);
  assert.doesNotMatch(
    JSON.stringify({ entries, tape, captures }),
    /private-recipient@example\.com|Private subject|Private body/,
  );
  const providerTape = tape.filter((record) => record.kind === "message" || record.kind === "context_event");
  assert.ok(providerTape.length > 0);
  assert.equal(
    providerTape.every((record) => record.meta?.hidden === true),
    true,
  );
  assert.equal(
    providerTape.every((record) => JSON.stringify(record.payload) === '{"omitted":true}'),
    true,
  );
  assert.equal(
    captures.every((record) => JSON.stringify(record.promptEnvelope) === '{"omitted":true}'),
    true,
  );

  await run("What happened later?");
  assert.doesNotMatch(providerRequests.at(-1)!, /private-recipient@example\.com|Private subject|Private body/);
  assert.equal(
    tape.some((record) => record.meta?.hidden !== true),
    true,
  );
});
